import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type BufferAttribute } from 'three';
import type { Card, ClientView, PresenceFrame, SeatView } from '@cursed/shared';
import { liftAngle } from '../interaction/peek.js';
import { BACK_CELL, BLANK_CELL, cellUv, faceCell, type AtlasCell } from './card-atlas.js';
import { cardAtlasTexture } from './card-texture.js';
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
 * Peeking works the same way, which is what makes it safe. Every seat's cards
 * lift by that seat's replicated exposure, so the *gesture* is public and
 * everyone can see who is looking at their hand and how hard. What lifts toward
 * an opponent's eyes is a card with no face on it, because their client has no
 * face to put there. There is nothing to hide, so nothing can be uncovered.
 */

const FACE = 4; // +Z, which points up once the card is laid flat
const BACK = 5; // -Z

let sharedMaterial: MeshStandardMaterial | null = null;

function material(): MeshStandardMaterial {
  sharedMaterial ??= new MeshStandardMaterial({
    map: cardAtlasTexture(),
    roughness: 0.62,
    metalness: 0,
  });
  return sharedMaterial;
}

/** Text lying flat on the table reads correctly from this station. */
export function readableFromYaw(station: number): number {
  return Math.PI - stationAngle(station);
}

function setFaceUv(geometry: BoxGeometry, face: number, cell: AtlasCell): void {
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  const rect = cellUv(cell);
  const base = face * 4;
  // BoxGeometry lays each face out as top-left, top-right, bottom-left, bottom-right.
  uv.setXY(base + 0, rect.uMin, rect.vMax);
  uv.setXY(base + 1, rect.uMax, rect.vMax);
  uv.setXY(base + 2, rect.uMin, rect.vMin);
  uv.setXY(base + 3, rect.uMax, rect.vMin);
  uv.needsUpdate = true;
}

function makeCardMesh(): Mesh {
  const geometry = new BoxGeometry(CARD.width, CARD.height, CARD.thickness);
  // Every edge is plain card stock until told otherwise.
  for (let face = 0; face < 6; face++) setFaceUv(geometry, face, BLANK_CELL);
  setFaceUv(geometry, BACK, BACK_CELL);
  const mesh = new Mesh(geometry, material());
  mesh.castShadow = true;
  mesh.rotation.order = 'YXZ';
  mesh.rotation.x = -Math.PI / 2; // lay it flat, face up
  return mesh;
}

function showCard(mesh: Mesh, card: Card | null): void {
  const geometry = mesh.geometry as BoxGeometry;
  setFaceUv(geometry, FACE, card === null ? BACK_CELL : faceCell(card));
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
 * Where a card is once its owner has started lifting it.
 *
 * The card pivots on its *near* edge and raises its far edge, which is how
 * somebody props a card against the felt to read it: the printed face turns
 * toward the person holding it and away from everybody else. Not that it would
 * matter if it did not — an opponent's client has no face to turn.
 *
 * Pure geometry, so "which way does a lifted card point?" is a property with a
 * test rather than something that looks about right in a screenshot. The two
 * cards are staggered: the near one leads, so a small lift shows one rank rather
 * than half of each.
 */
export function holeCardPose(
  seatIndex: number,
  cardIndex: number,
  exposure: number,
): { position: Vec3; rotationX: number; rotationY: number } {
  const rest = holeCardRest(seatIndex, cardIndex);
  const own = clamp01(exposure * (cardIndex === 0 ? 1.12 : 0.88));
  const lift = liftAngle(own);

  // The direction "away from the middle of the table", for this seat.
  const angle = stationAngle(seatStation(seatIndex));
  const half = CARD.height / 2;
  const slide = half * (1 - Math.cos(lift));

  return {
    position: {
      x: rest.x + Math.sin(angle) * slide,
      y: rest.y + Math.sin(lift) * half,
      z: rest.z - Math.cos(angle) * slide,
    },
    rotationX: -Math.PI / 2 + lift,
    rotationY: readableFromYaw(seatStation(seatIndex)),
  };
}

export class CardRenderer {
  readonly group = new Group();

  #board: Mesh[] = [];
  #hole = new Map<number, Mesh[]>();
  #poses = new Map<number, HolePose>();
  #localSeat: number | null = null;
  #localPeek = 0;

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
  setLocalPeek(seatIndex: number | null, exposure: number): void {
    this.#localSeat = seatIndex;
    this.#localPeek = exposure;
  }

  /** Everyone else's hands, from the presence broadcast. */
  applyPresence(frame: PresenceFrame): void {
    for (const seat of frame.seats) this.#poses.set(seat.seatIndex, { peek: seat.peek });
  }

  apply(view: ClientView): void {
    const board = view.hand?.board ?? [];
    this.#board.forEach((mesh, index) => {
      const card = board[index];
      mesh.visible = card !== undefined;
      if (card !== undefined) showCard(mesh, card);
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
      meshes.forEach((mesh, index) => {
        mesh.visible = seat.inHand && !seat.folded;
        showCard(mesh, faces[index] ?? null);
      });
    }
  }

  /**
   * Puts every seat's cards where its hands are putting them.
   *
   * Called every frame rather than on every view, because a peek is a
   * continuous movement and the view only changes when poker does. All the
   * geometry lives in `holeCardPose`; this just applies it.
   */
  updatePoses(): void {
    for (const [seatIndex, meshes] of this.#hole) {
      const exposure =
        seatIndex === this.#localSeat ? this.#localPeek : (this.#poses.get(seatIndex)?.peek ?? 0);

      meshes.forEach((mesh, index) => {
        const pose = holeCardPose(seatIndex, index, exposure);
        mesh.position.set(pose.position.x, pose.position.y, pose.position.z);
        mesh.rotation.x = pose.rotationX;
        mesh.rotation.y = pose.rotationY;
      });
    }
  }

  #holeCardsFor(seatIndex: number): Mesh[] {
    const existing = this.#hole.get(seatIndex);
    if (existing) return existing;

    const meshes: Mesh[] = [];
    for (let index = 0; index < 2; index++) {
      const mesh = makeCardMesh();
      const pose = holeCardPose(seatIndex, index, 0);
      mesh.position.set(pose.position.x, pose.position.y, pose.position.z);
      mesh.rotation.x = pose.rotationX;
      mesh.rotation.y = pose.rotationY;
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
