import type { ClientView, MatchEvent, PlayerAction, SessionGrant } from '@cursed/shared';
import { GameConnection } from './net.js';
import { describeEvent } from './narration.js';
import { GameScene } from './scene/game-scene.js';
import { el } from './ui/dom.js';
import { renderLanding, renderLobby, type LobbyHandlers } from './ui/lobby.js';
import { renderHud } from './ui/hud.js';
import { Nameplates } from './ui/nameplates.js';

/**
 * Client bootstrap.
 *
 * Two worlds, one source of truth. Before the match starts the screen is a plain
 * DOM lobby; once it does, it is a 3D table with a DOM overlay on top. Both are
 * driven by the same `ClientView`, and neither of them decides anything: if the
 * action bar is missing, it is because the server did not send legal actions.
 */

const app = document.querySelector<HTMLElement>('#app')!;
const connection = new GameConnection();

let view: ClientView | null = null;
let log: string[] = [];
let banner: { text: string; kind: 'error' | 'info' } | null = null;
let connected = false;
/** Local echo so a click cannot be sent twice while the next view is in flight. */
let pendingAction = false;

let scene: GameScene | null = null;
let nameplates: Nameplates | null = null;
let canvas: HTMLCanvasElement | null = null;

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
  render();
};

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

    scene = new GameScene(canvas);
    nameplates = new Nameplates();
    stage.append(nameplates.root);
    scene.onFrame = () => {
      if (!scene || !nameplates || !canvas) return;
      nameplates.project(scene.seated.camera, canvas.clientWidth, canvas.clientHeight);
    };
    scene.start();
  }

  const stage = app.querySelector<HTMLElement>('.stage')!;
  scene.apply(current);
  nameplates?.update(current);

  // The overlay is rebuilt from scratch; the canvas and nameplates are not.
  for (const stale of stage.querySelectorAll('.hud, .banner')) stale.remove();
  if (banner) stage.append(bannerElement(banner));
  stage.append(renderHud({ view: current, log, connected, pendingAction }, { submit }));
}

function teardownScene(): void {
  if (!scene) return;
  scene.dispose();
  scene = null;
  nameplates = null;
  canvas = null;
}

function bannerElement(current: { text: string; kind: string }): HTMLElement {
  const node = el('div', `banner ${current.kind}`, current.text);
  node.addEventListener('click', () => {
    banner = null;
    render();
  });
  return node;
}

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

render();
