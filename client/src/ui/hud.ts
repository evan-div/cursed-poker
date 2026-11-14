import type { ClientView, LegalActions, PlayerAction } from '@cursed/shared';
import { button, chips, countdown, el } from './dom.js';
import { cardChip } from './card-chip.js';
import type { LogLine } from '../narration.js';

/**
 * The overlay sitting on top of the table.
 *
 * Kept in DOM rather than drawn in 3D: text in a WebGL scene is expensive,
 * blurry and awkward to click, and a bet slider is a bet slider. What belongs in
 * the world — cards, chips, hands, the Dealer — is in the world.
 *
 * Nothing here decides anything. The action bar exists only when the server sent
 * `legalActions`, and its buttons are whatever the server said were legal.
 *
 * Phase 4 gave every button a key. With pointer lock engaged there is no cursor
 * to click with, and a player should never have to break out of the room to bet
 * — that would make looking around and playing poker mutually exclusive, which
 * is a strange thing for a poker game to ask.
 *
 * **It is not rebuilt wholesale any more.** It used to be: every view and every
 * batch of events threw the whole overlay away and made a new one, bet slider
 * included. So a player dragging the slider toward a big raise had it snap back
 * to the minimum whenever anything at all reached their client — somebody else
 * glancing at their cards was enough — and the next press of `R` raised the
 * minimum instead. Each part of the overlay now has a key saying what it shows,
 * and is rebuilt only when that changes. A view that leaves your legal actions
 * alone leaves your hands on the chips alone too.
 */

export interface HudHandlers {
  submit: (action: PlayerAction) => void;
  /**
   * The player is touching their chips.
   *
   * Sizing a bet is a physical act at a real table, and everybody can see you do
   * it. They cannot see the *amount* — that would be a piece of information no
   * poker player has ever had — but reaching for your stack is a tell, so the
   * table is told that much and no more.
   */
  handlingChips: (handling: boolean) => void;
  /** Get up from the table. See `leaveTable` in `main.ts`. */
  leave: () => void;
}

export interface HudState {
  view: ClientView;
  log: LogLine[];
  /** Counts lines ever logged, so the log knows when it has something new. */
  logVersion: number;
  connected: boolean;
  pendingAction: boolean;
  /** Whether the pointer is captured, so the hint can say the right thing. */
  pointerLocked: boolean;
}

/** Keys bound to actions, so a locked pointer never has to be given back. */
export const ACTION_KEYS: Record<string, 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL_IN'> = {
  f: 'FOLD',
  c: 'CHECK',
  r: 'RAISE',
  a: 'ALL_IN',
};

/** How long "leave" stays armed after the first press, in milliseconds. */
const LEAVE_ARMED_MS = 3_500;

/** Under this much time, the clock is running out and looks like it. */
export const CLOCK_LOW_MS = 8_000;

interface Section {
  key: string;
  node: HTMLElement;
}

export class Hud {
  readonly root = el('div', 'hud');

  #sections = new Map<string, Section>();
  #clock = el('div', 'hud-clock');
  #clockFill = el('div', 'hud-clock-fill');
  #clockLabel = el('span', 'hud-clock-label');
  #leaveArmedUntil = 0;
  #leaveTimer: ReturnType<typeof setTimeout> | null = null;
  #lastState: HudState | null = null;
  #lastHandlers: HudHandlers | null = null;

  constructor() {
    this.#clock.append(this.#clockFill, this.#clockLabel);
    this.#clock.setAttribute('aria-hidden', 'true');
  }

  /** Brings the overlay up to date with the view. Cheap when nothing changed. */
  update(state: HudState, handlers: HudHandlers): void {
    this.#lastState = state;
    this.#lastHandlers = handlers;
    const { view } = state;
    const armed = Date.now() < this.#leaveArmedUntil;

    this.#section(
      'top',
      [
        view.room.code,
        view.level?.level,
        view.level?.smallBlind,
        view.level?.bigBlind,
        view.level?.ante,
        view.level?.endsAt === null,
        view.hand?.potTotal,
        state.connected,
        armed,
        seatedAndAlive(view),
        view.room.status,
      ].join('|'),
      () => this.#topBar(state, handlers, armed),
    );
    this.#section('log', String(state.logVersion), () => sideLog(state));
    this.#section('hint', hintKey(state), () => peekHint(state));
    this.#section(
      'actions',
      [JSON.stringify(view.you.legalActions), state.pendingAction, waitingText(view), view.level?.smallBlind].join('|'),
      () => actionBar(state, handlers),
    );
    this.#section('winner', `${view.winnerPlayerId ?? ''}|${view.room.status}`, () => winnerBanner(view, handlers));

    // The clock is one element that is moved, never rebuilt: see `tick`.
    if (!this.#clock.isConnected) this.root.append(this.#clock);
  }

  /**
   * Moves the action clock. Call every frame, or near enough.
   *
   * `remainingMs` and `totalMs` are for whoever is acting, or null when nobody
   * is on the clock. `mine` is whether it is this player's own.
   *
   * There was no clock on screen at all before this. A player had thirty
   * seconds to act and nothing anywhere said so; the first they knew of it was
   * being folded.
   */
  tick(remainingMs: number | null, totalMs: number, mine: boolean): void {
    if (remainingMs === null || totalMs <= 0) {
      this.#clock.classList.remove('running');
      return;
    }
    const left = Math.max(0, remainingMs);
    this.#clock.classList.add('running');
    this.#clock.classList.toggle('mine', mine);
    this.#clock.classList.toggle('low', left <= CLOCK_LOW_MS);
    this.#clockFill.style.transform = `scaleX(${Math.min(1, left / totalMs).toFixed(4)})`;
    const label = mine || left <= CLOCK_LOW_MS ? String(Math.ceil(left / 1000)) : '';
    if (this.#clockLabel.textContent !== label) this.#clockLabel.textContent = label;
  }

  /** Rebuilds one part of the overlay, but only if what it shows has changed. */
  #section(name: string, key: string, build: () => HTMLElement | null): void {
    const existing = this.#sections.get(name);
    if (existing?.key === key) return;

    const node = build() ?? el('div', `hud-${name} empty`);
    node.dataset['section'] = name;
    if (existing) existing.node.replaceWith(node);
    else this.root.append(node);
    this.#sections.set(name, { key, node });
  }

  #topBar(state: HudState, handlers: HudHandlers, armed: boolean): HTMLElement {
    const bar = el('div', 'hud-top');
    const { view } = state;
    bar.append(el('span', 'brand', 'Cursed Poker'));
    bar.append(el('span', 'room', view.room.code));
    if (view.level) {
      bar.append(
        el(
          'span',
          'level',
          `Level ${view.level.level} · ${chips(view.level.smallBlind)} / ${chips(view.level.bigBlind)}` +
            (view.level.ante > 0 ? ` · ante ${chips(view.level.ante)}` : ''),
        ),
      );
      bar.append(el('span', 'clock', countdown(view.level.endsAt)));
    }
    if (view.hand && view.hand.potTotal > 0) {
      const pot = el('span', 'pot');
      pot.append(el('span', 'pot-label', 'pot'), el('span', 'pot-amount', chips(view.hand.potTotal)));
      bar.append(pot);
    }
    bar.append(el('span', `status ${state.connected ? 'up' : 'down'}`, state.connected ? '' : 'offline'));

    // Getting up. Two presses, because the first one is often a mistake and
    // the seat it gives up, mid-match, plays itself out by folding.
    const stakes = seatedAndAlive(view) && view.room.status === 'IN_PROGRESS';
    const leave = button(armed ? (stakes ? 'Leave and fold?' : 'Leave?') : 'Leave', armed ? 'leave armed' : 'leave', () => {
      if (Date.now() < this.#leaveArmedUntil) return handlers.leave();
      this.#leaveArmedUntil = Date.now() + LEAVE_ARMED_MS;
      if (this.#leaveTimer !== null) clearTimeout(this.#leaveTimer);
      this.#leaveTimer = setTimeout(() => this.#refresh(), LEAVE_ARMED_MS + 30);
      this.#refresh();
    });
    bar.append(leave);
    return bar;
  }

  #refresh(): void {
    if (this.#lastState && this.#lastHandlers) this.update(this.#lastState, this.#lastHandlers);
  }
}

/** Whether this player still has something to lose by getting up. */
function seatedAndAlive(view: ClientView): boolean {
  return view.players.some((player) => player.playerId === view.you.playerId && player.seated);
}

function sideLog(state: HudState): HTMLElement {
  const panel = el('div', 'hud-log');
  panel.setAttribute('aria-live', 'polite');
  const list = el('ol', 'log');
  for (const line of [...state.log].slice(-14).reverse()) {
    const item = el('li');
    for (const piece of line) {
      item.append(typeof piece === 'string' ? document.createTextNode(piece) : cardChip(piece.card));
    }
    list.append(item);
  }
  panel.append(list);
  return panel;
}

type Hint = 'none' | 'peek' | 'look' | 'steady';

function hintFor(state: HudState): Hint {
  const { view } = state;
  const inHand = view.hand?.seats.some(
    (seat) => seat.seatIndex === view.you.seatIndex && seat.inHand && !seat.folded,
  );
  if (!inHand) return 'none';
  if (!view.you.hasPeeked) return 'peek';
  if (!state.pointerLocked) return 'look';
  // Only once they have looked: the first thing to learn is the cards.
  if (!view.you.composure.challenge && view.serverTime >= view.you.composure.readyAt) return 'steady';
  return 'none';
}

function hintKey(state: HudState): string {
  return hintFor(state);
}

/**
 * The only thing left of the old card readout.
 *
 * Phase 3 printed the player's hand in the corner, because a card lying flat on
 * a dark table at this fidelity was guesswork. It is gone: the cards are on the
 * felt in front of them and they lift them to look, like everybody else at the
 * table, where everybody else can see them do it.
 *
 * What remains is a line telling a new player how, which disappears the moment
 * they have looked.
 */
function peekHint(state: HudState): HTMLElement {
  const box = el('div', 'hud-hint');
  switch (hintFor(state)) {
    case 'peek':
      box.append(el('span', 'hint-strong', 'Hold right-click or V, then pull toward you'));
      box.append(el('span', 'hint-quiet', 'They will see you do it.'));
      break;
    case 'look':
      box.append(el('span', 'hint-quiet', 'Click the table to look around freely'));
      break;
    case 'steady':
      box.append(el('span', 'hint-strong', 'B — steady yourself'));
      box.append(el('span', 'hint-quiet', 'It hides your heart; it does not slow it. They will see you do it.'));
      break;
    default:
      break;
  }
  return box;
}

function winnerBanner(view: ClientView, handlers: HudHandlers): HTMLElement | null {
  if (!view.winnerPlayerId) return null;
  const winner = view.players.find((p) => p.playerId === view.winnerPlayerId);
  const banner = el('div', 'hud-winner');
  banner.append(
    el('span', 'winner-line', `${winner?.displayName ?? 'Someone'} is the last one at the table.`),
    // A finished match used to be a room nobody could leave: the session
    // resumed into it on every reload until the server swept it away.
    button('Leave the table', 'primary', () => handlers.leave()),
  );
  return banner;
}

function waitingText(view: ClientView): string {
  if (view.you.legalActions) return '';
  if (view.room.status === 'FINISHED') return 'The game is over.';
  const acting = view.hand?.seats.find((s) => s.seatIndex === view.hand?.actingSeat);
  return acting ? `Waiting on ${acting.displayName}…` : 'Waiting…';
}

/** A button's label with the key that does the same thing beside it. */
function keyed(label: string, key: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = button(label, className, onClick);
  const cap = document.createElement('kbd');
  cap.textContent = key.toUpperCase();
  node.append(cap);
  return node;
}

function actionBar(state: HudState, handlers: HudHandlers): HTMLElement {
  const bar = el('div', 'hud-actions');
  const legal = state.view.you.legalActions;

  if (!legal) {
    bar.append(el('span', 'waiting', waitingText(state.view)));
    return bar;
  }

  const act = (label: string, key: string, action: PlayerAction, className: string) => {
    const node = keyed(label, key, className, () => handlers.submit(action));
    node.toggleAttribute('disabled', state.pendingAction);
    return node;
  };

  if (legal.canFold) bar.append(act('Fold', 'f', { type: 'FOLD' }, 'fold'));
  if (legal.canCheck) bar.append(act('Check', 'c', { type: 'CHECK' }, 'primary'));
  if (legal.canCall) bar.append(act(`Call ${chips(legal.callAmount)}`, 'c', { type: 'CALL' }, 'primary'));
  if (legal.canRaise) bar.append(raiseControls(legal, state, handlers));
  return bar;
}

function raiseControls(legal: LegalActions, state: HudState, handlers: HudHandlers): HTMLElement {
  const group = el('div', 'raise');

  if (legal.raiseIsAllInOnly) {
    const shove = keyed(`All in ${chips(legal.maxRaiseTo)}`, 'a', 'shove', () => handlers.submit({ type: 'ALL_IN' }));
    shove.toggleAttribute('disabled', state.pendingAction);
    group.append(shove);
    return group;
  }

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(legal.minRaiseTo);
  slider.max = String(legal.maxRaiseTo);
  slider.step = String(Math.max(1, state.view.level?.smallBlind ?? 1));
  slider.value = String(legal.minRaiseTo);
  slider.dataset.role = 'raise-amount';
  slider.setAttribute('aria-label', 'Raise to');

  const amount = el('span', 'amount', chips(legal.minRaiseTo));
  const sized = () => {
    amount.textContent = chips(Number(slider.value));
    // Touching the slider is touching your chips. What the table learns is that
    // your hands are on them, never for how much.
    handlers.handlingChips(true);
  };
  slider.addEventListener('input', sized);
  slider.addEventListener('pointerdown', sized);
  slider.addEventListener('pointerup', () => handlers.handlingChips(false));
  slider.addEventListener('blur', () => handlers.handlingChips(false));

  // Sizing a bet with the wheel, so a locked pointer can still do it.
  slider.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const step = Number(slider.step) || 1;
      const direction = event.deltaY < 0 ? 1 : -1;
      slider.value = String(Number(slider.value) + step * direction * 5);
      sized();
    },
    { passive: false },
  );

  // The sizes people actually bet, one press each. Measured against the pot as
  // it would stand after calling, which is what "pot" means to a poker player.
  const pot = state.view.hand?.potTotal ?? 0;
  const afterCall = pot + legal.callAmount;
  const presets = el('div', 'presets');
  const preset = (label: string, to: number): void => {
    const clamped = Math.min(Math.max(Math.round(to), legal.minRaiseTo), legal.maxRaiseTo);
    const node = button(label, 'preset', () => {
      slider.value = String(clamped);
      sized();
    });
    presets.append(node);
  };
  preset('min', legal.minRaiseTo);
  preset('½ pot', legal.currentBet + afterCall * 0.5);
  preset('pot', legal.currentBet + afterCall);

  const confirm = keyed(legal.raiseActionType === 'BET' ? 'Bet' : 'Raise to', 'r', 'primary', () =>
    handlers.submit({ type: legal.raiseActionType, to: Number(slider.value) } as PlayerAction),
  );
  const shove = keyed('All in', 'a', 'shove', () => handlers.submit({ type: 'ALL_IN' }));
  for (const node of [confirm, shove]) node.toggleAttribute('disabled', state.pendingAction);

  group.append(confirm, amount, slider, presets, shove);
  return group;
}

/**
 * Turns a key press into the action it stands for.
 *
 * Returns null when nothing is bound, when the key would be illegal right now,
 * or when the player is typing. Raise-to uses whatever the slider is sized at,
 * which is the same thing the button would have submitted.
 */
export function actionForKey(
  key: string,
  legal: LegalActions | null,
  raiseTo: number | null,
): PlayerAction | null {
  if (!legal) return null;
  const wanted = ACTION_KEYS[key.toLowerCase()];
  if (!wanted) return null;

  switch (wanted) {
    case 'FOLD':
      return legal.canFold ? { type: 'FOLD' } : null;
    case 'CHECK':
      // One key for the pair, because they are never both legal.
      if (legal.canCheck) return { type: 'CHECK' };
      return legal.canCall ? { type: 'CALL' } : null;
    case 'CALL':
      return legal.canCall ? { type: 'CALL' } : null;
    case 'ALL_IN':
      return legal.canRaise || legal.canCall ? { type: 'ALL_IN' } : null;
    case 'RAISE': {
      if (!legal.canRaise || legal.raiseIsAllInOnly) return null;
      const to = raiseTo ?? legal.minRaiseTo;
      const clamped = Math.min(Math.max(to, legal.minRaiseTo), legal.maxRaiseTo);
      return { type: legal.raiseActionType, to: clamped } as PlayerAction;
    }
  }
}
