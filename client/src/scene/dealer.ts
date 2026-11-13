import {
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
} from 'three';
import { DEALER, GAZE_AWAY, blend, type DealerPresence, type GazeTarget } from '@cursed/shared';
import { MATERIALS } from './materials.js';
import { DEALER_STATION, RADIUS, TABLE, clamp, facingCentreYaw, stationPoint } from './layout.js';
import { buildHand, jointTowards, segment, type HandParts } from './body.js';
import { gazePoint } from './gaze.js';
import { fuse, roundedBox } from './shapes.js';

/**
 * The Dealer.
 *
 * He is built taller than anybody at the table, his face is a hole with two
 * lights in it, and his hands are wrong. None of that is what makes him work.
 * What makes him work is that he *does not move*, and that everybody watching
 * him is watching the same stillness at the same moment.
 *
 * So this file decides nothing. Where he looks, what his body is doing and when
 * he twitches all arrive from the server in a `DealerPresence` — see
 * `shared/src/dealer.ts` for why that is the load-bearing choice — and this is
 * only the part that draws it. If a client could pick his behaviour, six people
 * would be sitting in six different rooms and "did you see that?" would never
 * have an answer.
 *
 * Two things he deliberately does not have:
 *
 * - **An idle.** Players will get breathing and trembling in Phase 6. He gets
 *   nothing. A body that holds a pose to the millisecond is the whole effect,
 *   and any amount of tasteful sway would throw it away to look more polished.
 * - **A human neck.** His head turns further than a person's can, and takes its
 *   time doing it. The avatars are clamped to seventy-two degrees because a
 *   rigid body that cranks past that reads as a broken toy; he is not a body,
 *   and reading as one would be the mistake.
 */

/** How far his head turns before his shoulders would have to. */
const HEAD_LIMITS = {
  /** Most of the way behind himself. A person cannot do this. */
  yaw: (128 * Math.PI) / 180,
  pitchDown: (-40 * Math.PI) / 180,
  pitchUp: (22 * Math.PI) / 180,
} as const;

/**
 * The fastest his neck turns, in radians per second.
 *
 * Slower than a player's, which is the point. He arrives at you unhurriedly and
 * then he is simply there, and the arriving is worse than the being there.
 */
const MAX_HEAD_TURN_PER_SECOND = 1.15;

/**
 * How big he is, in metres.
 *
 * The first pass had him two metres tall and **one and a quarter metres wide at
 * the hem** — on a table whose entire playing surface is one metre thirty-two
 * across. Standing where he stands, the skirt reached a full twenty centimetres
 * *inside* the felt: he was not looming over the table, he was standing through
 * it. What that reads as, correctly, is a gigantic cone.
 *
 * The height was never really the problem. Cutting the hem almost in half is
 * what turns him back into a figure, because the thing that made him a cone was
 * the ratio between his base and his head — three and a half to one, where a
 * robed person is closer to two.
 *
 * He is still the tallest thing in the room by a long way. Seated players top
 * out at 1.31, so at 1.83 he stands half a metre over every one of them, and
 * over two metres once he decides to stand.
 */
const SIZE = {
  /** Floor to shoulder. The column. */
  robeHeight: 1.42,
  /** Radius at the shoulder, and where it pools on the floor. */
  robeTop: 0.22,
  robeHem: 0.36,
  shoulderRadius: 0.24,
  /** Where the head is hinged. */
  neck: 1.52,
  /** Half the cowl: across, tall, front to back. */
  hood: { x: 0.168, y: 0.2, z: 0.19 },
  hollowRadius: 0.12,
} as const;

/**
 * What is inside the hood.
 *
 * Not a dark material: no material. It takes no light, throws no highlight and
 * has no shape, which under a lamp this strong is the only way to get black.
 * The fog still reaches it, so it sits in the room rather than on the screen.
 */
const VOID = new MeshBasicMaterial({ color: 0x000000 });

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Where his head is hinged, in his own space. */
const NECK_PIVOT = { y: SIZE.neck, z: 0.02 } as const;

/** How much taller he gets when he stands, in metres. */
const RISE_HEIGHT = 0.3;

/**
 * How hard the two lights in the hood burn, at no dread and at full.
 *
 * The one thing about him that changes with the room rather than with what he
 * is doing, so it reads as the room getting worse rather than as him reacting.
 *
 * The numbers are large because they are measured against the lens: red is a
 * dim colour to a bloom filter, and at the start of the evening these sit under
 * its threshold — two points, and nothing round them. By the end they are far
 * over it and they flare. See `BLOOM` in `post.ts`.
 */
const EYE_GLOW = { calm: 5, dread: 95 } as const;

/** How far he bends over the felt when he leans, in radians. */
const LEAN_ANGLE = 0.3;

/** The column's height as built, which `RISEN` stretches. */
const ROBE_HEIGHT = SIZE.robeHeight;

export class Dealer {
  readonly group = new Group();
  readonly eyes: Mesh<SphereGeometry, MeshStandardMaterial>[] = [];
  readonly hands: HandParts[] = [];

  /** Everything above the hem: it is the column that stretches, not his legs. */
  #upper = new Group();
  #robe!: Mesh;
  #head = new Group();
  #arms: Group[] = [];

  #gaze: GazeTarget = GAZE_AWAY;
  #headYaw = 0;
  #headPitch = 0;
  #targetHeadYaw = 0;
  #targetHeadPitch = 0;

  #posture: DealerPresence['posture'] = 'STILL';
  #dread = 0;
  #rise = 0;
  #lean = 0;
  #deal = 0;
  #dealPhase = 0;

  /** The twitch already played, so a repeated frame does not replay it. */
  #playedTwitch: number | null = null;
  /** How far through the current twitch, 0..1, or 1 when there is none. */
  #twitch = 1;

  constructor() {
    const at = stationPoint(DEALER_STATION, RADIUS.body + 0.05, 0);
    this.group.position.set(at.x, 0, at.z);
    this.group.rotation.y = facingCentreYaw(DEALER_STATION);

    this.group.add(this.#buildRobe(), this.#upper);
    this.#upper.add(this.#buildShoulders(), this.#head, this.#buildArm(-1), this.#buildArm(1));
    this.#buildHead();
  }

  /**
   * What the server says he is doing.
   *
   * Everything visible about him comes through here. Called on every presence
   * frame — twelve times a second — while `update` runs on every rendered one,
   * because a head that snapped between twelve positions a second would look
   * like a strobe rather than a neck.
   */
  apply(presence: DealerPresence, dread: number, serverTime: number): void {
    this.#gaze = presence.gaze;
    this.#posture = presence.posture;
    this.#dread = clamp(dread, 0, 1);
    this.#aimAt(presence.gaze);

    // A twitch is a moment with a timestamp on it, so it survives a dropped
    // frame — and so a client that has just connected can tell that the one it
    // is being told about happened while nobody was here to see it.
    const at = presence.twitchAt;
    if (at !== null && at !== this.#playedTwitch && serverTime - at <= DEALER.twitchFreshMs) {
      this.#playedTwitch = at;
      this.#twitch = 0;
    }
  }

  /** Eases him toward wherever he has decided to be. Call once per frame. */
  update(delta: number): void {
    const ease = 1 - Math.exp(-4 * delta);
    const most = MAX_HEAD_TURN_PER_SECOND * delta;
    this.#headYaw += limit((this.#targetHeadYaw - this.#headYaw) * ease, most);
    this.#headPitch += limit((this.#targetHeadPitch - this.#headPitch) * ease, most);

    // A twitch is not eased. It is a sharp thing that happens to him.
    if (this.#twitch < 1) this.#twitch = Math.min(1, this.#twitch + delta / (DEALER.twitchMs / 1000));
    const jolt = twitchOffset(this.#twitch);

    this.#head.rotation.order = 'YXZ';
    this.#head.rotation.y = this.#headYaw + jolt * 0.55;
    this.#head.rotation.x = this.#headPitch - jolt * 0.22;

    // Posture. Slow, because none of it should ever look like reacting.
    const settle = 1 - Math.exp(-3 * delta);
    this.#rise += ((this.#posture === 'RISEN' ? 1 : 0) - this.#rise) * settle;
    this.#lean += ((this.#posture === 'LEANING' ? 1 : 0) - this.#lean) * settle;
    this.#deal += ((this.#posture === 'DEALING' ? 1 : 0) - this.#deal) * settle;

    this.#upper.position.y = RISE_HEIGHT * this.#rise;
    this.#upper.rotation.x = LEAN_ANGLE * this.#lean;
    // The column does not leave the floor; it grows out of it.
    this.#robe.scale.y = (ROBE_HEIGHT + RISE_HEIGHT * this.#rise) / ROBE_HEIGHT;
    this.#robe.position.y = (ROBE_HEIGHT + RISE_HEIGHT * this.#rise) / 2;

    // Working: his arms move over the felt, and only then.
    this.#dealPhase += delta * 2.4;
    const reach = Math.sin(this.#dealPhase) * 0.28 * this.#deal;
    for (const [index, arm] of this.#arms.entries()) {
      arm.rotation.x = (index === 0 ? reach : -reach * 0.7) * 0.5;
    }

    // The lights in the hood come up as the room turns.
    const glow = blend(EYE_GLOW.calm, EYE_GLOW.dread, this.#dread);
    for (const eye of this.eyes) eye.material.emissiveIntensity = glow;
  }

  /** Who he is looking at, for anything that wants to know. */
  get gaze(): GazeTarget {
    return this.#gaze;
  }

  /** Where his head actually is, so a camera or a test can find it. */
  get head(): Group {
    return this.#head;
  }

  #aimAt(target: GazeTarget): void {
    // He has no seat, so the seat-relative gaze targets cannot resolve for him.
    // Passing null says so rather than handing him somebody else's chair.
    const at = gazePoint(target, null);
    if (!at) return;

    // From where his head actually is, not from where his feet are. Two
    // centimetres of neck offset is a degree of bearing, which is small and is
    // exactly the sort of small that makes a head look subtly past you.
    const feet = stationPoint(DEALER_STATION, RADIUS.body + 0.05, 0);
    const yaw = this.group.rotation.y;
    const dx = at.x - (feet.x + Math.sin(yaw) * NECK_PIVOT.z);
    const dz = at.z - (feet.z + Math.cos(yaw) * NECK_PIVOT.z);
    const dy = at.y - (NECK_PIVOT.y + RISE_HEIGHT * this.#rise);

    const worldYaw = Math.atan2(dx, dz);
    this.#targetHeadYaw = clamp(
      wrapAngle(worldYaw - yaw),
      -HEAD_LIMITS.yaw,
      HEAD_LIMITS.yaw,
    );
    this.#targetHeadPitch = clamp(
      Math.atan2(dy, Math.hypot(dx, dz)),
      HEAD_LIMITS.pitchDown,
      HEAD_LIMITS.pitchUp,
    );
  }

  #buildRobe(): Mesh {
    // A column, not a person: no legs, nothing that suggests how he stands.
    // Turned on a lathe like the table leg, and then spoiled — heavy cloth
    // hangs in folds that deepen toward the floor, and this hem has been
    // dragged over a great many floors.
    const geometry = new LatheGeometry(
      [
        new Vector2(SIZE.robeHem, 0),
        new Vector2(SIZE.robeHem - 0.025, 0.14),
        new Vector2(0.295, 0.46),
        new Vector2(0.252, 0.9),
        new Vector2(0.226, 1.24),
        new Vector2(SIZE.robeTop, ROBE_HEIGHT),
      ],
      84,
    );
    const position = geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const radius = Math.hypot(x, z);
      const angle = Math.atan2(x, z);
      const low = Math.pow(1 - y / ROBE_HEIGHT, 1.3);
      // Whole numbers of folds, so the column closes on itself.
      const fold = (Math.sin(angle * 13 + Math.sin(angle * 3) * 1.4) * 0.022 + Math.sin(angle * 31) * 0.005) * low;
      const scale = (radius + fold) / radius;
      // The hem: torn up in places, and still on the floor in others.
      const torn = y < 1e-4 ? Math.pow(Math.max(0, Math.sin(angle * 17 + 1.1) * Math.sin(angle * 5 + 0.4)), 2) * 0.075 : 0;
      position.setXYZ(i, x * scale, y + torn, z * scale);
    }
    geometry.translate(0, -ROBE_HEIGHT / 2, 0);
    geometry.computeVertexNormals();

    const body = new Mesh(geometry, MATERIALS.robe);
    body.position.y = ROBE_HEIGHT / 2;
    body.castShadow = true;
    this.#robe = body;
    return body;
  }

  #buildShoulders(): Mesh {
    // Shoulders, and a mantle over them: a short cape that hides where the arms
    // begin, so they simply come out of him.
    const mantle = new LatheGeometry(
      [
        new Vector2(0.282, -0.31),
        new Vector2(0.288, -0.17),
        new Vector2(0.25, -0.03),
        new Vector2(0.17, 0.07),
        new Vector2(0.09, 0.125),
      ],
      56,
    );
    const position = mantle.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const radius = Math.hypot(x, z);
      const angle = Math.atan2(x, z);
      const low = smoothstep(0.1, -0.31, y);
      const fold = Math.sin(angle * 11 + 0.7) * 0.012 * low;
      const torn = y < -0.3 ? Math.pow(Math.max(0, Math.sin(angle * 7 + 2.1)), 3) * 0.05 : 0;
      const scale = (radius + fold) / radius;
      // Narrower front to back than side to side, as shoulders are.
      position.setXYZ(i, x * scale, y + torn, z * scale * 0.78);
    }
    mantle.computeVertexNormals();

    const shoulders = new Mesh(
      fuse([
        { geometry: new SphereGeometry(SIZE.shoulderRadius, 20, 12), scale: [1, 0.42, 0.8] },
        { geometry: mantle },
      ]),
      MATERIALS.robe,
    );
    shoulders.position.y = SIZE.robeHeight;
    shoulders.castShadow = true;
    return shoulders;
  }

  #buildHead(): void {
    // The head group's origin is the pivot, which has to be at the neck — the
    // lesson the avatars' heads taught by sailing off across the room.
    this.#head.position.set(0, NECK_PIVOT.y, NECK_PIVOT.z);

    // A cowl: deep, peaked at the back, its brow pulled forward over an
    // opening with nothing in it. It was a cone with the point up, and read as
    // one; this is cut from a sphere and then hung, the way a hood is.
    const hood = new Mesh(hoodGeometry(), MATERIALS.robe);
    hood.position.y = 0.07;
    hood.castShadow = true;

    // Whatever the hood contains does not take light.
    const hollow = new Mesh(new SphereGeometry(SIZE.hollowRadius, 18, 14), VOID);
    hollow.scale.set(1, 1.08, 0.7);
    hollow.position.set(0, 0.055, 0.02);

    this.#head.add(hood, hollow);

    for (const side of [-1, 1]) {
      // Their own material each, so their glow can be turned up without
      // lighting every other emissive thing in the room with it.
      const eye = new Mesh(new SphereGeometry(0.0095, 10, 8), MATERIALS.eye.clone());
      eye.position.set(side * 0.036, 0.05, 0.106);
      this.#head.add(eye);
      this.eyes.push(eye);
    }
  }

  /** Long arms, longer fingers. The proportions are the tell. */
  #buildArm(side: -1 | 1): Group {
    const shoulderAt = new Vector3(side * 0.2, SIZE.robeHeight - 0.06, 0.0);
    const elbowAt = new Vector3(side * 0.25, 1.03, 0.17);
    const wristAt = new Vector3(side * 0.17, TABLE.surfaceHeight + 0.02, 0.34);

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
    // A sleeve that opens toward the wrist, wide enough to lose a hand in.
    const sleeve = new Mesh(SLEEVE, MATERIALS.robe);
    sleeve.position.z = forearm.length - 0.075;
    sleeve.castShadow = true;
    forearm.joint.add(sleeve);
    elbow.add(forearm.joint);

    const wrist = new Group();
    wrist.position.z = forearm.length;
    forearm.joint.add(wrist);

    const hand = buildHand({
      // Not gloved, and not skin. The one pale thing about him, and it is on
      // the felt in front of everybody all evening.
      material: MATERIALS.bone,
      palm: [0.075, 0.026, 0.082],
      // Half again as long as a person's, and thinner.
      fingerLength: 0.095,
      fingerThickness: 0.014,
      splay: 0.1,
      thumbSide: side === -1 ? 1 : -1,
    });
    const accumulated = upper.joint.quaternion.clone().multiply(forearm.joint.quaternion);
    hand.group.quaternion.copy(accumulated.invert());
    wrist.add(hand.group);

    // A hand of his is never quite open and never quite closed.
    hand.shape(0.2, 0.1);
    this.hands.push(hand);

    // Wrapped, so the whole arm can be swung from the shoulder without
    // disturbing the direction the bones inside it point.
    const pivot = new Group();
    pivot.add(upper.joint);
    this.#arms.push(pivot);
    return pivot;
  }
}

/** A bell sleeve: narrow at the elbow end, open at the wrist. Runs along +Z. */
const SLEEVE = new CylinderGeometry(0.078, 0.042, 0.17, 16, 1, true).rotateX(Math.PI / 2);

let hoodCache: BufferGeometry | null = null;

/**
 * The cowl.
 *
 * A sphere, pushed: pulled up and back into a peak, drawn forward at the brow,
 * let out below the chin where it lies on his shoulders — and then opened at
 * the front, by leaving out the triangles a face would be behind.
 */
function hoodGeometry(): BufferGeometry {
  if (hoodCache) return hoodCache;

  const geometry = new SphereGeometry(1, 44, 32);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const open: boolean[] = [];
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);

    // The opening: an oval, taller than it is wide, a little below the middle.
    open.push(z > 0 && (x / 0.56) ** 2 + ((y + 0.14) / 0.56) ** 2 < 1);

    const peak = smoothstep(0.15, 1, y) * smoothstep(0.35, -0.7, z);
    const brow = Math.exp(-(((y - 0.44) / 0.3) ** 2)) * smoothstep(0, 0.8, z);
    const drape = smoothstep(-0.4, -1, y);
    position.setXYZ(
      i,
      x * SIZE.hood.x * (1 + 0.55 * drape),
      y * SIZE.hood.y + 0.07 * peak - 0.07 * drape,
      z * SIZE.hood.z * (1 + 0.4 * drape) - 0.055 * peak + 0.045 * brow,
    );
  }

  const index = geometry.getIndex()!;
  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (!(open[a] && open[b] && open[c])) kept.push(a, b, c);
  }
  geometry.setIndex(kept);
  geometry.computeVertexNormals();
  hoodCache = geometry;
  return geometry;
}

/**
 * How far through a twitch, as an angle.
 *
 * Out fast and back slower, which is what a flinch does. A symmetric curve
 * reads as a nod.
 */
function twitchOffset(progress: number): number {
  if (progress >= 1) return 0;
  const out = Math.min(progress / 0.25, 1);
  const back = progress < 0.25 ? 1 : 1 - (progress - 0.25) / 0.75;
  return out * back;
}

/** Brings an angle back into -PI..PI, so a head turns the short way round. */
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Clamps a step to a maximum magnitude, keeping its sign. */
function limit(value: number, most: number): number {
  return Math.min(Math.max(value, -most), most);
}

/** A shallow tray in front of the Dealer. Phase 9 fills it with what he keeps. */
export function buildTrophyTray(): Mesh {
  const at = stationPoint(DEALER_STATION, 0.5);
  const tray = new Mesh(roundedBox(0.24, 0.012, 0.14), MATERIALS.wood);
  tray.position.set(at.x, at.y + 0.006, at.z);
  tray.rotation.y = facingCentreYaw(DEALER_STATION);
  tray.receiveShadow = true;
  return tray;
}
