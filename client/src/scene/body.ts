import { BoxGeometry, Group, Mesh, Quaternion, Vector3, type Material } from 'three';

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

/** A limb segment filling a joint's length, centred so the pivot is at the top. */
export function segment(length: number, width: number, depth: number, material: Material): Mesh {
  const mesh = new Mesh(new BoxGeometry(width, depth, length), material);
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

  const palm = new Mesh(new BoxGeometry(across, thick, along), options.material);
  palm.castShadow = true;
  group.add(palm);

  const fingers: Group[] = [];
  const geometry = new BoxGeometry(
    options.fingerThickness,
    options.fingerThickness * 0.8,
    options.fingerLength,
  );

  /** A finger hinged at its knuckle, with the bone hanging off in front. */
  const digit = (name: string, at: [number, number, number], scale: number, yaw: number): Group => {
    const knuckle = new Group();
    knuckle.name = name;
    knuckle.position.set(at[0], at[1], at[2]);
    knuckle.rotation.y = yaw;

    const bone = new Mesh(geometry, options.material);
    bone.scale.z = scale;
    bone.position.z = (options.fingerLength * scale) / 2;
    bone.castShadow = true;
    knuckle.add(bone);

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
    const closed = clamp01(close);
    const opposed = clamp01(oppose);
    for (let i = 1; i < fingers.length; i++) {
      fingers[i]!.rotation.x = closed * FULL_CURL;
    }
    // The thumb folds less than the fingers do, and swings further across the
    // palm as it is asked to oppose them.
    thumb.rotation.x = closed * FULL_CURL * 0.6 + opposed * 0.55;
    thumb.rotation.y = -side * (THUMB_YAW + opposed * 0.12);
  };

  return { group, fingers, shape, curl: (amount: number) => shape(amount, 0) };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
