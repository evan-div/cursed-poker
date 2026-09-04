import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  PCFSoftShadowMap,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { ClientView, GazeTarget, MatchEvent, PresenceFrame } from '@cursed/shared';
import { buildRoom } from './table.js';
import { SeatedCamera } from './seated-camera.js';
import { Avatar } from './avatar.js';
import { Dealer, buildTrophyTray } from './dealer.js';
import { CardRenderer } from './cards.js';
import { ChipRenderer } from './chips.js';
import { ATTENTION_WEIGHT } from './attention.js';
import { gazePoint } from './gaze.js';
import { CardPeekController } from '../interaction/card-peek-controller.js';
import { POT_POSITION, RADIUS, seatPoint } from './layout.js';

/** Everything the scene needs to report outward. Wired up in `main.ts`. */
export interface GameSceneHooks {
  /** The player started lifting their cards: ask the server for them. */
  onFirstLook: () => void;
  /** Their exposure changed, for reporting to the table. */
  onExposure: (exposure: number) => void;
  /** They are now looking at something different. */
  onGaze: (target: GazeTarget) => void;
}

/** Seats with a player in them, for a view with no hand in progress. */
function occupiedSeats(view: ClientView): number[] {
  return view.players
    .filter((player) => player.seatIndex !== null && player.seated)
    .map((player) => player.seatIndex!);
}

/**
 * The 3D table.
 *
 * The scene is a *function of the view*. Every frame it renders whatever the
 * last `ClientView` said, and it has no opinions of its own: it does not know
 * whose turn it is, what a hand is worth, or whether a card is good. If it ever
 * needs to compute something the server did not send, that is a bug in the
 * protocol, not a reason to compute it here.
 *
 * It also never renders a card it was not given. Face-down cards are drawn from
 * the same geometry with the back texture; there is no code path that turns an
 * unknown card into a known one, because there is no unknown card to turn.
 *
 * Phase 4 added a second input to that function: the presence frame, which says
 * what everybody's *body* is doing. It is applied the same way — straight onto
 * the scene, derived from nothing — and it is what makes the table a room full
 * of people rather than a board with names on it.
 */
export class GameScene {
  readonly scene = new Scene();
  readonly renderer: WebGLRenderer;
  readonly seated: SeatedCamera;

  /** Called once per rendered frame, after the camera has settled. */
  onFrame: ((deltaSeconds: number) => void) | null = null;

  /** Lifting your own cards. Owned here because the frame loop drives it. */
  readonly peek: CardPeekController;

  #canvas: HTMLCanvasElement;
  #running = false;
  #lastFrame = 0;
  #seatIndex: number | null | undefined;
  #resizeObserver: ResizeObserver | null = null;

  #free: { x: number; y: number; z: number } | null = null;
  #avatars = new Map<number, Avatar>();
  #actingSeat: number | null | undefined;
  #handNumber: number | null = null;
  #lastPresence: PresenceFrame | null = null;
  #dealer = new Dealer();
  #cards = new CardRenderer();
  #chips = new ChipRenderer();

  constructor(canvas: HTMLCanvasElement, hooks: GameSceneHooks) {
    this.#canvas = canvas;
    this.peek = new CardPeekController({
      onFirstLook: hooks.onFirstLook,
      onExposure: (exposure) => {
        hooks.onExposure(exposure);
        this.#cards.setLocalPeek(this.#seatIndex ?? null, exposure);
      },
    });

    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Capped: a 3x retina display would otherwise quadruple the pixel cost for
    // a scene whose whole point is that most of it is dark.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.scene.background = new Color(0x070605);
    buildRoom(this.scene);
    this.scene.add(this.#dealer.group, buildTrophyTray(), this.#cards.group, this.#chips.group);

    this.seated = new SeatedCamera(this.#aspect());
    this.seated.sitAt(null);
    this.seated.onGazeChanged = hooks.onGaze;
    // Lifting a card and turning your head are the same physical movement, so
    // the peek takes the pointer while it is held and the camera stays put.
    this.seated.pointerIsConsumed = () => this.peek.holding;
    this.seated.onPointerConsumed = (dx, dy) => this.peek.pointerMoved(dx, dy);
    this.seated.attach(canvas);
    this.peek.attach(canvas);

    // Exposed so the performance budget can be read from a real browser.
    (window as unknown as { __sceneStats?: () => unknown }).__sceneStats = () => this.stats();

    // A free camera, for looking at the table from somewhere a player cannot
    // sit. Development only: it is the fastest way to find out that something
    // is in the wrong place, and it never ships.
    if (import.meta.env.DEV) {
      (window as unknown as { __inspect?: unknown }).__inspect = () => {
        const box = new Box3();
        const size = new Vector3();
        const rows: Record<string, string> = {};
        for (const [seat, avatar] of this.#avatars) {
          box.setFromObject(avatar.group);
          box.getSize(size);
          rows[`seat${seat}`] =
            `y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)} size ` +
            `${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)} ` +
            `visible=${avatar.group.visible}`;
        }
        box.setFromObject(this.#dealer.group);
        box.getSize(size);
        rows['dealer'] = `y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)} size ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`;
        return rows;
      };

      // What this client believes everyone's body is doing. The scene is dark
      // and people block their own cards, so replication is far easier to check
      // as numbers than as a screenshot — and this is the only honest way to
      // ask "did the table actually see that?" from the outside.
      (window as unknown as { __bodies?: unknown }).__bodies = () => ({
        frameAgeMs: this.#lastPresence ? Date.now() - this.#lastPresence.serverTime : null,
        me: { seat: this.#seatIndex ?? null, peek: this.peek.exposure, gaze: this.seated.gaze },
        table: (this.#lastPresence?.seats ?? []).map((seat) => ({
          seat: seat.seatIndex,
          peek: seat.peek,
          gaze: seat.gaze,
          stillMs: seat.stillMs,
          present: seat.present,
        })),
      });

      (window as unknown as { __freeLook?: unknown }).__freeLook = (
        x: number,
        y: number,
        z: number,
      ) => {
        this.seated.detach();
        this.#free = { x, y, z };
      };
    }

    this.#resize();
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
  }

  /**
   * Applies the authoritative view.
   *
   * The whole scene is derived from this and nothing else — no accumulated
   * state, no guessing at what happened between two views. Calling it twice
   * with the same view leaves the table identical.
   */
  apply(view: ClientView): void {
    if (this.#seatIndex !== view.you.seatIndex) {
      this.#seatIndex = view.you.seatIndex;
      this.seated.sitAt(view.you.seatIndex);
    }

    const seats = (view.hand?.seats ?? []).map((seat) => seat.seatIndex);
    this.seated.setSeats(seats.length > 0 ? seats : occupiedSeats(view));

    // A new hand: the cards go back down and everybody has to look again.
    const handNumber = view.hand?.handNumber ?? null;
    if (handNumber !== this.#handNumber) {
      this.#handNumber = handNumber;
      this.peek.reset();
      this.#cards.setLocalPeek(this.#seatIndex ?? null, 0);
    }

    this.#applyAvatars(view);
    this.#cards.apply(view);
    this.#chips.apply(view);
    this.#biasAttention(view);
  }

  /** Everybody else's bodies, straight from the server's broadcast. */
  applyPresence(frame: PresenceFrame): void {
    this.#lastPresence = frame;
    this.#cards.applyPresence(frame);
    for (const seat of frame.seats) {
      const avatar = this.#avatars.get(seat.seatIndex);
      if (!avatar) continue;
      // The local player's own body is driven by their own input, not by an
      // echo of it arriving 80ms later.
      if (seat.seatIndex === this.#seatIndex) continue;
      avatar.setGaze(seat.gaze);
      avatar.setPeek(seat.peek);
    }
  }

  /**
   * Turns the player's head toward whatever just mattered.
   *
   * A nudge, never a lock — see `attention.ts`. Everything here is driven by
   * narration the whole table receives, so nobody's attention is pulled toward
   * something they were not entitled to notice.
   */
  notify(events: MatchEvent[]): void {
    const now = performance.now();
    for (const event of events) {
      switch (event.type) {
        case 'PLAYER_ACTED': {
          const weight = event.allIn
            ? ATTENTION_WEIGHT.allIn
            : event.action.type === 'RAISE' || event.action.type === 'BET'
              ? ATTENTION_WEIGHT.raise
              : 0;
          if (weight > 0) this.#lookAtSeat(event.seatIndex, weight, now);
          break;
        }
        case 'STREET_DEALT':
          this.seated.focusOn(POT_POSITION, ATTENTION_WEIGHT.deal, now);
          break;
        case 'HOLE_CARDS_DEALT':
          this.seated.focusOn(
            gazePoint({ kind: 'DEALER' }, this.#seatIndex ?? 0)!,
            ATTENTION_WEIGHT.deal,
            now,
          );
          break;
        case 'SHOWDOWN':
          this.seated.focusOn(POT_POSITION, ATTENTION_WEIGHT.reckoning, now, 2_200);
          break;
        case 'PLAYER_ELIMINATED':
          this.#lookAtSeat(event.seatIndex, ATTENTION_WEIGHT.reckoning, now, 2_600);
          break;
        default:
          break;
      }
    }
  }

  #biasAttention(view: ClientView): void {
    const acting = view.hand?.actingSeat ?? null;
    if (acting === this.#actingSeat) return;
    this.#actingSeat = acting;
    // Your own turn does not pull your head anywhere; you know where you are.
    if (acting === null || acting === this.#seatIndex) return;
    this.#lookAtSeat(acting, ATTENTION_WEIGHT.turn, performance.now());
  }

  #lookAtSeat(seatIndex: number, weight: number, now: number, durationMs?: number): void {
    if (seatIndex === this.#seatIndex) return;
    this.seated.focusOn(seatPoint(seatIndex, RADIUS.body, 1.21), weight, now, durationMs);
  }

  #applyAvatars(view: ClientView): void {
    for (const player of view.players) {
      if (player.seatIndex === null) continue;
      let avatar = this.#avatars.get(player.seatIndex);
      if (!avatar) {
        avatar = new Avatar(player.seatIndex);
        this.#avatars.set(player.seatIndex, avatar);
        this.scene.add(avatar.group);
      }
      avatar.setLocal(player.playerId === view.you.playerId);
      // An eliminated player leaves the chair; the chair stays.
      avatar.setPresent(player.seated);
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastFrame = performance.now();
    this.renderer.setAnimationLoop((now) => this.#frame(now));
  }

  stop(): void {
    this.#running = false;
    this.renderer.setAnimationLoop(null);
  }

  dispose(): void {
    this.stop();
    this.#resizeObserver?.disconnect();
    this.peek.detach();
    this.seated.detach();
    this.renderer.dispose();
  }

  /** Live counters, so the performance budget is something we can watch. */
  stats(): { drawCalls: number; triangles: number; programs: number } {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
    };
  }

  #frame(now: number): void {
    const delta = Math.min((now - this.#lastFrame) / 1000, 0.1);
    this.#lastFrame = now;

    this.peek.update(delta);
    this.#cards.updatePoses();
    for (const avatar of this.#avatars.values()) avatar.update(delta);

    if (this.#free) {
      this.seated.camera.position.set(this.#free.x, this.#free.y, this.#free.z);
      this.seated.camera.lookAt(0, 0.8, 0);
    } else {
      this.seated.update(delta, now);
    }
    this.renderer.render(this.scene, this.seated.camera);
    this.onFrame?.(delta);
  }

  #aspect(): number {
    const { clientWidth, clientHeight } = this.#canvas;
    return clientHeight > 0 ? clientWidth / clientHeight : 16 / 9;
  }

  #resize(): void {
    const parent = this.#canvas.parentElement;
    const width = parent?.clientWidth ?? window.innerWidth;
    const height = parent?.clientHeight ?? window.innerHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.seated.setAspect(width / height);
  }
}
