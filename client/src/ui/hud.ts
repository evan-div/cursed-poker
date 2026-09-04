import type { ClientView, LegalActions, PlayerAction } from '@cursed/shared';
import { button, chips, countdown, el } from './dom.js';
import { cardElement, placeholderCard } from '../cards.js';

/**
 * The overlay sitting on top of the table.
 *
 * Kept in DOM rather than drawn in 3D: text in a WebGL scene is expensive,
 * blurry and awkward to click, and a bet slider is a bet slider. What belongs in
 * the world — cards, chips, hands, the Dealer — is in the world.
 *
 * Nothing here decides anything. The action bar exists only when the server sent
 * `legalActions`, and its buttons are whatever the server said were legal.
 */

export interface HudHandlers {
  submit: (action: PlayerAction) => void;
}

export interface HudState {
  view: ClientView;
  log: string[];
  connected: boolean;
  pendingAction: boolean;
}

export function renderHud(state: HudState, handlers: HudHandlers): HTMLElement {
  const hud = el('div', 'hud');
  hud.append(topBar(state), sideLog(state), holeCards(state.view), actionBar(state, handlers));
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
 * A small readout of the player's own cards.
 *
 * Temporary. The cards are already on the table in front of them, but until
 * Phase 4 gives them a way to physically lift the corners, reading a card at
 * this fidelity across a dim table is guesswork. This goes away when peeking
 * arrives.
 */
function holeCards(view: ClientView): HTMLElement {
  const box = el('div', 'hud-hole');
  const cards = el('div', 'hole-cards');
  if (view.you.holeCards) {
    for (const card of view.you.holeCards) cards.append(cardElement(card, 'small'));
  } else {
    cards.append(placeholderCard(), placeholderCard());
  }
  box.append(cards);
  return box;
}

function winnerBanner(view: ClientView): HTMLElement {
  const winner = view.players.find((p) => p.playerId === view.winnerPlayerId);
  return el('div', 'hud-winner', `${winner?.displayName ?? 'Someone'} is the last one at the table.`);
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

  if (legal.canFold) bar.append(act('Fold', { type: 'FOLD' }, 'fold'));
  if (legal.canCheck) bar.append(act('Check', { type: 'CHECK' }, 'primary'));
  if (legal.canCall) bar.append(act(`Call ${chips(legal.callAmount)}`, { type: 'CALL' }, 'primary'));
  if (legal.canRaise) bar.append(raiseControls(legal, state, handlers));
  return bar;
}

function raiseControls(legal: LegalActions, state: HudState, handlers: HudHandlers): HTMLElement {
  const group = el('div', 'raise');

  if (legal.raiseIsAllInOnly) {
    const shove = button(`All in ${chips(legal.maxRaiseTo)}`, 'shove', () =>
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

  const amount = el('span', 'amount', chips(legal.minRaiseTo));
  slider.addEventListener('input', () => (amount.textContent = chips(Number(slider.value))));

  const confirm = button(legal.raiseActionType === 'BET' ? 'Bet' : 'Raise to', 'primary', () =>
    handlers.submit({ type: legal.raiseActionType, to: Number(slider.value) } as PlayerAction),
  );
  const shove = button('All in', 'shove', () => handlers.submit({ type: 'ALL_IN' }));
  for (const node of [confirm, shove]) node.toggleAttribute('disabled', state.pendingAction);

  group.append(confirm, amount, slider, shove);
  return group;
}
