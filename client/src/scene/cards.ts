import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type BufferAttribute } from 'three';
import type { Card, ClientView, SeatView } from '@cursed/shared';
import { BACK_CELL, BLANK_CELL, cellUv, faceCell, type AtlasCell } from './card-atlas.js';
import { cardAtlasTexture } from './card-texture.js';
import { CARD, RADIUS, boardCardPosition, seatPoint, seatStation, stationAngle } from './layout.js';

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

export class CardRenderer {
  readonly group = new Group();

  #board: Mesh[] = [];
  #hole = new Map<number, Mesh[]>();

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

  #holeCardsFor(seatIndex: number): Mesh[] {
    const existing = this.#hole.get(seatIndex);
    if (existing) return existing;

    const station = seatStation(seatIndex);
    const centre = seatPoint(seatIndex, RADIUS.holeCards);
    const yaw = readableFromYaw(station);
    const meshes: Mesh[] = [];

    for (let index = 0; index < 2; index++) {
      const mesh = makeCardMesh();
      // Side by side, across the player's own line of sight.
      const offset = (index - 0.5) * (CARD.width + 0.006);
      mesh.position.set(
        centre.x + Math.cos(yaw) * offset,
        centre.y + CARD.thickness / 2 + 0.001,
        centre.z - Math.sin(yaw) * offset,
      );
      mesh.rotation.y = yaw;
      mesh.visible = false;
      meshes.push(mesh);
      this.group.add(mesh);
    }

    this.#hole.set(seatIndex, meshes);
    return meshes;
  }
}
