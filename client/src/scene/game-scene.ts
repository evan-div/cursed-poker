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
import type { ClientView } from '@cursed/shared';
import { buildRoom } from './table.js';
import { SeatedCamera } from './seated-camera.js';
import { Avatar } from './avatar.js';
import { Dealer, buildTrophyTray } from './dealer.js';
import { CardRenderer } from './cards.js';
import { ChipRenderer } from './chips.js';

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
 */
export class GameScene {
  readonly scene = new Scene();
  readonly renderer: WebGLRenderer;
  readonly seated: SeatedCamera;

  /** Called once per rendered frame, after the camera has settled. */
  onFrame: (() => void) | null = null;

  #canvas: HTMLCanvasElement;
  #running = false;
  #lastFrame = 0;
  #seatIndex: number | null | undefined;
  #resizeObserver: ResizeObserver | null = null;

  #free: { x: number; y: number; z: number } | null = null;
  #avatars = new Map<number, Avatar>();
  #dealer = new Dealer();
  #cards = new CardRenderer();
  #chips = new ChipRenderer();

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;

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
    this.seated.attach(canvas);

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
    this.#applyAvatars(view);
    this.#cards.apply(view);
    this.#chips.apply(view);
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
    if (this.#free) {
      this.seated.camera.position.set(this.#free.x, this.#free.y, this.#free.z);
      this.seated.camera.lookAt(0, 0.8, 0);
    } else {
      this.seated.update(delta);
    }
    this.renderer.render(this.scene, this.seated.camera);
    this.onFrame?.();
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
