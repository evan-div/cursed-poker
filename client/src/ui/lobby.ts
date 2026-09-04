import { MIN_PLAYERS, type ClientView } from '@cursed/shared';
import { button, el, input } from './dom.js';

/**
 * Everything before the first card.
 *
 * Stays plain DOM: the 3D table is for the game, and a lobby is a form.
 */

export interface LobbyHandlers {
  createLobby: (displayName: string) => void;
  joinLobby: (code: string, displayName: string) => void;
  setReady: (ready: boolean) => void;
  start: () => void;
}

const NAME_KEY = 'cursed-poker.name';

export function renderLanding(handlers: LobbyHandlers): HTMLElement {
  const panel = el('section', 'panel landing');
  panel.append(el('p', 'lede', 'Sit down. The Dealer is waiting.'));

  const name = input({
    placeholder: 'Your name',
    maxLength: 20,
    value: localStorage.getItem(NAME_KEY) ?? '',
    onInput: (value) => localStorage.setItem(NAME_KEY, value),
  });

  const code = input({ placeholder: 'Lobby code', maxLength: 6, className: 'code-input' });

  const row = el('div', 'row');
  row.append(
    code,
    button('Join', '', () => handlers.joinLobby(code.value.trim(), name.value.trim())),
  );

  panel.append(
    name,
    button('Create lobby', 'primary', () => handlers.createLobby(name.value.trim())),
    el('div', 'divider', 'or'),
    row,
  );
  return panel;
}

export function renderLobby(view: ClientView, handlers: LobbyHandlers): HTMLElement {
  const panel = el('section', 'panel lobby-panel');
  panel.append(el('h2', '', `Lobby ${view.room.code}`));
  panel.append(
    el('p', 'hint', `${view.players.length} seated · needs ${MIN_PLAYERS} to begin · seats 6`),
  );

  const list = el('ul', 'players');
  for (const player of view.players) {
    const item = el('li', player.ready ? 'ready' : '');
    item.append(el('span', 'name', player.displayName));
    if (player.isHost) item.append(el('span', 'tag', 'host'));
    if (!player.connected) item.append(el('span', 'tag warn', 'away'));
    item.append(el('span', 'tick', player.ready ? 'ready' : 'waiting'));
    list.append(item);
  }
  panel.append(list);

  const me = view.players.find((p) => p.playerId === view.you.playerId);
  panel.append(
    button(me?.ready ? 'Not ready' : 'Ready', me?.ready ? '' : 'primary', () =>
      handlers.setReady(!me?.ready),
    ),
  );

  if (me?.isHost) {
    const canStart = view.players.length >= MIN_PLAYERS && view.players.every((p) => p.ready);
    const start = button('Begin the game', 'primary', () => handlers.start());
    start.toggleAttribute('disabled', !canStart);
    panel.append(start);
  }
  return panel;
}
