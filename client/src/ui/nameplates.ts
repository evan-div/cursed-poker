import { Vector3, type Camera } from 'three';
import type { ClientView, SeatView } from '@cursed/shared';
import { RADIUS, seatPoint } from '../scene/layout.js';
import { chips, el } from './dom.js';

/**
 * Names and stacks, floating above the people they belong to.
 *
 * DOM elements projected from world space rather than 3D text: sharp at any
 * distance, free to lay out, and no extra draw calls. They are re-positioned
 * every frame but only rebuilt when the view changes, so the per-frame cost is
 * a matrix multiply and two style writes per seat.
 */

/**
 * Chest height, not above the head.
 *
 * A seated player looks *down* at the table, so anything floating above head
 * height sits outside the frustum — the first version put the labels behind the
 * top bar, where nobody ever saw them.
 */
const PLATE_HEIGHT = 0.98;

interface Plate {
  root: HTMLElement;
  world: Vector3;
}

export class Nameplates {
  readonly root = el('div', 'nameplates');
  #plates = new Map<number, Plate>();
  #projected = new Vector3();

  /** Rebuilds the labels. Call when the view changes, not every frame. */
  update(view: ClientView): void {
    const seats = view.hand?.seats ?? [];
    const wanted = new Set(seats.map((s) => s.seatIndex));

    for (const [seatIndex, plate] of this.#plates) {
      if (!wanted.has(seatIndex)) {
        plate.root.remove();
        this.#plates.delete(seatIndex);
      }
    }

    for (const seat of seats) {
      let plate = this.#plates.get(seat.seatIndex);
      if (!plate) {
        const at = seatPoint(seat.seatIndex, RADIUS.body, PLATE_HEIGHT);
        plate = { root: el('div', 'plate'), world: new Vector3(at.x, at.y, at.z) };
        this.root.append(plate.root);
        this.#plates.set(seat.seatIndex, plate);
      }
      this.#paint(plate, seat, view);
    }
  }

  /** Moves the labels to follow the camera. Cheap; safe to call every frame. */
  project(camera: Camera, width: number, height: number): void {
    for (const plate of this.#plates.values()) {
      this.#projected.copy(plate.world).project(camera);

      // Behind the camera, or off to the side: hide rather than smear it across
      // the wrong half of the screen.
      const behind = this.#projected.z > 1;
      const offscreen = Math.abs(this.#projected.x) > 1.3 || Math.abs(this.#projected.y) > 1.3;
      plate.root.style.display = behind || offscreen ? 'none' : '';
      if (behind || offscreen) continue;

      const x = (this.#projected.x * 0.5 + 0.5) * width;
      const y = (-this.#projected.y * 0.5 + 0.5) * height;
      plate.root.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }
  }

  #paint(plate: Plate, seat: SeatView, view: ClientView): void {
    const classes = ['plate'];
    if (seat.folded) classes.push('folded');
    if (seat.allIn) classes.push('allin');
    if (!seat.connected) classes.push('away');
    if (view.hand?.actingSeat === seat.seatIndex) classes.push('acting');
    if (seat.playerId === view.you.playerId) classes.push('me');
    plate.root.className = classes.join(' ');

    plate.root.replaceChildren();
    const name = el('span', 'plate-name', seat.displayName);
    if (view.hand?.buttonSeat === seat.seatIndex) name.append(el('span', 'button-chip', 'D'));
    plate.root.append(name, el('span', 'plate-stack', chips(seat.stack)));

    if (seat.folded) plate.root.append(el('span', 'plate-state', 'folded'));
    else if (seat.allIn) plate.root.append(el('span', 'plate-state', 'all in'));
    if (!seat.connected) plate.root.append(el('span', 'plate-state warn', 'away'));
    if (seat.handCategory) {
      plate.root.append(
        el('span', 'plate-category', seat.handCategory.replaceAll('_', ' ').toLowerCase()),
      );
    }
  }
}
