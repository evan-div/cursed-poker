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
  /** Curls every finger toward the palm. 0 flat, 1 closed. */
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

  // The thumb, off the side and angled in.
  const thumb = digit(
    'thumb',
    [-across / 2 - options.fingerThickness * 0.3, 0, along * 0.18],
    0.72,
    0.95,
  );
  fingers.pop();
  fingers.unshift(thumb);

  const curl = (amount: number) => {
    const closed = Math.min(Math.max(amount, 0), 1);
    fingers.forEach((finger, index) => {
      // The thumb comes in from the side and folds less than the rest.
      const reach = index === 0 ? 0.6 : 1;
      finger.rotation.x = closed * 1.35 * reach;
    });
  };

  return { group, fingers, curl };
}
