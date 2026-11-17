import { Group, Mesh, Quaternion, Vector3, type Material } from 'three';
import { bone, roundedBox } from './shapes.js';

/**
 * Shared building blocks for bodies.
 *
 * Limbs are built as a chain of nested groups rather than meshes placed in
 * space, so every joint is a real pivot that can be rotated later. Phase 3 only
 * needs them to sit still, but breathing, trembling and reaching for chips all
 * want to turn a shoulder rather than rebuild an arm.
 */

const FORWARD = new Vector3(0, 0, 1);

/** How far a knuckle folds when the hand is shut, in radians. */
const FULL_CURL = 1.35;

/**
 * How far a hand is folded when it is doing nothing at all.
 *
 * Not flat. A relaxed hand keeps a little curl in every finger; a hand with
 * none reads as a starfish pressed against the felt, and six of them around a
 * table look like the table is being held down. So `close` runs from a resting
 * hand to a closed one rather than from a splayed one, and nothing outside here
 * has to remember to ask for a hand's own default shape.
 */
const RESTING_CURL = 0.16;

/** Where a knuckle sits for a given `close`, in radians. */
function fold(close: number): number {
  return (RESTING_CURL + clamp01(close) * (1 - RESTING_CURL)) * FULL_CURL;
}

/**
 * How far the thumb is angled in across the palm, and how far down it sits.
 *
 * A thumb swung fully sideways cannot pinch anything: it has nowhere left to go
 * but further across, so closing the hand slides its tip along the palm instead
 * of bringing it toward the fingertips, and the "grip" is a card resting on the
 * knuckles with a thumb waving past it. Angling it forward as well as inward is
 * what gives the pinch an axis.
 */
const THUMB_YAW = 0.85;
const THUMB_ALONG = 0.34;
const THUMB_LENGTH = 0.85;

/**
 * How far below the palm the thumb is hinged, as a fraction of palm thickness.
 *
 * Hinging it level with the knuckles keeps its tip in the same plane as the
 * fingers, so a card pinched between them has to sit in that plane too — and
 * then the palm, which is nearly three centimetres thick, is half in front of
 * the card. The hand appears to be holding the pair *through* itself. A real
 * thumb opposes from below the fingers, which is what leaves room for something
 * to be held between them.
 */
const THUMB_DROP = 0.5;

/** A joint whose local +Z points at `to`, positioned at `from`. */
export function jointTowards(from: Vector3, to: Vector3): { joint: Group; length: number } {
  const joint = new Group();
  joint.position.copy(from);
  const direction = new Vector3().subVectors(to, from);
  const length = direction.length();
  if (length > 1e-6) {
    joint.quaternion.copy(new Quaternion().setFromUnitVectors(FORWARD, direction.normalize()));
  }
  return { joint, length };
}

/**
 * A limb segment filling a joint's length, centred so the pivot is at the top.
 *
 * `width` and `depth` describe how thick the limb is; the bone is round, so the
 * thinner of the two wins and the other is applied as a squash. An upper arm is
 * not a cylinder, but it is a great deal closer to one than to a plank.
 */
export function segment(length: number, width: number, depth: number, material: Material): Mesh {
  const thickness = Math.min(width, depth);
  const mesh = new Mesh(bone(length, thickness), material);
  mesh.scale.set(width / thickness, depth / thickness, 1);
  mesh.position.z = length / 2;
  mesh.castShadow = true;
  return mesh;
}

export interface HandOptions {
  material: Material;
  /** Palm size: across, thick, along. */
  palm: [number, number, number];
  fingerLength: number;
  fingerThickness: number;
  /** How far the fingertips splay outward, in radians. */
  splay?: number;
  /**
   * Which side of the palm the thumb is on, in the hand's own -x/+x.
   *
   * A hand model with no mirror in it is a hand model that is wrong on one side
   * of the body, and the giveaway is a thumb crossing the wrong way when the
   * hand closes on something. Defaults to the left hand's.
   */
  thumbSide?: 1 | -1;
}

export interface HandParts {
  group: Group;
  /**
   * The five digits, thumb first, each its own hinge at the knuckle.
   *
   * One object per finger is the whole point: the second sacrifice takes one,
   * and "the hand now has four fingers" has to be a property of the model for
   * the rest of the match, not a cutaway that ends when the animation does.
   * Hiding a knuckle takes its finger with it.
   *
   * They are knuckles rather than bare meshes so fingers can *curl*. A finger
   * mesh centred on its own middle rotates about its middle, which bends a
   * finger in half around a point an inch out in the air. Rotating a limb about
   * a joint means putting the joint at the origin — the same lesson the head
   * taught, one bone further out.
   */
  fingers: Group[];
  /**
   * Shapes the hand.
   *
   * `close` folds the four fingers toward the palm, 0 open .. 1 a fist.
   * `oppose` swings the thumb across the front of them, 0 alongside the hand ..
   * 1 pressed against their tips.
   *
   * Two knobs rather than one because a hand does two different jobs here, and
   * a single "how closed" number can only do the first. Pressing a corner of a
   * card down on the felt is the whole hand folding the same way. *Holding* a
   * card is the opposite: the fingers reach round behind it and the thumb comes
   * over the front, and the card is what stops them meeting. A fist has nothing
   * in it; a pinch is defined by the gap.
   */
  shape(close: number, oppose: number): void;
  /** Curls every finger toward the palm, thumb along with them. 0 flat, 1 closed. */
  curl(amount: number): void;
}

export function buildHand(options: HandOptions): HandParts {
  const group = new Group();
  const [across, thick, along] = options.palm;
  const splay = options.splay ?? 0.16;

  const palm = new Mesh(roundedBox(across, thick, along), options.material);
  palm.castShadow = true;
  group.add(palm);

  const fingers: Group[] = [];

  /** A finger hinged at its knuckle, with the bone hanging off in front. */
  const digit = (name: string, at: [number, number, number], scale: number, yaw: number): Group => {
    const knuckle = new Group();
    knuckle.name = name;
    knuckle.position.set(at[0], at[1], at[2]);
    knuckle.rotation.y = yaw;

    // Built at its own length rather than scaled to it: a capsule stretched
    // along Z gets stretched domes, and a fingertip is the one part of this
    // hand anybody ever looks at closely.
    const length = options.fingerLength * scale;
    const finger = new Mesh(bone(length, options.fingerThickness), options.material);
    finger.scale.y = 0.8;
    finger.position.z = length / 2;
    finger.castShadow = true;
    // How far out the tip is, for anything that needs to find it. Reading it off
    // the geometry means knowing what kind of solid a finger happens to be.
    finger.userData.length = length;
    knuckle.add(finger);

    group.add(knuckle);
    fingers.push(knuckle);
    return knuckle;
  };

  // Four fingers off the front edge of the palm, longest in the middle.
  const lengths = [1, 1.08, 1, 0.86];
  for (let i = 0; i < 4; i++) {
    const offset = (i - 1.5) * options.fingerThickness * 1.22;
    digit(`finger-${i + 1}`, [offset, 0, along / 2], lengths[i]!, -offset * splay * 12);
  }

  // The thumb, off the side and angled in across the palm.
  const side = options.thumbSide ?? -1;
  const thumb = digit(
    'thumb',
    [
      side * (across / 2 + options.fingerThickness * 0.3),
      -thick * THUMB_DROP,
      along * THUMB_ALONG,
    ],
    THUMB_LENGTH,
    -side * THUMB_YAW,
  );
  fingers.pop();
  fingers.unshift(thumb);

  const shape = (close: number, oppose: number) => {
    const folded = fold(close);
    const opposed = clamp01(oppose);
    for (let i = 1; i < fingers.length; i++) {
      fingers[i]!.rotation.x = folded;
    }
    // The thumb folds less than the fingers do, and swings further across the
    // palm as it is asked to oppose them.
    thumb.rotation.x = folded * 0.6 + opposed * 0.55;
    thumb.rotation.y = -side * (THUMB_YAW + opposed * 0.12);
  };

  return { group, fingers, shape, curl: (amount: number) => shape(amount, 0) };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
