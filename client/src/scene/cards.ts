import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { HAND_LIFT, type Card, type ClientView, type PresenceFrame, type SeatView } from '@cursed/shared';
import { BACK_CELL, BLANK_CELL, faceCell } from './card-atlas.js';
import { TOP_FACE, UNDERSIDE, applyPeel, makeCardGeometry, setFaceCell } from './card-mesh.js';
import { cardAtlasTexture } from './card-texture.js';
import { peelAngle } from './peel.js';
import {
  CARD,
  RADIUS,
  boardCardPosition,
  seatPoint,
  seatStation,
  stationAngle,
  type Vec3,
} from './layout.js';

/**
 * Cards on the table.
 *
 * Every card shares one material and one texture; only the UVs differ, so a
 * full board plus twelve hole cards is a handful of draw calls rather than
 * seventeen material switches.
 *
 * There is no code path here that turns an unknown card into a known one. A
 * face-down card is drawn with the back cell because the client was never told
 * what it is — not because it is told and declines to show it.
 *
 * **Hole cards are dealt face down.** The top of the card is always its back;
 * the printed face is on the underside, against the felt, and the only way to
 * see it is to bend the near corner up until the underside comes round toward
 * your own eyes. Board cards are the opposite, because the Dealer turns those
 * over for everybody.
 *
 * That arrangement is the mechanic. An earlier version laid hole cards face up
 * and used tilt for legibility, which meant a player could read their hand
 * without touching it and peeking was an animation with nothing behind it.
 *
 * It is also the safer arrangement: the face is on the side of the card nobody
 * can see without its owner deliberately curling it toward themselves. Every
 * seat's cards bend by that seat's replicated exposure, so the *gesture* is
 * public — everyone sees who is looking at their hand and how hard — while what
 * curls toward an opponent's eyes is a card with no face on it, because their
 * client has no face to put there.
 */

let sharedMaterial: MeshStandardMaterial | null = null;

function material(): MeshStandardMaterial {
  if (sharedMaterial) return sharedMaterial;

  const atlas = cardAtlasTexture();
  sharedMaterial = new MeshStandardMaterial({
    map: atlas,
    roughness: 0.62,
    metalness: 0,
    /**
     * Cards carry a little of their own light.
     *
     * There is one lamp in this room and it is above the table, so the
     * underside of a curled card — which is exactly where a hole card's face is
     * printed — sits in its own shadow and reads as a black wedge. No amount of
     * peeling helps, because the surface is turning *away* from the only light
     * there is.
     *
     * The emissive map is the atlas itself, so the glow follows the ink: pale
     * card stock lifts out of the dark and the near-black back barely moves.
     * Faint enough to read as paper catching stray light rather than as a
     * screen, and it does the board a favour too — five cards in the middle of a
     * dim table were hard to make out from any seat.
     */
    emissive: 0xffffff,
    emissiveMap: atlas,
    emissiveIntensity: 0.34,
  });
  return sharedMaterial;
}

/** Text lying flat on the table reads correctly from this station. */
export function readableFromYaw(station: number): number {
  return Math.PI - stationAngle(station);
}

function makeCardMesh(): Mesh {
  const geometry = makeCardGeometry();
  // Every edge is plain card stock until told otherwise.
  for (let face = 0; face < 6; face++) setFaceCell(geometry, face, BLANK_CELL);
  const mesh = new Mesh(geometry, material());
  mesh.castShadow = true;
  mesh.rotation.order = 'YXZ';
  mesh.rotation.x = -Math.PI / 2; // lay it flat on the felt
  return mesh;
}

/** A board card: turned over by the Dealer, so its face is on top. */
function showFaceUp(mesh: Mesh, card: Card | null): void {
  const geometry = mesh.geometry as BoxGeometry;
  setFaceCell(geometry, TOP_FACE, card === null ? BACK_CELL : faceCell(card));
  setFaceCell(geometry, UNDERSIDE, BACK_CELL);
}

/**
 * A hole card: back up, face underneath.
 *
 * `card` is null for every seat but the viewer's own, in which case both sides
 * are a back — there is no face to hide because there is no face here at all.
 */
function showFaceDown(mesh: Mesh, card: Card | null): void {
  const geometry = mesh.geometry as BoxGeometry;
  setFaceCell(geometry, TOP_FACE, BACK_CELL);
  setFaceCell(geometry, UNDERSIDE, card === null ? BACK_CELL : faceCell(card));
}

/**
 * Which of a seat's hole cards this client may draw a face for.
 *
 * Pulled out of the renderer and made pure so it can be tested: this is the one
 * decision in the 3D scene with a privacy consequence, and "we never render a
 * card we were not given" should be a property with a test, not a claim in a
 * comment.
 *
 * It can only ever return cards the server already put in the view — the
 * viewer's own hand, or a showdown reveal. There is no third source, because
 * the client has no third source.
 */
export function visibleFaces(seat: SeatView, view: ClientView): (Card | null)[] {
  const own = seat.playerId === view.you.playerId ? view.you.holeCards : null;
  const faces = seat.revealedCards ?? own ?? null;
  return [faces?.[0] ?? null, faces?.[1] ?? null];
}

/** How a seat's hole cards are being handled right now. */
interface HolePose {
  /** Replicated exposure, 0..1. */
  peek: number;
  /** How far they have been picked up off the table, 0..1. */
  lift: number;
}

/**
 * Where a seat's hole cards lie when nobody is touching them.
 *
 * Pure, and shared by the renderer and its tests: the two cards sit side by side
 * across their owner's line of sight, laid out so their faces read the right way
 * up from that chair.
 */
export function holeCardRest(seatIndex: number, cardIndex: number): Vec3 {
  const centre = seatPoint(seatIndex, RADIUS.holeCards);
  const yaw = readableFromYaw(seatStation(seatIndex));
  const offset = (cardIndex - 0.5) * (CARD.width + 0.006);
  return {
    x: centre.x + Math.cos(yaw) * offset,
    y: centre.y + CARD.thickness / 2 + 0.001,
    z: centre.z - Math.sin(yaw) * offset,
  };
}

/**
 * How far a seat's cards are bent, given the exposure reported for that seat.
 *
 * The two cards do not come up together. The near one leads, which is how a
 * person actually does it, and it means a small peek shows one rank rather than
 * half of each.
 */
export function cardBend(cardIndex: number, exposure: number): number {
  return peelAngle(clamp01(exposure) * (cardIndex === 0 ? 1.12 : 0.88));
}

/**
 * Where a card sits once its owner has picked it up.
 *
 * It rises off the felt, comes back toward the chest that is holding it, and
 * tilts up to face them — which is also the reason an opponent gets nothing out
 * of it, geometry aside: their client has no face to turn.
 */
function applyHandPose(mesh: Mesh, seatIndex: number, cardIndex: number, lift: number): void {
  const rest = holeCardRest(seatIndex, cardIndex);
  // Set absolutely, never accumulated: this runs every frame, and a rotation
  // that adds to itself sixty times a second is a card in orbit.
  const flat = -Math.PI / 2;

  if (lift <= 0) {
    mesh.position.set(rest.x, rest.y, rest.z);
    mesh.rotation.x = flat;
    mesh.rotation.z = 0;
    return;
  }

  // Eased, so the cards come off the table with some weight rather than
  // snapping into the air the instant the gesture breaks through.
  const raised = lift * lift * (3 - 2 * lift);

  const angle = stationAngle(seatStation(seatIndex));
  const outward = { x: Math.sin(angle), z: -Math.cos(angle) };

  mesh.position.set(
    rest.x + outward.x * HAND_LIFT.reach * raised,
    rest.y + HAND_LIFT.height * raised,
    rest.z + outward.z * HAND_LIFT.reach * raised,
  );
  // Tipped back toward its owner, the way a hand held up to a face is. The
  // curl is still there underneath: a lifted hand is a peeked one, continued.
  mesh.rotation.x = flat - HAND_LIFT.tilt * raised;
  // Fanned very slightly apart, because two cards in one hand are never square.
  mesh.rotation.z = (cardIndex === 0 ? 1 : -1) * 0.09 * raised;
}

export class CardRenderer {
  readonly group = new Group();

  #board: Mesh[] = [];
  #hole = new Map<number, Mesh[]>();
  #poses = new Map<number, HolePose>();
  #revealed = new Map<number, boolean>();
  #bent = new Map<Mesh, number>();
  #localSeat: number | null = null;
  #localPeek = 0;
  #localLift = 0;

  constructor() {
    for (let i = 0; i < 5; i++) {
      const mesh = makeCardMesh();
      const at = boardCardPosition(i);
      mesh.position.set(at.x, at.y + CARD.thickness / 2 + 0.001, at.z);
      // The board is laid out the way the Dealer deals it.
      mesh.rotation.y = readableFromYaw(0);
      mesh.visible = false;
      this.#board.push(mesh);
      this.group.add(mesh);
    }
  }

  /**
   * The local player's own exposure, applied without waiting for the server.
   *
   * Their own hand is the one thing they should never feel latency on — the
   * card follows the mouse. Everybody else's comes back through presence at the
   * broadcast rate, which is what they would see across a table anyway.
   */
  setLocalPeek(seatIndex: number | null, exposure: number, lift = 0): void {
    this.#localSeat = seatIndex;
    this.#localPeek = exposure;
    this.#localLift = lift;
  }

  /** Everyone else's hands, from the presence broadcast. */
  applyPresence(frame: PresenceFrame): void {
    for (const seat of frame.seats) {
      this.#poses.set(seat.seatIndex, { peek: seat.peek, lift: seat.lift });
    }
  }

  apply(view: ClientView): void {
    const board = view.hand?.board ?? [];
    this.#board.forEach((mesh, index) => {
      const card = board[index];
      mesh.visible = card !== undefined;
      if (card !== undefined) showFaceUp(mesh, card);
    });

    const seats = view.hand?.seats ?? [];
    const present = new Set(seats.map((s) => s.seatIndex));
    for (const [seatIndex, meshes] of this.#hole) {
      if (present.has(seatIndex)) continue;
      for (const mesh of meshes) this.group.remove(mesh);
      this.#hole.delete(seatIndex);
    }

    for (const seat of seats) {
      const meshes = this.#holeCardsFor(seat.seatIndex);
      const faces = visibleFaces(seat, view);
      // A showdown turns cards over for the whole table; until then they lie
      // face down, and the only way to see one is to bend it.
      const revealed = seat.revealedCards !== null;
      this.#revealed.set(seat.seatIndex, revealed);

      meshes.forEach((mesh, index) => {
        mesh.visible = seat.inHand && !seat.folded;
        const card = faces[index] ?? null;
        if (revealed) showFaceUp(mesh, card);
        else showFaceDown(mesh, card);
      });
    }
  }

  /**
   * Puts every seat's cards where its owner is holding them.
   *
   * Two movements, in sequence. First the card bends: the far edge stays pinned
   * to the felt and the near corner curls up, which is a peek. Then, past a
   * full curl, the pair comes off the table entirely and up in front of their
   * owner's face, which is not a peek at all — it is somebody deciding they
   * would rather be certain than discreet.
   *
   * Called every frame rather than on every view, because both are continuous
   * movements and the view only changes when poker does. The vertex work is
   * skipped whenever a card's bend has not changed, so a table of people
   * sitting still costs nothing.
   */
  updatePoses(): void {
    for (const [seatIndex, meshes] of this.#hole) {
      // A revealed hand is lying face up on the table; nobody is holding it.
      const revealed = this.#revealed.get(seatIndex) ?? false;
      const own = seatIndex === this.#localSeat;
      const pose = this.#poses.get(seatIndex);

      const exposure = revealed ? 0 : own ? this.#localPeek : (pose?.peek ?? 0);
      const lift = revealed ? 0 : own ? this.#localLift : (pose?.lift ?? 0);

      meshes.forEach((mesh, index) => {
        const bend = cardBend(index, exposure);
        if (this.#bent.get(mesh) !== bend) {
          this.#bent.set(mesh, bend);
          applyPeel(mesh.geometry as BoxGeometry, bend);
        }
        applyHandPose(mesh, seatIndex, index, lift);
      });
    }
  }

  #holeCardsFor(seatIndex: number): Mesh[] {
    const existing = this.#hole.get(seatIndex);
    if (existing) return existing;

    const meshes: Mesh[] = [];
    for (let index = 0; index < 2; index++) {
      const mesh = makeCardMesh();
      const at = holeCardRest(seatIndex, index);
      mesh.position.set(at.x, at.y, at.z);
      mesh.rotation.y = readableFromYaw(seatStation(seatIndex));
      mesh.visible = false;
      meshes.push(mesh);
      this.group.add(mesh);
    }

    this.#hole.set(seatIndex, meshes);
    return meshes;
  }
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
