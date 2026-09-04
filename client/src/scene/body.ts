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
   * The five digits, thumb first, each its own mesh.
   *
   * One mesh per finger is the whole point: the second sacrifice takes one, and
   * "the hand now has four fingers" has to be a property of the model for the
   * rest of the match, not a cutaway that ends when the animation does. Hiding
   * a mesh is the cheapest possible way to make that permanent.
   */
  fingers: Mesh[];
}

export function buildHand(options: HandOptions): HandParts {
  const group = new Group();
  const [across, thick, along] = options.palm;
  const splay = options.splay ?? 0.16;

  const palm = new Mesh(new BoxGeometry(across, thick, along), options.material);
  palm.castShadow = true;
  group.add(palm);

  const fingers: Mesh[] = [];
  const geometry = new BoxGeometry(
    options.fingerThickness,
    options.fingerThickness * 0.8,
    options.fingerLength,
  );

  // Four fingers off the front edge of the palm, longest in the middle.
  const lengths = [1, 1.08, 1, 0.86];
  for (let i = 0; i < 4; i++) {
    const finger = new Mesh(geometry, options.material);
    finger.name = `finger-${i + 1}`;
    const offset = (i - 1.5) * options.fingerThickness * 1.22;
    finger.position.set(offset, 0, along / 2 + (options.fingerLength * lengths[i]!) / 2);
    finger.scale.z = lengths[i]!;
    finger.rotation.y = -offset * splay * 12;
    finger.castShadow = true;
    group.add(finger);
    fingers.push(finger);
  }

  // The thumb, off the side and angled in.
  const thumb = new Mesh(geometry, options.material);
  thumb.name = 'thumb';
  thumb.scale.z = 0.72;
  thumb.position.set(-across / 2 - options.fingerThickness * 0.3, 0, along * 0.18);
  thumb.rotation.y = 0.95;
  thumb.castShadow = true;
  group.add(thumb);
  fingers.unshift(thumb);

  return { group, fingers };
}
