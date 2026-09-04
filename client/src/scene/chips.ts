import { Color, CylinderGeometry, Group, InstancedMesh, Matrix4, MeshStandardMaterial } from 'three';
import type { ClientView } from '@cursed/shared';
import { CHIP_COLOURS } from './materials.js';
import {
  CHIP,
  POT_POSITION,
  RADIUS,
  chipCountFor,
  chipPile,
  seatPoint,
  seatStation,
  stationAngle,
} from './layout.js';

/**
 * Chips.
 *
 * One `InstancedMesh` for every chip on the table — six stacks, six bets and the
 * pot — so several hundred of them cost a single draw call. This is the one
 * place in the scene where the object count could genuinely run away, and it is
 * also the easiest to solve, so it is solved up front.
 *
 * The piles are a *feeling*, not a ledger: the authoritative number is on the
 * nameplate. A chip is worth a fixed fraction of a big blind, so a stack looks
 * the same at every level, and the pile is capped at something a person could
 * plausibly have in front of them.
 */

const MAX_CHIPS = 900;

export class ChipRenderer {
  readonly group = new Group();

  #mesh: InstancedMesh;
  #matrix = new Matrix4();
  #colour = new Color();

  constructor() {
    const geometry = new CylinderGeometry(CHIP.radius, CHIP.radius, CHIP.height, 14);
    const material = new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
    this.#mesh = new InstancedMesh(geometry, material, MAX_CHIPS);
    this.#mesh.castShadow = true;
    this.#mesh.receiveShadow = true;
    this.#mesh.count = 0;
    this.group.add(this.#mesh);
  }

  apply(view: ClientView): void {
    const bigBlind = view.level?.bigBlind ?? 0;
    let index = 0;

    const place = (
      origin: { x: number; y: number; z: number },
      yaw: number,
      amount: number,
      band: number,
      max: number,
    ) => {
      const count = chipCountFor(amount, bigBlind, max);
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      for (const offset of chipPile(count)) {
        if (index >= MAX_CHIPS) return;
        this.#matrix.makeTranslation(
          origin.x + cos * offset.x - sin * offset.z,
          origin.y + offset.y,
          origin.z + sin * offset.x + cos * offset.z,
        );
        this.#mesh.setMatrixAt(index, this.#matrix);
        this.#mesh.setColorAt(index, this.#colour.set(CHIP_COLOURS[band % CHIP_COLOURS.length]!));
        index++;
      }
    };

    for (const seat of view.hand?.seats ?? []) {
      const station = seatStation(seat.seatIndex);
      // Chips sit slightly to the player's right, out of the way of the cards.
      const yaw = -stationAngle(station);
      const home = seatPoint(seat.seatIndex, RADIUS.chips);
      place(
        { x: home.x + Math.cos(yaw) * 0.13, y: home.y, z: home.z - Math.sin(yaw) * 0.13 },
        yaw,
        seat.stack,
        seat.seatIndex,
        90,
      );

      if (seat.betThisRound > 0) {
        place(seatPoint(seat.seatIndex, RADIUS.bet), yaw, seat.betThisRound, seat.seatIndex, 40);
      }
    }

    // Everything already gathered into the middle, minus what is still in front
    // of people this street.
    const streetBets = (view.hand?.seats ?? []).reduce((sum, s) => sum + s.betThisRound, 0);
    const gathered = (view.hand?.potTotal ?? 0) - streetBets;
    if (gathered > 0) place(POT_POSITION, 0, gathered, 4, 120);

    this.#mesh.count = index;
    this.#mesh.instanceMatrix.needsUpdate = true;
    if (this.#mesh.instanceColor) this.#mesh.instanceColor.needsUpdate = true;
  }
}
