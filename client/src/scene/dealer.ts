import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  SphereGeometry,
  Vector3,
} from 'three';
import { MATERIALS } from './materials.js';
import { DEALER_STATION, RADIUS, TABLE, facingCentreYaw, stationPoint } from './layout.js';
import { buildHand, jointTowards, segment } from './body.js';

/**
 * The Dealer.
 *
 * A placeholder, but not a neutral one: he is built taller than everyone at the
 * table, his head is a hole with two lights in it, and his hands are wrong. That
 * is enough shape for the rest of the game to be designed against. Phase 5 gives
 * him movement, which is where most of the fear is supposed to live — the
 * stillness only reads as stillness once he is capable of moving.
 *
 * He takes one of the seven stations around the ring, so he is directly across
 * the table from someone at all times.
 */
export class Dealer {
  readonly group = new Group();
  readonly eyes: Mesh[] = [];

  constructor() {
    const at = stationPoint(DEALER_STATION, RADIUS.body + 0.05, 0);
    this.group.position.set(at.x, 0, at.z);
    this.group.rotation.y = facingCentreYaw(DEALER_STATION);

    this.group.add(this.#buildRobe(), this.#buildHead(), this.#buildArm(-1), this.#buildArm(1));
  }

  #buildRobe(): Group {
    const robe = new Group();

    // A column, not a person: no legs, nothing that suggests how he stands.
    const body = new Mesh(new CylinderGeometry(0.3, 0.62, 1.5, 20, 1, true), MATERIALS.robe);
    body.position.y = 0.75;
    body.castShadow = true;

    const shoulders = new Mesh(new SphereGeometry(0.32, 16, 10), MATERIALS.robe);
    shoulders.scale.set(1, 0.42, 0.8);
    shoulders.position.y = 1.5;
    shoulders.castShadow = true;

    robe.add(body, shoulders);
    return robe;
  }

  #buildHead(): Group {
    const head = new Group();
    head.position.set(0, 1.62, 0.02);

    // The hood is a cone with the point up, so the face is a shadowed hollow
    // rather than a shape you can resolve.
    const hood = new Mesh(new CylinderGeometry(0.06, 0.23, 0.36, 18, 1, true), MATERIALS.robe);
    hood.position.y = 0.1;
    hood.castShadow = true;

    const crown = new Mesh(new SphereGeometry(0.07, 12, 8), MATERIALS.robe);
    crown.position.y = 0.28;

    // Whatever the hood contains does not take light.
    const hollow = new Mesh(new SphereGeometry(0.17, 16, 12), MATERIALS.hoodVoid);
    hollow.scale.set(1, 1, 0.75);
    hollow.position.set(0, 0.06, 0.04);

    head.add(hood, crown, hollow);

    for (const side of [-1, 1]) {
      const eye = new Mesh(new SphereGeometry(0.014, 8, 6), MATERIALS.eye);
      eye.position.set(side * 0.048, 0.07, 0.15);
      head.add(eye);
      this.eyes.push(eye);
    }
    return head;
  }

  /** Long arms, longer fingers. The proportions are the tell. */
  #buildArm(side: -1 | 1): Group {
    const shoulderAt = new Vector3(side * 0.24, 1.44, 0.0);
    const elbowAt = new Vector3(side * 0.3, 1.08, 0.18);
    const wristAt = new Vector3(side * 0.2, TABLE.surfaceHeight + 0.02, 0.36);

    const upper = jointTowards(shoulderAt, elbowAt);
    upper.joint.add(segment(upper.length, 0.1, 0.1, MATERIALS.robe));

    const elbow = new Group();
    elbow.position.z = upper.length;
    upper.joint.add(elbow);

    const toWrist = new Vector3()
      .subVectors(wristAt, elbowAt)
      .applyQuaternion(upper.joint.quaternion.clone().invert());
    const forearm = jointTowards(new Vector3(), toWrist);
    forearm.joint.add(segment(forearm.length, 0.085, 0.085, MATERIALS.robe));
    elbow.add(forearm.joint);

    const wrist = new Group();
    wrist.position.z = forearm.length;
    forearm.joint.add(wrist);

    const hand = buildHand({
      material: MATERIALS.robe,
      palm: [0.075, 0.022, 0.085],
      // Half again as long as a person's, and thinner.
      fingerLength: 0.095,
      fingerThickness: 0.014,
      splay: 0.1,
    });
    const accumulated = upper.joint.quaternion.clone().multiply(forearm.joint.quaternion);
    hand.group.quaternion.copy(accumulated.invert());
    wrist.add(hand.group);

    return upper.joint;
  }
}

/** A shallow tray in front of the Dealer. Phase 9 fills it with what he keeps. */
export function buildTrophyTray(): Mesh {
  const at = stationPoint(DEALER_STATION, 0.5);
  const tray = new Mesh(new BoxGeometry(0.24, 0.012, 0.14), MATERIALS.wood);
  tray.position.set(at.x, at.y + 0.006, at.z);
  tray.rotation.y = facingCentreYaw(DEALER_STATION);
  tray.receiveShadow = true;
  return tray;
}
