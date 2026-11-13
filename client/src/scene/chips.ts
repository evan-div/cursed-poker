import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry as Geometry,
} from 'three';
import type { ClientView } from '@cursed/shared';
import { CHIP_COLOURS, CHIP_TRIM_COLOURS } from './materials.js';
import {
  CHIP,
  POT_POSITION,
  RADIUS,
  chipBreakdown,
  chipHeap,
  chipStacks,
  seatPoint,
  seatStation,
  stationAngle,
  type PlacedChip,
} from './layout.js';
import { fuse } from './shapes.js';
import { buttonTexture, chipSurface } from './textures.js';

/**
 * Chips.
 *
 * Every chip on the table — six stacks, six bets and the pot — is an instance of
 * one of two meshes, so several hundred of them cost two draw calls. This is the
 * one place in the scene where the object count could genuinely run away, and
 * it is also the easiest to solve, so it is solved up front.
 *
 * Two meshes rather than one because a chip is two colours. The body takes its
 * colour from the instance, which is how five denominations share one material;
 * but a tint can only ever darken a texture, so the pale spots round the edge of
 * a dark chip cannot be painted on it. They are their own sliver of geometry
 * instead, sitting a fraction of a millimetre proud of the rim.
 *
 * The piles are a *feeling*, not a ledger: the authoritative number is on the
 * nameplate. But they are an honest feeling now. See `chipBreakdown`.
 */

const MAX_CHIPS = 900;
const SIDES = 24;
/** How many spots a chip has round its edge. */
const SPOTS = 6;

/** How far the dealer button sits to its owner's left, in metres. */
const BUTTON_OFFSET = 0.15;

/**
 * A chip's body: two faces and a rim, with UVs pointed at `chipSurface`.
 *
 * The faces use the left three quarters of that canvas and the rim the strip
 * down its right-hand side.
 */
function chipBody(): Geometry {
  const face = (up: boolean): Geometry => {
    const circle = new CircleGeometry(CHIP.radius, SIDES);
    const uv = circle.getAttribute('uv') as BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.75);
    circle.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
    circle.translate(0, (up ? 1 : -1) * (CHIP.height / 2), 0);
    return circle;
  };

  const rim = new CylinderGeometry(CHIP.radius, CHIP.radius, CHIP.height, SIDES, 1, true);
  const uv = rim.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, 0.875);

  return fuse([{ geometry: face(true) }, { geometry: face(false) }, { geometry: rim }]);
}

/**
 * The spots: six slivers that wrap from the top face over the rim.
 *
 * Built by hand because nothing in the box is this shape: an arc of rim and the
 * wedge of face above it, a hair outside the body so the two never fight over
 * the same pixels.
 */
function chipSpots(): Geometry {
  const proud = 0.00012;
  const outer = CHIP.radius + proud;
  const inner = CHIP.radius * 0.8;
  const top = CHIP.height / 2 + proud;
  const bottom = -CHIP.height / 2;
  const width = (Math.PI * 2) / SPOTS / 2.6;
  const steps = 2;

  const positions: number[] = [];
  const normals: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], normal: number[] | null): void => {
    for (const corner of [a, b, c, a, c, d]) {
      positions.push(...corner);
      normals.push(...(normal ?? [corner[0]! / outer, 0, corner[2]! / outer]));
    }
  };

  for (let spot = 0; spot < SPOTS; spot++) {
    const centre = (spot / SPOTS) * Math.PI * 2;
    for (let step = 0; step < steps; step++) {
      const a0 = centre - width / 2 + (width * step) / steps;
      const a1 = centre - width / 2 + (width * (step + 1)) / steps;
      const at = (angle: number, radius: number, y: number) => [Math.sin(angle) * radius, y, Math.cos(angle) * radius];
      // Round the rim, facing outward.
      quad(at(a0, outer, bottom), at(a1, outer, bottom), at(a1, outer, top), at(a0, outer, top), null);
      // And over onto the face, facing up.
      quad(at(a0, inner, top), at(a0, outer, top), at(a1, outer, top), at(a1, inner, top), [0, 1, 0]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  return geometry;
}

export class ChipRenderer {
  readonly group = new Group();

  #bodies: InstancedMesh;
  #spots: InstancedMesh;
  #button: Mesh;
  #matrix = new Matrix4();
  #turn = new Matrix4();
  #bodyColours = CHIP_COLOURS.map((colour) => new Color(colour));
  #spotColours = CHIP_TRIM_COLOURS.map((colour) => new Color(colour));
  #dressed = false;

  constructor() {
    const body = new MeshStandardMaterial({ roughness: 0.52, metalness: 0.02 });
    this.#bodies = new InstancedMesh(chipBody(), body, MAX_CHIPS);
    this.#bodies.castShadow = true;
    this.#bodies.receiveShadow = true;

    const trim = new MeshStandardMaterial({ roughness: 0.5 });
    this.#spots = new InstancedMesh(chipSpots(), trim, MAX_CHIPS);
    this.#spots.receiveShadow = true;

    for (const mesh of [this.#bodies, this.#spots]) {
      mesh.count = 0;
      // Instances wander all over the table; the mesh's own bounds mean nothing.
      mesh.frustumCulled = false;
    }

    // The button. One of them, and it moves a seat every hand.
    this.#button = new Mesh(
      new CylinderGeometry(0.027, 0.027, 0.0065, 28),
      new MeshStandardMaterial({ color: 0xd4cab4, roughness: 0.45 }),
    );
    this.#button.castShadow = true;
    this.#button.receiveShadow = true;
    this.#button.visible = false;

    this.group.add(this.#bodies, this.#spots, this.#button);
  }

  /** Puts the painted surfaces on, the first time there are any to put. */
  #dress(): void {
    if (this.#dressed) return;
    const surface = chipSurface();
    if (!surface) return;
    this.#dressed = true;

    const body = this.#bodies.material as MeshStandardMaterial;
    body.map = surface.map;
    if (surface.bump) {
      body.bumpMap = surface.bump;
      body.bumpScale = 0.6;
    }
    body.needsUpdate = true;

    const face = buttonTexture();
    if (face) {
      const button = this.#button.material as MeshStandardMaterial;
      button.map = face;
      button.color.set(0xffffff);
      button.needsUpdate = true;
    }
  }

  apply(view: ClientView): void {
    this.#dress();
    const bigBlind = view.level?.bigBlind ?? 0;
    let index = 0;

    /** Sets a pile down at `origin`, turned to face its owner. */
    const place = (origin: { x: number; y: number; z: number }, yaw: number, chips: readonly PlacedChip[]): void => {
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      for (const chip of chips) {
        if (index >= MAX_CHIPS) return;
        this.#matrix.makeTranslation(
          origin.x + cos * chip.x - sin * chip.z,
          origin.y + chip.y,
          origin.z + sin * chip.x + cos * chip.z,
        );
        this.#matrix.multiply(this.#turn.makeRotationY(chip.turn));
        this.#bodies.setMatrixAt(index, this.#matrix);
        this.#spots.setMatrixAt(index, this.#matrix);
        this.#bodies.setColorAt(index, this.#bodyColours[chip.denomination % this.#bodyColours.length]!);
        this.#spots.setColorAt(index, this.#spotColours[chip.denomination % this.#spotColours.length]!);
        index++;
      }
    };

    const seats = view.hand?.seats ?? [];
    for (const seat of seats) {
      const station = seatStation(seat.seatIndex);
      const yaw = -stationAngle(station);
      const home = seatPoint(seat.seatIndex, RADIUS.chips);
      // Chips sit slightly to the player's right, out of the way of the cards.
      place(
        { x: home.x + Math.cos(yaw) * 0.13, y: home.y, z: home.z - Math.sin(yaw) * 0.13 },
        yaw,
        chipStacks(chipBreakdown(seat.stack, bigBlind), CHIP.perStack, 110),
      );

      if (seat.betThisRound > 0) {
        // Pushed forward in short stacks: counted out, not dumped.
        place(
          seatPoint(seat.seatIndex, RADIUS.bet),
          yaw,
          chipStacks(chipBreakdown(seat.betThisRound, bigBlind), 8, 48),
        );
      }
    }

    // Everything already gathered into the middle, minus what is still in front
    // of people this street.
    const streetBets = seats.reduce((sum, s) => sum + s.betThisRound, 0);
    const gathered = (view.hand?.potTotal ?? 0) - streetBets;
    if (gathered > 0) place(POT_POSITION, 0, chipHeap(chipBreakdown(gathered, bigBlind), 130));

    for (const mesh of [this.#bodies, this.#spots]) {
      mesh.count = index;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    this.#placeButton(view);
  }

  /** The button goes in front of whoever has it, on the side their chips are not. */
  #placeButton(view: ClientView): void {
    const seat = view.hand?.buttonSeat;
    if (seat === undefined || seat === null) {
      this.#button.visible = false;
      return;
    }
    const yaw = -stationAngle(seatStation(seat));
    const home = seatPoint(seat, RADIUS.chips + 0.02);
    this.#button.visible = true;
    this.#button.position.set(
      home.x - Math.cos(yaw) * BUTTON_OFFSET,
      home.y + 0.00325,
      home.z + Math.sin(yaw) * BUTTON_OFFSET,
    );
    // Turned so its owner reads the D the right way up.
    this.#button.rotation.y = yaw + Math.PI;
  }
}
