import type { ClientView, LegalActions, PlayerAction } from '@cursed/shared';
import { button, chips, countdown, el } from './dom.js';

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
}

export interface HudState {
  view: ClientView;
  log: string[];
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

export function renderHud(state: HudState, handlers: HudHandlers): HTMLElement {
  const hud = el('div', 'hud');
  hud.append(topBar(state), sideLog(state), peekHint(state), actionBar(state, handlers));
  if (state.view.winnerPlayerId) hud.append(winnerBanner(state.view));
  return hud;
}

function topBar(state: HudState): HTMLElement {
  const bar = el('div', 'hud-top');
  const { view } = state;
  bar.append(el('span', 'brand', 'CURSED POKER'));
  bar.append(el('span', 'room', view.room.code));
  if (view.level) {
    bar.append(
      el(
        'span',
        'level',
        `L${view.level.level} · ${chips(view.level.smallBlind)}/${chips(view.level.bigBlind)}` +
          (view.level.ante > 0 ? ` · ante ${chips(view.level.ante)}` : ''),
      ),
    );
    bar.append(el('span', 'clock', countdown(view.level.endsAt)));
  }
  if (view.hand) bar.append(el('span', 'pot', `pot ${chips(view.hand.potTotal)}`));
  bar.append(
    el('span', `status ${state.connected ? 'up' : 'down'}`, state.connected ? '' : 'offline'),
  );
  return bar;
}

function sideLog(state: HudState): HTMLElement {
  const panel = el('div', 'hud-log');
  const list = el('ol', 'log');
  for (const line of [...state.log].slice(-14).reverse()) list.append(el('li', '', line));
  panel.append(list);
  return panel;
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
  const { view } = state;

  const inHand = view.hand?.seats.some(
    (seat) => seat.seatIndex === view.you.seatIndex && seat.inHand && !seat.folded,
  );
  if (!inHand) return box;

  if (!view.you.hasPeeked) {
    box.append(el('span', 'hint-strong', 'Hold right-click or V, then pull toward you'));
    box.append(el('span', 'hint-quiet', 'They will see you do it.'));
  } else if (!state.pointerLocked) {
    box.append(el('span', 'hint-quiet', 'Click the table to look around freely'));
  }
  return box;
}

function winnerBanner(view: ClientView): HTMLElement {
  const winner = view.players.find((p) => p.playerId === view.winnerPlayerId);
  return el('div', 'hud-winner', `${winner?.displayName ?? 'Someone'} is the last one at the table.`);
}

/** Shows the key that does the same thing, for a player who cannot click. */
function withKey(label: string, key: string): string {
  return `${label} [${key.toUpperCase()}]`;
}

function actionBar(state: HudState, handlers: HudHandlers): HTMLElement {
  const bar = el('div', 'hud-actions');
  const legal = state.view.you.legalActions;

  if (!legal) {
    const acting = state.view.hand?.seats.find((s) => s.seatIndex === state.view.hand?.actingSeat);
    bar.append(
      el(
        'span',
        'waiting',
        state.view.room.status === 'FINISHED'
          ? 'The game is over.'
          : acting
            ? `Waiting on ${acting.displayName}…`
            : 'Waiting…',
      ),
    );
    return bar;
  }

  const act = (label: string, action: PlayerAction, className: string) => {
    const node = button(label, className, () => handlers.submit(action));
    node.toggleAttribute('disabled', state.pendingAction);
    return node;
  };

  if (legal.canFold) bar.append(act(withKey('Fold', 'f'), { type: 'FOLD' }, 'fold'));
  if (legal.canCheck) bar.append(act(withKey('Check', 'c'), { type: 'CHECK' }, 'primary'));
  if (legal.canCall) {
    bar.append(act(withKey(`Call ${chips(legal.callAmount)}`, 'c'), { type: 'CALL' }, 'primary'));
  }
  if (legal.canRaise) bar.append(raiseControls(legal, state, handlers));
  return bar;
}

function raiseControls(legal: LegalActions, state: HudState, handlers: HudHandlers): HTMLElement {
  const group = el('div', 'raise');

  if (legal.raiseIsAllInOnly) {
    const shove = button(withKey(`All in ${chips(legal.maxRaiseTo)}`, 'a'), 'shove', () =>
      handlers.submit({ type: 'ALL_IN' }),
    );
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

  const confirm = button(
    withKey(legal.raiseActionType === 'BET' ? 'Bet' : 'Raise to', 'r'),
    'primary',
    () => handlers.submit({ type: legal.raiseActionType, to: Number(slider.value) } as PlayerAction),
  );
  const shove = button(withKey('All in', 'a'), 'shove', () => handlers.submit({ type: 'ALL_IN' }));
  for (const node of [confirm, shove]) node.toggleAttribute('disabled', state.pendingAction);

  group.append(confirm, amount, slider, shove);
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
