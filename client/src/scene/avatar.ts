import {
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
import { roundedBox } from './shapes.js';
import { gazePoint } from './gaze.js';
import { gripPose, shieldPose, type Grip } from './hold.js';
import { solveArm } from './ik.js';
import { STILL_MOTION, type Offset, type TellMotion } from './tells.js';

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
 *
 * Phase 6 gives it a nervous system. Hands that will not hold still on the
 * felt, cards that tremble when they are held up, shoulders rising faster than
 * they should, a face starting to shine. All of it is driven by the three
 * coarse tells the server broadcasts and nothing else — see `tells.ts` — and
 * all of it is equally quiet: a tell is something you notice, not something
 * you are shown.
 */

const CLOTH = [MATERIALS.cloth, MATERIALS.clothAlt, MATERIALS.clothThird];

/**
 * What sweat does to skin.
 *
 * Mostly shine: dry skin is nearly matte, and wet skin throws back the lamp.
 * A little flush as well, because a face does not go wet and stay the same
 * colour. Both are subtle in a dark room, which is right — the beads of sweat
 * that appear at the very end are what somebody actually notices.
 */
const SWEAT_SKIN = {
  roughness: { dry: 0.88, soaked: 0.3 },
  flush: new Color('#8f5a49'),
  /** How much of the way to that colour a soaked face goes. */
  flushAmount: 0.45,
  /** Beads appear past this much sweat, and are full size at one. */
  beadsFrom: 0.72,
} as const;

/** Where beads of sweat sit on a skull, in the skull's own space. Front is +Z. */
const BEADS: readonly [number, number, number][] = [
  // The brow, low enough to be on the flat of the face rather than on the
  // rounded edge where it turns away from the light.
  [-0.042, 0.038, 0.096],
  [-0.008, 0.046, 0.097],
  [0.03, 0.034, 0.096],
  [0.052, 0.05, 0.095],
  // Temples, which catch the lamp from the side.
  [-0.084, 0.018, 0.07],
  [0.085, 0.006, 0.066],
  // One on its way down.
  [-0.06, -0.012, 0.095],
];

/** The fastest a neck turns, in radians per second. */
const MAX_HEAD_TURN_PER_SECOND = 2.6;

/** Where a head is joined to its body, in the avatar's own space. */
const NECK_PIVOT = { y: 1.1, z: 0.02 } as const;

/**
 * Which arm is which.
 *
 * A body facing its own +Z with +Y up has its right hand on -X, which is the
 * arm built with `side = -1`. It is the one that reaches for the cards, because
 * the peel's leading corner is on the player's right.
 */
const RIGHT = 0;
const LEFT = 1;

/**
 * Which way an elbow breaks: down and out, away from the ribs.
 *
 * Without a pole the joint is free to spin about the shoulder-to-wrist axis, and
 * an arm reaching for a card would pick a different elbow every frame.
 */
const ELBOW_POLE = new Vector3(0, -0.85, -0.5).normalize();

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

/** Everything needed to re-aim one arm after it has been built. */
interface ArmChain {
  /** Where the shoulder is this frame: it rises with each breath. */
  shoulder: Vector3;
  shoulderRest: Vector3;
  upper: Group;
  upperLength: number;
  elbow: Group;
  forearm: Group;
  forearmLength: number;
  hand: HandParts;
  /** Where this hand rests when it is not doing anything. */
  restAt: Vector3;
}

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
  #lift = 0;
  #arms: ArmChain[] = [];
  #reach = 0;
  #shield = 0;
  #curl = 0;
  #target = new Vector3();
  #offset = new Vector3();
  #basis = new Matrix4();
  #handTurn = new Quaternion();
  #rest = new Quaternion();
  /** This body's own skin, because only this body is sweating. */
  #skin: MeshStandardMaterial;
  #skinBase: Color;
  #shownSweat = -1;
  #beads: Mesh;
  #shoulders: Mesh;
  #shouldersRestY: number;
  #tells: TellMotion = STILL_MOTION;
  #handShift = new Vector3();

  constructor(readonly seatIndex: number) {
    const station = seatStation(seatIndex);
    const at = stationPoint(station, RADIUS.body, 0);
    this.group.position.set(at.x, 0, at.z);
    this.group.rotation.y = facingCentreYaw(station);

    const cloth = CLOTH[seatIndex % CLOTH.length]!;
    // A clone per body, so one player's sweat is not everybody's. Same shader,
    // so it costs uniforms rather than a program.
    this.#skin = MATERIALS.skin.clone();
    this.#skinBase = this.#skin.color.clone();

    this.#body = new Group();
    this.#head = new Group();
    this.group.add(this.#body, this.#head);

    // Seated: hips on the chair, torso leaning very slightly toward the table.
    const hips = new Mesh(roundedBox(0.34, 0.2, 0.28), cloth);
    hips.position.set(0, 0.5, -0.04);
    hips.castShadow = true;

    const torso = new Mesh(roundedBox(0.38, 0.46, 0.24), cloth);
    torso.position.set(0, 0.82, 0.01);
    torso.rotation.x = -0.09;
    torso.castShadow = true;

    // Shoulders. Without them the head floats: a lit face over a dark torso
    // with a thin neck between reads as a severed one, which is the right
    // effect for entirely the wrong reason.
    const shoulders = new Mesh(roundedBox(0.42, 0.13, 0.23), cloth);
    shoulders.position.set(0, 1.0, 0.0);
    shoulders.castShadow = true;

    this.#torso = torso;
    this.#torsoRestX = torso.rotation.x;
    this.#shoulders = shoulders;
    this.#shouldersRestY = shoulders.position.y;
    this.#body.add(hips, torso, shoulders, this.#buildArm(-1, cloth), this.#buildArm(1, cloth));

    // The head group's origin IS the pivot, which has to be at the neck.
    //
    // It used to sit at the avatar's feet with the skull positioned a metre and
    // a fifth up inside it, so turning the head swung it through a metre-wide
    // arc around the floor: heads left their bodies entirely and sailed off
    // across the room. Rotating a limb about a joint means putting the joint at
    // the origin, every time.
    this.#head.position.set(0, NECK_PIVOT.y, NECK_PIVOT.z);

    const neck = new Mesh(new CylinderGeometry(0.048, 0.055, 0.09, 8), this.#skin);
    neck.position.set(0, 1.08 - NECK_PIVOT.y, 0.02 - NECK_PIVOT.z);
    // A head, and specifically not an ellipsoid.
    //
    // A squashed sphere is the obvious way to round off a cube of a head and it
    // is wrong, because a sphere tapers to a point at its bottom pole. The jaw
    // narrows to nothing right where it meets the neck, so the lower quarter of
    // the head reads as *more neck* — and with only four and a half centimetres
    // of neck actually showing, that trebles it. Every player at the table
    // turned into a lollipop on a stalk. A rounded box keeps its width down to
    // the jaw, which is the whole job.
    const skull = new Mesh(roundedBox(0.165, 0.2, 0.185), this.#skin);
    skull.position.set(0, 1.21 - NECK_PIVOT.y, 0.02 - NECK_PIVOT.z);
    skull.castShadow = true;
    this.#skull = skull;

    // One mesh for every bead, so a soaked player costs one draw call and a
    // dry one costs none.
    this.#beads = new Mesh(
      mergeGeometries(
        BEADS.map(([x, y, z]) => new SphereGeometry(0.007, 6, 4).scale(1, 1.3, 0.7).translate(x, y, z)),
      )!,
      MATERIALS.sweat,
    );
    this.#beads.visible = false;
    skull.add(this.#beads);
    this.#head.add(neck, skull);
  }

  /**
   * What this body is giving away this frame.
   *
   * Read from `TableTells`, which the cards read too: the hand and the pair it
   * is holding have to shake together, or one of them is lying.
   */
  setTells(motion: TellMotion): void {
    this.#tells = motion;
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

  /**
   * How this player is handling their cards.
   *
   * `exposure` is the curl of a corner under a fingertip; `lift` is the pair
   * coming off the table altogether. Both move the same hand — the right one —
   * because both are the same hand doing more of the same thing.
   */
  setPeek(exposure: number, lift = 0): void {
    this.#peek = clamp(exposure, 0, 1);
    this.#lift = clamp(lift, 0, 1);
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

    const tells = this.#tells;
    this.#head.rotation.order = 'YXZ';
    this.#head.rotation.y = this.#headYaw + tells.head.yaw;
    this.#head.rotation.x = this.#headPitch + tells.head.pitch;

    // A breath lifts the shoulders and the head on them, and the chest swells
    // a little. The arms ride up with the shoulders and the hands stay where
    // they are — the IK below starts from wherever the shoulder is now.
    this.#head.position.y = NECK_PIVOT.y + tells.breath;
    this.#shoulders.position.y = this.#shouldersRestY + tells.breath;
    this.#torso.scale.set(1 + tells.breath * 1.2, 1 + tells.breath * 1.6, 1 + tells.breath * 2.4);
    for (const arm of this.#arms) {
      arm.upper.position.y = arm.shoulderRest.y + tells.breath;
      arm.shoulder.y = arm.shoulderRest.y + tells.breath;
    }
    this.#applySweat(tells.sweat);

    // Leaning: over your own cards while peeking, or out over the table to see
    // the board. Whichever is further — you cannot do both and be sitting up.
    // Small, because the tell is that it happens at all, and when, not how far
    // somebody bent.
    const wanted = Math.max(this.#peek, this.#leaningIn);
    this.#lean += (wanted - this.#lean) * (1 - Math.exp(-7 * delta));
    this.#torso.rotation.x = this.#torsoRestX - this.#lean * 0.16;

    this.#updateHands(delta);
  }

  /**
   * Puts the right hand on the cards, and keeps it there while they move.
   *
   * The cards used to float: they rose off the table on their own while both
   * hands stayed flat on the felt, which read as a séance rather than a card
   * game. Then they were held, but *badly* — the hand went to a point worked out
   * on the card's flat frame, so a pair standing up in front of somebody's face
   * had fingers under its middle and looked balanced there. Now the grip is a
   * point on the card's own surface and the hand is turned to match the card it
   * is holding; see `hold.ts`. The elbow is solved for rather than authored —
   * see `ik.ts`.
   */
  #updateHands(delta: number): void {
    const ease = 1 - Math.exp(-8 * delta);
    this.#reachRight(this.#arms[RIGHT], ease);
    this.#shieldLeft(this.#arms[LEFT], ease);
  }

  /** The off hand, cupped against the far side of a raised pair. */
  #shieldLeft(arm: ArmChain | undefined, ease: number): void {
    if (!arm) return;
    this.#shield += (this.#lift - this.#shield) * ease;

    if (this.#shield < 1e-3) {
      this.#relax(arm);
      return;
    }

    const grip = shieldPose(this.seatIndex, this.#lift);
    this.#placeHand(arm, grip, this.#shield);
    arm.hand.shape(this.#shield * 0.5, this.#shield * 0.4);
  }

  #reachRight(arm: ArmChain | undefined, ease: number): void {
    if (!arm) return;

    // The hand commits to the cards a little ahead of the fingers closing, so
    // it arrives before it starts to pull rather than dragging them from afar.
    const wanted = Math.min(1, Math.max(this.#peek * 1.6, this.#lift));
    this.#reach += (wanted - this.#reach) * ease;
    this.#curl += (Math.max(this.#peek, this.#lift) - this.#curl) * ease;

    if (this.#reach < 1e-3) {
      this.#relax(arm);
      return;
    }

    const grip = gripPose(this.seatIndex, this.#peek, this.#lift);
    this.#placeHand(arm, grip, this.#reach);

    // Pressing a corner down is the whole hand folding; holding the pair up is
    // the fingers behind it and the thumb across the front. One becomes the
    // other as the cards leave the table.
    const pressing = this.#curl * 0.8;
    // A hand's own resting shape, and no more. Fingers hooked into a claw put
    // their knuckles out in front of the cards; fingers lying flat along the
    // backs put nothing in the way.
    const holding = 0;
    arm.hand.shape(
      pressing + (holding - pressing) * grip.raise,
      grip.raise * this.#reach,
    );
  }

  /** Lets an arm hang where it was built to, hand open — and shaking, if it is. */
  #relax(arm: ArmChain): void {
    this.#target.copy(arm.restAt).add(this.#shift(this.#handOffset(arm), 1));
    this.#aimArm(arm, this.#target, this.#rest.identity());
    arm.hand.shape(0, 0);
  }

  #handOffset(arm: ArmChain): Offset {
    return this.#tells.hands[this.#arms.indexOf(arm) === RIGHT ? 0 : 1];
  }

  /**
   * A world-space tremor, turned into this body's own space and scaled.
   *
   * Tremor offsets are world vectors so the cards, which live in world space,
   * can take the identical push.
   */
  #shift(offset: Offset, scale: number): Vector3 {
    const yaw = -this.group.rotation.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return this.#handShift.set(
      (offset.x * c + offset.z * s) * scale,
      offset.y * scale,
      (-offset.x * s + offset.z * c) * scale,
    );
  }

  /** Shine, flush and finally beads. Only touches the material when it moved. */
  #applySweat(sweat: number): void {
    if (Math.abs(sweat - this.#shownSweat) < 0.004) return;
    this.#shownSweat = sweat;
    this.#skin.roughness =
      SWEAT_SKIN.roughness.dry + (SWEAT_SKIN.roughness.soaked - SWEAT_SKIN.roughness.dry) * sweat;
    this.#skin.color.copy(this.#skinBase).lerp(SWEAT_SKIN.flush, sweat * SWEAT_SKIN.flushAmount);

    const beads = (sweat - SWEAT_SKIN.beadsFrom) / (1 - SWEAT_SKIN.beadsFrom);
    this.#beads.visible = beads > 0;
    if (beads > 0) this.#beads.scale.setScalar(0.4 + 0.6 * Math.min(beads, 1));
  }

  /** How shiny this body's skin is right now. For tests. */
  get skinRoughness(): number {
    return this.#skin.roughness;
  }

  /** Whether beads of sweat are showing. For tests. */
  get sweating(): boolean {
    return this.#beads.visible;
  }

  /**
   * Puts a hand on a grip: turned the right way round, and far enough back that
   * the *pinch* lands on the cards rather than the wrist.
   *
   * The wrist is not the thing being placed. What has to end up on the card is
   * the gap between the thumb and the fingertips, so the hand is oriented first
   * and the wrist is then worked backwards from where that gap sits inside it.
   * The previous version nudged the wrist by a fixed amount along whichever axis
   * seemed least bad at the time, which is how an arm ends up through a table.
   */
  #placeHand(arm: ArmChain, grip: Grip, blend: number): void {
    // Three orientations, in order: hanging at rest, angled in over a corner on
    // the felt, turned over holding the pair. The hand travels through them as
    // the arm commits to the reach and the cards come up.
    const over = grip.raise * blend;
    this.#handTurn.copy(this.#rest.identity()).slerp(PEELING, blend);
    this.#handTurn.slerp(this.#handQuaternion(grip), over);

    // Where the pinch sits inside the hand, in the hand's own axes: out at the
    // fingertips when the hand is flat and pressing, back at the base of the
    // fingers when it is holding an edge.
    this.#offset.set(
      0,
      PINCH.flat.y + (PINCH.held.y - PINCH.flat.y) * over,
      PINCH.flat.z + (PINCH.held.z - PINCH.flat.z) * over,
    );
    this.#offset.applyQuaternion(this.#handTurn);

    this.#target.set(grip.at.x, grip.at.y, grip.at.z);
    this.group.worldToLocal(this.#target);
    this.#target.sub(this.#offset);
    this.#target.lerpVectors(arm.restAt, this.#target, blend);

    // Shaking. A hand holding raised cards takes their push, which is larger
    // — they are a lever on it — so that the pinch stays on the card.
    const own = this.#handOffset(arm);
    const held = arm === this.#arms[RIGHT] ? this.#tells.heldCards.offset : own;
    const r = grip.raise;
    this.#target.add(
      this.#shift(
        { x: own.x + (held.x - own.x) * r, y: own.y + (held.y - own.y) * r, z: own.z + (held.z - own.z) * r },
        1,
      ),
    );

    this.#aimArm(arm, this.#target, this.#handTurn);
  }

  /**
   * The orientation a hand holding this grip has, in the body's own space.
   *
   * A hand resting on the felt already has the frame a peeling hand wants —
   * palm down, fingers pointing across the table — and that is the identity
   * rotation here, which is why only the raised frame has to be worked out and
   * why a hand that is not lifting anything never turns at all.
   */
  #handQuaternion(grip: Grip): Quaternion {
    // Fingers along the cards, back of the hand against their backs.
    HAND_Z.set(grip.along.x, grip.along.y, grip.along.z).normalize();
    HAND_Y.set(grip.up.x, grip.up.y, grip.up.z).normalize();
    HAND_X.crossVectors(HAND_Y, HAND_Z).normalize();
    // Square Y up again in case the two arrived very slightly out of true.
    HAND_Y.crossVectors(HAND_Z, HAND_X).normalize();

    this.#basis.makeBasis(HAND_X, HAND_Y, HAND_Z);
    RAISED.setFromRotationMatrix(this.#basis);
    // Into the body's space: the frame above is a world one, and the body is
    // turned to face the middle of the table.
    BODY_TURN.setFromAxisAngle(UP, -this.group.rotation.y);
    return RAISED.premultiply(BODY_TURN);
  }

  /** Solves one arm onto a wrist position and orients the hand. */
  #aimArm(arm: ArmChain, wristAt: Vector3, turn: Quaternion): void {
    const solved = solveArm(arm.shoulder, wristAt, arm.upperLength, arm.forearmLength, ELBOW_POLE);

    const toElbow = solved.elbow.clone().sub(arm.shoulder).normalize();
    arm.upper.quaternion.setFromUnitVectors(FORWARD, toElbow);

    const toWrist = solved.wrist
      .clone()
      .sub(solved.elbow)
      .applyQuaternion(arm.upper.quaternion.clone().invert())
      .normalize();
    arm.forearm.quaternion.setFromUnitVectors(FORWARD, toWrist);

    // The hand hangs off the end of all that, so undo everything the arm did on
    // the way here before applying the orientation the hand is supposed to have.
    const accumulated = arm.upper.quaternion.clone().multiply(arm.forearm.quaternion).invert();
    arm.hand.group.quaternion.copy(accumulated.multiply(turn));
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
    const elbowAt = new Vector3(side * 0.24, 0.82, 0.19);
    // Hands rest on the felt, a little in from the rail.
    //
    // Half a metre of arm, shoulder to wrist. The first pass was eight
    // centimetres shorter, which is not a proportion anybody would notice on a
    // seated body and is exactly enough to make it unable to touch its own hole
    // cards: every reach solved to a locked-straight elbow pointing at the
    // target rather than a hand arriving on it, and no amount of tuning the
    // grip fixes a hand that never gets there.
    const wristAt = new Vector3(side * 0.19, TABLE.surfaceHeight + 0.03, 0.42);

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
      material: this.#skin,
      // Two proportions worth getting right, because a hand is the part of this
      // body a player sees closest. A palm much flatter than this reads as a
      // paddle once its edges are rounded; fingers much shorter than the palm
      // read as a mitten with lines drawn on it. Real ones are about equal.
      palm: [0.078, 0.034, 0.08],
      fingerLength: 0.062,
      fingerThickness: 0.019,
      // The right arm is the one built with `side = -1`, and its thumb belongs
      // on the other side of the palm from its opposite number's.
      thumbSide: side === -1 ? 1 : -1,
    });
    const accumulated = upper.joint.quaternion.clone().multiply(forearm.joint.quaternion);
    hand.group.quaternion.copy(accumulated.invert());
    wrist.add(hand.group);

    this.hands.push(hand);
    this.#arms.push({
      shoulder: shoulderAt.clone(),
      shoulderRest: shoulderAt.clone(),
      upper: upper.joint,
      upperLength: upper.length,
      elbow,
      forearm: forearm.joint,
      forearmLength: forearm.length,
      hand,
      restAt: wristAt.clone(),
    });
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

/** A hand's own +Z, which is the way its fingers point. */
const FORWARD = new Vector3(0, 0, 1);

/**
 * Where the pinch is inside a hand, in the hand's own axes.
 *
 * Measured from the wrist, which is the hand group's origin. `flat` is out at
 * the fingertips of a hand folded over to press something down; `held` is the
 * gap at the base of the fingers where a thumb crossing the front of them meets
 * their tips, with a card's thickness of daylight between.
 */
const PINCH = {
  flat: { y: -0.056, z: 0.067 },
  held: { y: -0.020, z: 0.042 },
} as const;

/**
 * How far a peeling hand is turned in from square, in radians.
 *
 * A hand pointed straight across the table lies flat over both cards, and the
 * second one spends the whole peek underneath a palm. Coming in at an angle
 * from the player's own side puts the wrist off the edge of the pair with only
 * the thumb on the corner — which is where a hand doing this actually is, and
 * leaves the cards visible to the person peeling them.
 */
const PEELING = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6);

/** Scratch, so aiming an arm every frame does not allocate. */
const HAND_X = new Vector3();
const HAND_Y = new Vector3();
const HAND_Z = new Vector3();
const RAISED = new Quaternion();
const BODY_TURN = new Quaternion();
const UP = new Vector3(0, 1, 0);
