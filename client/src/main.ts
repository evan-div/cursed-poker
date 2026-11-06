import {
  PRESENCE,
  type ClientView,
  type GazeTarget,
  type MatchEvent,
  type PlayerAction,
  type PresenceFrame,
  type SessionGrant,
} from '@cursed/shared';
import { GameConnection } from './net.js';
import { describeEvent, type LogLine } from './narration.js';
import { GameScene } from './scene/game-scene.js';
import { PresenceReporter } from './interaction/presence-reporter.js';
import { el } from './ui/dom.js';
import { renderLanding, renderLobby, type LobbyHandlers } from './ui/lobby.js';
import { actionForKey, renderHud } from './ui/hud.js';
import { Nameplates } from './ui/nameplates.js';
import { Tunnel } from './ui/tunnel.js';
import { ComposureOverlay } from './ui/composure.js';

/**
 * Client bootstrap.
 *
 * Two worlds, one source of truth. Before the match starts the screen is a plain
 * DOM lobby; once it does, it is a 3D table with a DOM overlay on top. Both are
 * driven by the same `ClientView`, and neither of them decides anything: if the
 * action bar is missing, it is because the server did not send legal actions.
 *
 * There are now two streams from the server rather than one. `view` is the
 * situation and arrives when poker changes; `presence` is everybody's body and
 * arrives on a tick. Only the first one ever carries a card.
 */

const app = document.querySelector<HTMLElement>('#app')!;
const connection = new GameConnection();

let view: ClientView | null = null;
let log: LogLine[] = [];
let banner: { text: string; kind: 'error' | 'info' } | null = null;
let connected = false;
/** Local echo so a click cannot be sent twice while the next view is in flight. */
let pendingAction = false;

let scene: GameScene | null = null;
let nameplates: Nameplates | null = null;
let tunnel: Tunnel | null = null;
let composure: ComposureOverlay | null = null;
let canvas: HTMLCanvasElement | null = null;
let pointerLocked = false;
/** The hand we have already asked to look at, so a re-check is not re-asked. */
let peekedHand = 0;

/**
 * Reporting our own body.
 *
 * Note what it is *not*: optional. A client that reports nothing is replicated
 * as perfectly still, which is a tell in its own right — see `presence.ts`.
 */
const reporter = new PresenceReporter({
  send: (report) => connection.tell('player:presence', report),
});

/**
 * "Their hands are on their chips."
 *
 * Held for a moment after the last touch and then released on its own. Without
 * the timer a player who nudged the bet slider and then sat back would read as
 * permanently reaching for their stack — and since the HUD is rebuilt on every
 * view, there is no reliable "let go" event to hang it on. Handling chips is a
 * thing you are doing, not a mode you are in.
 */
let chipTimer: ReturnType<typeof setTimeout> | null = null;

function handlingChips(handling: boolean): void {
  if (chipTimer !== null) clearTimeout(chipTimer);
  chipTimer = null;
  if (!handling) return reporter.setHandlingChips(false);

  reporter.setHandlingChips(true);
  chipTimer = setTimeout(() => {
    chipTimer = null;
    reporter.setHandlingChips(false);
  }, 700);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

connection.onView = (next) => {
  view = next;
  pendingAction = false;
  render();
};

connection.onEvents = (events: MatchEvent[]) => {
  for (const event of events) {
    const line = describeEvent(event, view);
    if (line) log.push(line);
  }
  log = log.slice(-160);
  scene?.notify(events);
  render();
};

/**
 * Everybody's bodies.
 *
 * Applied straight to the scene without going near the DOM: it changes twelve
 * times a second, and rebuilding an overlay at that rate to say that somebody
 * turned their head would be absurd.
 */
connection.onPresence = (frame: PresenceFrame) => scene?.applyPresence(frame);

/** Your own heart. Same reasoning: straight to the scene, never the DOM. */
connection.onSelf = (frame) => scene?.applySelf(frame);

connection.onError = (error) => setBanner(error.message, 'error');

connection.onStatus = (isConnected) => {
  connected = isConnected;
  if (!isConnected) setBanner('Connection lost — reconnecting…', 'error');
  else if (banner?.kind === 'error') banner = null;
  render();
};

function setBanner(text: string, kind: 'error' | 'info'): void {
  banner = { text, kind };
  render();
}

const lobbyHandlers: LobbyHandlers = {
  createLobby: async (displayName) => {
    const response = await connection.send<SessionGrant>('lobby:create', { displayName });
    if (!response.ok) return setBanner(response.message, 'error');
    connection.rememberSession(response);
  },
  joinLobby: async (code, displayName) => {
    const response = await connection.send<SessionGrant>('lobby:join', { code, displayName });
    if (!response.ok) return setBanner(response.message, 'error');
    connection.rememberSession(response);
  },
  setReady: async (ready) => {
    const response = await connection.send('lobby:ready', { ready });
    if (!response.ok) setBanner(response.message, 'error');
  },
  start: async () => {
    const response = await connection.send('lobby:start', {});
    if (!response.ok) setBanner(response.message, 'error');
  },
};

/**
 * "I am lifting my cards."
 *
 * Sent once per hand, when the gesture begins rather than when it completes, so
 * the cards are already here by the time the player has pulled far enough to
 * read one. The reply is not the cards — it is a view that happens to contain
 * them, through the same boundary as everything else.
 */
async function requestPeek(): Promise<void> {
  const handNumber = view?.hand?.handNumber;
  if (!handNumber || peekedHand === handNumber) return;
  peekedHand = handNumber;
  const response = await connection.send('poker:peek', { handNumber });
  // A refusal is not worth a banner: it means the hand ended mid-reach, or we
  // are not in it. Either way there is nothing to show and nothing to fix.
  if (!response.ok) peekedHand = 0;
}

async function submit(action: PlayerAction): Promise<void> {
  if (!view?.hand || pendingAction) return;
  pendingAction = true;
  render();
  const response = await connection.send('poker:action', {
    handNumber: view.hand.handNumber,
    action,
  });
  if (!response.ok) {
    pendingAction = false;
    setBanner(response.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Not a type guard on purpose: a lobby view is a perfectly good `ClientView`,
 * so narrowing on this would tell the compiler the wrong thing about the other
 * branch.
 */
function atTheTable(current: ClientView): boolean {
  return current.you.seatIndex !== null && current.room.status !== 'LOBBY';
}

function render(): void {
  if (view && atTheTable(view)) {
    renderTable(view);
    return;
  }

  teardownScene();
  const inLobby = view !== null && view.you.seatIndex !== null;
  app.replaceChildren(
    ...(banner ? [bannerElement(banner)] : []),
    inLobby ? renderLobby(view!, lobbyHandlers) : renderLanding(lobbyHandlers),
  );
}

function renderTable(current: ClientView): void {
  if (!scene || !canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'table-canvas';
    const stage = el('div', 'stage');
    stage.append(canvas);
    app.replaceChildren(stage);

    scene = new GameScene(canvas, {
      onFirstLook: () => void requestPeek(),
      onExposure: (exposure, lift) => {
        reporter.setPeek(exposure);
        reporter.setLift(lift);
      },
      onGaze: (target: GazeTarget) => reporter.setGaze(target),
    });
    // Order is the stacking: the room, then fear, then everything that is
    // poker. Tunnel vision may darken the table; it may never cover a name, a
    // stack or a button.
    tunnel = new Tunnel();
    nameplates = new Nameplates();
    composure = new ComposureOverlay();
    stage.append(tunnel.root, nameplates.root, composure.root);

    scene.onFrame = () => {
      if (!scene || !nameplates || !canvas) return;
      nameplates.project(scene.seated.camera, canvas.clientWidth, canvas.clientHeight);
      tunnel?.set(scene.felt.tunnel);
      composure?.frame(performance.now(), scene.felt.unsteadiness);
    };

    // Pointer lock is offered, never imposed: clicking the table takes it,
    // Escape gives it back, and everything still works either way.
    canvas.addEventListener('pointerdown', (event) => {
      // The first click is also what the browser needs before it will let any
      // sound out — see `startRoomAudio`. Doing it here rather than behind a
      // settings toggle means the room has a sound the moment anybody touches
      // the table, and never before.
      scene?.startAudio();
      if (event.button === 0 && !scene?.seated.locked) scene?.seated.requestLock();
    });
    scene.seated.onLockChanged = (locked) => {
      pointerLocked = locked;
      render();
    };

    reporter.setEnabled(true);
    scene.start();
  }

  const stage = app.querySelector<HTMLElement>('.stage')!;
  scene.apply(current);
  nameplates?.update(current);
  composure?.apply(current.you.composure, performance.now());

  // The overlay is rebuilt from scratch; the canvas and nameplates are not.
  for (const stale of stage.querySelectorAll('.hud, .banner')) stale.remove();
  if (banner) stage.append(bannerElement(banner));
  stage.append(
    renderHud(
      { view: current, log, connected, pendingAction, pointerLocked },
      { submit, handlingChips },
    ),
  );
}

function teardownScene(): void {
  if (!scene) return;
  reporter.setEnabled(false);
  scene.dispose();
  scene = null;
  nameplates = null;
  tunnel = null;
  composure = null;
  canvas = null;
  pointerLocked = false;
  handlingChips(false);
}

/**
 * Acting without a cursor.
 *
 * With the pointer locked there is nothing to click, and a player who has to
 * surrender the room every time they want to call is not really sitting at the
 * table. The keys do exactly what the buttons do — the same action, through the
 * same submit, re-validated by the same server.
 */
window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) {
    return;
  }

  // Composure. Space is only ever a breath while a challenge is running, and
  // swallowed then so it cannot also press whatever button has focus.
  if (event.key === ' ' && composure?.challengeId) {
    event.preventDefault();
    if (!event.repeat) composureKey('DOWN');
    return;
  }
  if (event.repeat) return;
  if (event.key.toLowerCase() === COMPOSURE_KEY) {
    event.preventDefault();
    void beginComposure();
    return;
  }

  const slider = app.querySelector<HTMLInputElement>('input[data-role="raise-amount"]');
  const action = actionForKey(event.key, view?.you.legalActions ?? null, sliderValue(slider));
  if (!action) return;
  event.preventDefault();
  void submit(action);
});

window.addEventListener('keyup', (event) => {
  if (event.key !== ' ' || !composure?.challengeId) return;
  event.preventDefault();
  composureKey('UP');
});

/** The key that asks to steady yourself. B, for breathe. */
const COMPOSURE_KEY = 'b';

/**
 * "Let me steady myself."
 *
 * A refusal — already steadying, or not yet allowed again — is not worth a
 * banner. The hint already says when you can.
 */
async function beginComposure(): Promise<void> {
  if (!view || !atTheTable(view) || view.you.composure.challenge) return;
  await connection.send('composure:begin', {});
}

/**
 * A breath tapped or held. Sent the instant it happens and timed by the server
 * on arrival; the guide is told locally so it can move without waiting.
 */
function composureKey(input: 'DOWN' | 'UP'): void {
  const id = composure?.challengeId;
  if (!id) return;
  composure!.press(input, performance.now());
  connection.tell('composure:input', { challengeId: id, input });
  if (input === 'DOWN') scene?.exhale();
}

function sliderValue(slider: HTMLInputElement | null): number | null {
  if (!slider) return null;
  const value = Number(slider.value);
  return Number.isFinite(value) ? value : null;
}

function bannerElement(current: { text: string; kind: string }): HTMLElement {
  const node = el('div', `banner ${current.kind}`, current.text);
  node.addEventListener('click', () => {
    banner = null;
    render();
  });
  return node;
}

/**
 * The body report runs on its own clock, not on the render loop.
 *
 * Tempting to fold it into `onFrame`, and wrong: a client whose frame rate drops
 * would report less often, and the table would see them going still — a tell
 * they are not actually giving. What the rest of the room learns about your body
 * should not depend on your graphics card.
 */
setInterval(() => {
  if (scene) reporter.setLean(scene.seated.lean);
  reporter.update(performance.now());
}, Math.round(1000 / PRESENCE.clientHz));

// The blind clock ticks once a second. It updates in place rather than
// re-rendering, so a countdown cannot pull a button out from under a click.
setInterval(() => {
  const clock = app.querySelector<HTMLElement>('.hud-top .clock');
  if (clock && view?.level) {
    const remaining = Math.max(0, (view.level.endsAt ?? 0) - Date.now());
    const minutes = Math.floor(remaining / 60_000);
    const seconds = Math.floor((remaining % 60_000) / 1_000);
    clock.textContent = view.level.endsAt === null ? '--:--' : `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
}, 1_000);

// What this client was last told, for the browser checks in `scripts/`. It is
// exactly what the server sent this player and nothing more, so exposing it in
// development reveals nothing a player could not already see in the network tab.
if (import.meta.env.DEV) {
  (window as unknown as { __view?: () => ClientView | null }).__view = () => view;
}

render();
