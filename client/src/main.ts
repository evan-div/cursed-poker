import {
  MIN_PLAYERS,
  type ClientView,
  type LegalActions,
  type MatchEvent,
  type PlayerAction,
  type SeatView,
  type SessionGrant,
} from '@cursed/shared';
import { GameConnection } from './net.js';
import { cardElement, chips, placeholderCard } from './cards.js';
import { describeEvent } from './narration.js';

/**
 * Developer table.
 *
 * Deliberately plain: Phase 2's job is to prove a group can play a whole
 * tournament online with correct hidden information, and a 3D table would only
 * hide bugs behind atmosphere. Phase 3 replaces this whole file.
 *
 * The client renders exactly what the server sends and nothing more. It never
 * decides whose turn it is, what is legal, or what a hand is worth — when the
 * action bar is missing, it is because the server did not send one.
 */

const app = document.querySelector<HTMLElement>('#app')!;
const connection = new GameConnection();

let view: ClientView | null = null;
let log: string[] = [];
let banner: { text: string; kind: 'error' | 'info' } | null = null;
let connected = false;
/** Local echo so a click cannot be sent twice while the next view is in flight. */
let pendingAction = false;

connection.onView = (next) => {
  // Any new view supersedes whatever was clicked, so the action bar unlocks.
  view = next;
  pendingAction = false;
  render();
};
connection.onEvents = (events: MatchEvent[]) => {
  for (const event of events) {
    const line = describeEvent(event, view);
    if (line) log.push(line);
  }
  log = log.slice(-120);
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

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function createLobby(displayName: string): Promise<void> {
  const response = await connection.send<SessionGrant>('lobby:create', { displayName });
  if (!response.ok) return setBanner(response.message, 'error');
  connection.rememberSession(response);
}

async function joinLobby(code: string, displayName: string): Promise<void> {
  const response = await connection.send<SessionGrant>('lobby:join', { code, displayName });
  if (!response.ok) return setBanner(response.message, 'error');
  connection.rememberSession(response);
}

async function send(name: 'lobby:ready' | 'lobby:start', payload: unknown): Promise<void> {
  const response = await connection.send(name, payload);
  if (!response.ok) setBanner(response.message, 'error');
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

function render(): void {
  app.replaceChildren(
    header(),
    ...(banner ? [bannerElement(banner)] : []),
    ...(view === null || view.you.seatIndex === null ? [landing()] : [table(view)]),
  );
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The level countdown, kept as a live reference. Re-rendering the whole tree
 * once a second would pull buttons out from under the cursor mid-click, so the
 * clock updates in place and the rest of the DOM only changes when state does.
 */
let clockElement: HTMLElement | null = null;

function header(): HTMLElement {
  const bar = el('header', 'topbar');
  bar.append(el('h1', 'brand', 'CURSED POKER'));
  const status = el('span', `status ${connected ? 'up' : 'down'}`, connected ? 'connected' : 'offline');
  if (view) {
    bar.append(el('span', 'room', `lobby ${view.room.code}`));
    if (view.level) {
      bar.append(
        el(
          'span',
          'level',
          `L${view.level.level} · ${chips(view.level.smallBlind)}/${chips(view.level.bigBlind)}` +
            (view.level.ante > 0 ? ` (ante ${chips(view.level.ante)})` : ''),
        ),
      );
      clockElement = el('span', 'clock', levelCountdown(view));
      bar.append(clockElement);
    }
  }
  bar.append(status);
  return bar;
}

function levelCountdown(current: ClientView): string {
  if (!current.level?.endsAt) return '--:--';
  const remaining = Math.max(0, current.level.endsAt - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function bannerElement(current: { text: string; kind: string }): HTMLElement {
  const node = el('div', `banner ${current.kind}`, current.text);
  node.addEventListener('click', () => {
    banner = null;
    render();
  });
  return node;
}

function landing(): HTMLElement {
  const panel = el('section', 'panel landing');
  panel.append(el('p', 'lede', 'Sit down. The Dealer is waiting.'));

  const name = document.createElement('input');
  name.placeholder = 'Your name';
  name.maxLength = 20;
  name.value = localStorage.getItem('cursed-poker.name') ?? '';
  name.addEventListener('input', () => localStorage.setItem('cursed-poker.name', name.value));

  const code = document.createElement('input');
  code.placeholder = 'Lobby code';
  code.maxLength = 6;
  code.className = 'code-input';

  const create = el('button', 'primary', 'Create lobby');
  create.addEventListener('click', () => void createLobby(name.value.trim()));

  const join = el('button', '', 'Join');
  join.addEventListener('click', () => void joinLobby(code.value.trim(), name.value.trim()));

  const row = el('div', 'row');
  row.append(code, join);
  panel.append(name, create, el('div', 'divider', 'or'), row);
  return panel;
}

function table(current: ClientView): HTMLElement {
  const wrapper = el('div', 'layout');
  wrapper.append(current.room.status === 'LOBBY' ? lobby(current) : felt(current), sidebar(current));
  return wrapper;
}

function lobby(current: ClientView): HTMLElement {
  const panel = el('section', 'panel');
  panel.append(el('h2', '', `Lobby ${current.room.code}`));
  panel.append(
    el(
      'p',
      'hint',
      `${current.players.length} seated · needs ${MIN_PLAYERS} to begin · seats 6`,
    ),
  );

  const list = el('ul', 'players');
  for (const player of current.players) {
    const item = el('li', player.ready ? 'ready' : '');
    item.append(el('span', 'name', player.displayName));
    if (player.isHost) item.append(el('span', 'tag', 'host'));
    if (!player.connected) item.append(el('span', 'tag warn', 'away'));
    item.append(el('span', 'tick', player.ready ? 'ready' : 'waiting'));
    list.append(item);
  }
  panel.append(list);

  const me = current.players.find((p) => p.playerId === current.you.playerId);
  const readyButton = el('button', me?.ready ? '' : 'primary', me?.ready ? 'Not ready' : 'Ready');
  readyButton.addEventListener('click', () => void send('lobby:ready', { ready: !me?.ready }));
  panel.append(readyButton);

  if (me?.isHost) {
    const everyoneReady = current.players.every((p) => p.ready);
    const canStart = current.players.length >= MIN_PLAYERS && everyoneReady;
    const startButton = el('button', 'primary', 'Begin the game');
    startButton.toggleAttribute('disabled', !canStart);
    startButton.addEventListener('click', () => void send('lobby:start', {}));
    panel.append(startButton);
  }
  return panel;
}

function felt(current: ClientView): HTMLElement {
  const panel = el('section', 'panel felt');

  if (current.winnerPlayerId) {
    const winner = current.players.find((p) => p.playerId === current.winnerPlayerId);
    panel.append(
      el('div', 'winner', `${winner?.displayName ?? 'Someone'} is the last one at the table.`),
    );
  }

  const seats = el('div', 'seats');
  for (const seat of current.hand?.seats ?? []) seats.append(seatCard(seat, current));
  panel.append(seats);

  const middle = el('div', 'middle');
  const board = el('div', 'board');
  const boardCards = current.hand?.board ?? [];
  for (const card of boardCards) board.append(cardElement(card));
  for (let i = boardCards.length; i < 5; i++) board.append(placeholderCard(false));
  middle.append(board);
  middle.append(el('div', 'pot', `pot ${chips(current.hand?.potTotal ?? 0)}`));
  panel.append(middle);

  panel.append(hole(current));
  panel.append(actionBar(current));
  return panel;
}

function seatCard(seat: SeatView, current: ClientView): HTMLElement {
  const classes = ['seat'];
  if (seat.folded) classes.push('folded');
  if (seat.allIn) classes.push('allin');
  if (!seat.connected) classes.push('away');
  if (current.hand?.actingSeat === seat.seatIndex) classes.push('acting');
  if (seat.playerId === current.you.playerId) classes.push('me');

  const node = el('div', classes.join(' '));
  const nameRow = el('div', 'seat-name');
  nameRow.append(el('span', '', seat.displayName));
  if (current.hand?.buttonSeat === seat.seatIndex) nameRow.append(el('span', 'button-chip', 'D'));
  if (current.hand?.smallBlindSeat === seat.seatIndex) nameRow.append(el('span', 'tag', 'sb'));
  if (current.hand?.bigBlindSeat === seat.seatIndex) nameRow.append(el('span', 'tag', 'bb'));
  node.append(nameRow);

  node.append(el('div', 'stack', chips(seat.stack)));
  if (seat.betThisRound > 0) node.append(el('div', 'bet', `bet ${chips(seat.betThisRound)}`));
  if (seat.folded) node.append(el('div', 'state', 'folded'));
  else if (seat.allIn) node.append(el('div', 'state', 'all in'));
  if (!seat.connected) node.append(el('div', 'state warn', 'disconnected'));

  if (seat.revealedCards) {
    const shown = el('div', 'shown');
    for (const card of seat.revealedCards) shown.append(cardElement(card, 'small'));
    node.append(shown);
    if (seat.handCategory) {
      node.append(el('div', 'category', seat.handCategory.replaceAll('_', ' ').toLowerCase()));
    }
  }
  return node;
}

function hole(current: ClientView): HTMLElement {
  const box = el('div', 'hole');
  box.append(el('span', 'hole-label', 'your hand'));
  const cards = el('div', 'hole-cards');
  if (current.you.holeCards) {
    for (const card of current.you.holeCards) cards.append(cardElement(card, 'big'));
  } else {
    cards.append(placeholderCard(), placeholderCard());
  }
  box.append(cards);
  return box;
}

function actionBar(current: ClientView): HTMLElement {
  const bar = el('div', 'actions');
  const legal = current.you.legalActions;

  if (!legal) {
    const acting = current.hand?.seats.find((s) => s.seatIndex === current.hand?.actingSeat);
    bar.append(
      el(
        'span',
        'waiting',
        current.room.status === 'FINISHED'
          ? 'The game is over.'
          : acting
            ? `Waiting on ${acting.displayName}…`
            : 'Waiting…',
      ),
    );
    return bar;
  }

  const button = (label: string, action: PlayerAction, className = '') => {
    const node = el('button', className, label);
    node.toggleAttribute('disabled', pendingAction);
    node.addEventListener('click', () => void submit(action));
    return node;
  };

  if (legal.canFold) bar.append(button('Fold', { type: 'FOLD' }, 'fold'));
  if (legal.canCheck) bar.append(button('Check', { type: 'CHECK' }, 'primary'));
  if (legal.canCall) {
    bar.append(button(`Call ${chips(legal.callAmount)}`, { type: 'CALL' }, 'primary'));
  }
  if (legal.canRaise) bar.append(raiseControls(legal, current));
  return bar;
}

function raiseControls(legal: LegalActions, current: ClientView): HTMLElement {
  const group = el('div', 'raise');

  if (legal.raiseIsAllInOnly) {
    const shove = el('button', 'shove', `All in ${chips(legal.maxRaiseTo)}`);
    shove.toggleAttribute('disabled', pendingAction);
    shove.addEventListener('click', () => void submit({ type: 'ALL_IN' }));
    group.append(shove);
    return group;
  }

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(legal.minRaiseTo);
  slider.max = String(legal.maxRaiseTo);
  slider.step = String(Math.max(1, current.level?.smallBlind ?? 1));
  slider.value = String(legal.minRaiseTo);

  const amount = el('span', 'amount', chips(legal.minRaiseTo));
  slider.addEventListener('input', () => (amount.textContent = chips(Number(slider.value))));

  const confirm = el('button', 'primary', legal.raiseActionType === 'BET' ? 'Bet' : 'Raise to');
  confirm.toggleAttribute('disabled', pendingAction);
  confirm.addEventListener('click', () =>
    void submit({ type: legal.raiseActionType, to: Number(slider.value) } as PlayerAction),
  );

  const shove = el('button', 'shove', 'All in');
  shove.toggleAttribute('disabled', pendingAction);
  shove.addEventListener('click', () => void submit({ type: 'ALL_IN' }));

  group.append(confirm, amount, slider, shove);
  return group;
}

function sidebar(current: ClientView): HTMLElement {
  const side = el('aside', 'panel sidebar');
  side.append(el('h3', '', 'The table remembers'));
  const list = el('ol', 'log');
  for (const line of [...log].reverse()) list.append(el('li', '', line));
  side.append(list);

  if (current.room.status !== 'LOBBY') {
    const standings = el('div', 'standings');
    for (const player of [...current.players].sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0))) {
      const row = el('div', player.seated ? '' : 'out');
      row.append(el('span', '', player.displayName));
      row.append(el('span', '', player.seated ? '' : 'taken'));
      standings.append(row);
    }
    side.append(el('h3', '', 'Seats'), standings);
  }
  return side;
}

setInterval(() => {
  if (view?.level?.endsAt && clockElement) clockElement.textContent = levelCountdown(view);
}, 1_000);

render();
