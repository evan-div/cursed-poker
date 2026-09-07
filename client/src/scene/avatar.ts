import { BoxGeometry, CylinderGeometry, Group, Mesh, Vector3 } from 'three';
import { GAZE_AWAY, type GazeTarget } from '@cursed/shared';
import { MATERIALS } from './materials.js';
import {
  RADIUS,
  TABLE,
  clamp,
  facingCentreYaw,
  seatStation,
  stationPoint,
} from './layout.js';
import { buildHand, jointTowards, segment, type HandParts } from './body.js';
import { gazePoint } from './gaze.js';

/**
 * A person at the table.
 *
 * Low-poly and blocky on purpose: the horror in this game comes from behaviour,
 * not from fidelity, and a stylised body reads its own trembling far more
 * clearly than a detailed one would. What matters here is that the anatomy is
 * *complete* — head, torso, arms, hands, and five separate fingers per hand —
 * because every later phase hangs something off one of those parts.
 *
 * The local player's own head is hidden. You are inside it.
 *
 * Phase 4 gives the body two things to do, and both of them are *information*.
 * The head turns toward whatever its owner is looking at, and the torso leans in
 * as they lift their cards. Neither is decoration: an opponent who wants to know
 * whether you just re-checked your hand after that third heart landed has to be
 * watching you when you do it. Nothing here is ever announced, logged or
 * highlighted — if you were not looking, you missed it.
 */

const CLOTH = [MATERIALS.cloth, MATERIALS.clothAlt, MATERIALS.clothThird];

/** The fastest a neck turns, in radians per second. */
const MAX_HEAD_TURN_PER_SECOND = 2.6;

/** Where a head is joined to its body, in the avatar's own space. */
const NECK_PIVOT = { y: 1.1, z: 0.02 } as const;

/**
 * How far a head turns before the shoulders would have to.
 *
 * Tighter than the camera's own limits. A player may swivel their view most of
 * the way behind them, because a real person turns their whole upper body to do
 * it; a rigid blocky avatar that does the same with its neck alone looks like a
 * broken toy.
 */
const HEAD_LIMITS = {
  yaw: (72 * Math.PI) / 180,
  pitchDown: (-52 * Math.PI) / 180,
  pitchUp: (28 * Math.PI) / 180,
} as const;

export class Avatar {
  readonly group = new Group();
  readonly hands: HandParts[] = [];

  #head: Group;
  #skull!: Mesh;
  #body: Group;
  #torso: Mesh;
  #torsoRestX: number;

  #gaze: GazeTarget = GAZE_AWAY;
  #headYaw = 0;
  #headPitch = 0;
  #targetHeadYaw = 0;
  #targetHeadPitch = 0;
  #peek = 0;
  #leaningIn = 0;
  #lean = 0;

  constructor(readonly seatIndex: number) {
    const station = seatStation(seatIndex);
    const at = stationPoint(station, RADIUS.body, 0);
    this.group.position.set(at.x, 0, at.z);
    this.group.rotation.y = facingCentreYaw(station);

    const cloth = CLOTH[seatIndex % CLOTH.length]!;

    this.#body = new Group();
    this.#head = new Group();
    this.group.add(this.#body, this.#head);

    // Seated: hips on the chair, torso leaning very slightly toward the table.
    const hips = new Mesh(new BoxGeometry(0.34, 0.2, 0.28), cloth);
    hips.position.set(0, 0.5, -0.04);
    hips.castShadow = true;

    const torso = new Mesh(new BoxGeometry(0.38, 0.46, 0.24), cloth);
    torso.position.set(0, 0.82, 0.01);
    torso.rotation.x = -0.09;
    torso.castShadow = true;

    // Shoulders. Without them the head floats: a lit face over a dark torso
    // with a thin neck between reads as a severed one, which is the right
    // effect for entirely the wrong reason.
    const shoulders = new Mesh(new BoxGeometry(0.42, 0.13, 0.23), cloth);
    shoulders.position.set(0, 1.0, 0.0);
    shoulders.castShadow = true;

    this.#torso = torso;
    this.#torsoRestX = torso.rotation.x;
    this.#body.add(hips, torso, shoulders, this.#buildArm(-1, cloth), this.#buildArm(1, cloth));

    // The head group's origin IS the pivot, which has to be at the neck.
    //
    // It used to sit at the avatar's feet with the skull positioned a metre and
    // a fifth up inside it, so turning the head swung it through a metre-wide
    // arc around the floor: heads left their bodies entirely and sailed off
    // across the room. Rotating a limb about a joint means putting the joint at
    // the origin, every time.
    this.#head.position.set(0, NECK_PIVOT.y, NECK_PIVOT.z);

    const neck = new Mesh(new CylinderGeometry(0.048, 0.055, 0.09, 8), MATERIALS.skin);
    neck.position.set(0, 1.08 - NECK_PIVOT.y, 0.02 - NECK_PIVOT.z);
    const skull = new Mesh(new BoxGeometry(0.165, 0.2, 0.185), MATERIALS.skin);
    skull.position.set(0, 1.21 - NECK_PIVOT.y, 0.02 - NECK_PIVOT.z);
    skull.castShadow = true;
    this.#skull = skull;
    this.#head.add(neck, skull);
  }

  /** Hides what the player would be looking through rather than at. */
  setLocal(isLocal: boolean): void {
    this.#head.visible = !isLocal;
  }

  setPresent(present: boolean): void {
    this.group.visible = present;
  }

  /**
   * Points this body at whatever its owner is looking at.
   *
   * The target arrives as a *subject* rather than an angle — see `presence.ts`
   * for why — so the head is aimed at wherever that subject happens to be. A
   * player who has gone quiet keeps looking wherever they last looked, which is
   * its own kind of unsettling, and is exactly what the server replicated.
   */
  setGaze(target: GazeTarget): void {
    this.#gaze = target;
    const at = gazePoint(target, this.seatIndex);
    if (!at) {
      // Looking at nothing in particular. The head *stays where it is* rather
      // than swinging to some canned resting pose: `AWAY` is most of what a
      // sweeping look passes through, and snapping to a fixed spot every time
      // it did was most of why heads used to crank back and forth.
      return;
    }

    const head = this.#headWorldPosition();
    const dx = at.x - head.x;
    const dz = at.z - head.z;
    const dy = at.y - head.y;

    // A body's forward is its own +Z, the opposite convention to a camera's.
    const worldYaw = Math.atan2(dx, dz);
    this.#targetHeadYaw = clamp(
      wrapAngle(worldYaw - this.group.rotation.y),
      -HEAD_LIMITS.yaw,
      HEAD_LIMITS.yaw,
    );
    this.#targetHeadPitch = clamp(
      Math.atan2(dy, Math.hypot(dx, dz)),
      HEAD_LIMITS.pitchDown,
      HEAD_LIMITS.pitchUp,
    );
  }

  /** Where this avatar's head actually is, for tests and for aiming at it. */
  get skull(): Mesh {
    return this.#skull;
  }

  /** How far the head has turned from straight ahead, in radians. */
  get headYaw(): number {
    return this.#headYaw;
  }

  get gaze(): GazeTarget {
    return this.#gaze;
  }

  /** How far this player has their cards up, 0..1. Drives the lean, not the cards. */
  setPeek(exposure: number): void {
    this.#peek = clamp(exposure, 0, 1);
  }

  /** How far they are craning over the table to see the board, 0..1. */
  setLean(amount: number): void {
    this.#leaningIn = clamp(amount, 0, 1);
  }

  /** Eases the body toward where it is trying to be. Call once per frame. */
  update(delta: number): void {
    // Slower than a camera, and speed-limited on top. A neck has weight, and a
    // head that can cross the whole table in a frame reads as a glitch however
    // correct the angle it arrives at is.
    const ease = 1 - Math.exp(-5.5 * delta);
    const most = MAX_HEAD_TURN_PER_SECOND * delta;
    this.#headYaw += limit((this.#targetHeadYaw - this.#headYaw) * ease, most);
    this.#headPitch += limit((this.#targetHeadPitch - this.#headPitch) * ease, most);

    this.#head.rotation.order = 'YXZ';
    this.#head.rotation.y = this.#headYaw;
    this.#head.rotation.x = this.#headPitch;

    // Leaning: over your own cards while peeking, or out over the table to see
    // the board. Whichever is further — you cannot do both and be sitting up.
    // Small, because the tell is that it happens at all, and when, not how far
    // somebody bent.
    const wanted = Math.max(this.#peek, this.#leaningIn);
    this.#lean += (wanted - this.#lean) * (1 - Math.exp(-7 * delta));
    this.#torso.rotation.x = this.#torsoRestX - this.#lean * 0.16;
  }

  #headWorldPosition(): { x: number; y: number; z: number } {
    const station = seatStation(this.seatIndex);
    const at = stationPoint(station, RADIUS.body, 0);
    return { x: at.x, y: NECK_PIVOT.y, z: at.z };
  }

  /**
   * Takes a finger, permanently.
   *
   * Phase 9 calls this and never calls it back: the hand stays this way for the
   * rest of the match, which is the entire point of the sacrifice.
   */
  removeFinger(hand: 0 | 1, finger: number): void {
    const target = this.hands[hand]?.fingers[finger];
    if (target) target.visible = false;
  }

  #buildArm(side: -1 | 1, cloth: (typeof CLOTH)[number]): Group {
    const shoulderAt = new Vector3(side * 0.19, 1.0, 0.0);
    const elbowAt = new Vector3(side * 0.22, 0.87, 0.16);
    // Hands rest on the felt, a little in from the rail.
    const wristAt = new Vector3(side * 0.17, TABLE.surfaceHeight + 0.03, 0.33);

    const upper = jointTowards(shoulderAt, elbowAt);
    upper.joint.add(segment(upper.length, 0.1, 0.1, cloth));

    // The elbow rides at the end of the upper arm and inherits its rotation, so
    // the forearm's direction has to be expressed in the elbow's own space.
    const elbow = new Group();
    elbow.position.z = upper.length;
    upper.joint.add(elbow);

    const toWrist = new Vector3()
      .subVectors(wristAt, elbowAt)
      .applyQuaternion(upper.joint.quaternion.clone().invert());
    const forearm = jointTowards(new Vector3(), toWrist);
    // Sleeved, not bare. Six pairs of bare forearms lying in the one lit part
    // of the room turn the whole table the colour of skin.
    forearm.joint.add(segment(forearm.length, 0.085, 0.085, cloth));
    elbow.add(forearm.joint);

    const wrist = new Group();
    wrist.position.z = forearm.length;
    forearm.joint.add(wrist);

    // Undo everything the arm did on the way here, so the hand lies flat on the
    // table no matter what angle the arm arrived at.
    const hand = buildHand({
      material: MATERIALS.skin,
      palm: [0.085, 0.028, 0.09],
      fingerLength: 0.055,
      fingerThickness: 0.019,
    });
    const accumulated = upper.joint.quaternion.clone().multiply(forearm.joint.quaternion);
    hand.group.quaternion.copy(accumulated.invert());
    wrist.add(hand.group);

    this.hands.push(hand);
    return upper.joint;
  }
}

/** Brings an angle back into -PI..PI, so a head turns the short way round. */
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Clamps a step to a maximum magnitude, keeping its sign. */
function limit(value: number, most: number): number {
  return Math.min(Math.max(value, -most), most);
}
