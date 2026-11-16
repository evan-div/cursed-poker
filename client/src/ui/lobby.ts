import { MAX_PLAYERS, MIN_PLAYERS, parseRoomCode, type ClientView } from '@cursed/shared';
import { button, el, input } from './dom.js';

/**
 * Everything before the first card.
 *
 * Stays plain DOM: the 3D table is for the game, and a lobby is a form. It is
 * the first thing anybody sees, though, so it is the room's front door rather
 * than a settings page — the same lamp, the same baize, seen from the hall.
 */

export interface LobbyHandlers {
  createLobby: (displayName: string) => void;
  joinLobby: (code: string, displayName: string) => void;
  setReady: (ready: boolean) => void;
  start: () => void;
  /** Leave the lobby and go back to the door. */
  leave: () => void;
}

const NAME_KEY = 'cursed-poker.name';

/**
 * An invitation: this page's own address with the lobby's code after the `#`.
 *
 * After the hash rather than in the path or the query, so it never reaches a
 * server, a proxy's access log or a `Referer` header. A lobby code is the only
 * thing between a stranger and a private game.
 */
export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}#${code}`;
}

/** The code in the address this page was opened with, if it was an invitation. */
export function invitedTo(): string | null {
  return parseRoomCode(decodeURIComponent(location.hash.replace(/^#/, '')));
}

/** The masthead both screens share. */
function masthead(): HTMLElement {
  const head = el('header', 'masthead');
  head.append(el('span', 'suit', '♠'), el('h1', '', 'Cursed Poker'), el('p', 'lede', 'Sit down. The Dealer is waiting.'));
  return head;
}

/** What to press. The table explains itself as you go; this is the short version. */
function controls(): HTMLElement {
  const box = el('details', 'controls');
  box.append(el('summary', '', 'How to play'));
  const list = el('dl');
  for (const [key, what] of [
    ['Click, then mouse', 'look around the table'],
    ['Hold V or right-click, pull back', 'lift your cards — everyone sees you do it'],
    ['Mouse wheel', 'lean in'],
    ['F · C · R · A', 'fold · check or call · raise · all in'],
    ['B, then Space', 'steady yourself'],
    ['Esc', 'let go of the mouse'],
  ] as const) {
    list.append(el('dt', '', key), el('dd', '', what));
  }
  box.append(list);
  return box;
}

export function renderLanding(handlers: LobbyHandlers): HTMLElement {
  const screen = el('div', 'front');
  const panel = el('section', 'panel landing');

  const name = input({
    placeholder: 'Your name',
    maxLength: 20,
    value: localStorage.getItem(NAME_KEY) ?? '',
    onInput: (value) => localStorage.setItem(NAME_KEY, value),
  });
  name.setAttribute('aria-label', 'Your name');
  name.setAttribute('autocomplete', 'nickname');

  // Opened from an invitation: the code is already filled in, and all that is
  // left to type is a name.
  const invited = invitedTo();
  const code = input({ placeholder: 'Lobby code', maxLength: 6, className: 'code-input', value: invited ?? '' });
  code.setAttribute('aria-label', 'Lobby code');
  code.setAttribute('autocomplete', 'off');
  code.spellcheck = false;

  const join = () => handlers.joinLobby(code.value.trim(), name.value.trim());
  const create = () => handlers.createLobby(name.value.trim());
  // Enter does the obvious thing: joins if there is a code, opens a table if not.
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') (code.value.trim() ? join : create)();
  });
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });

  const row = el('div', 'row');
  row.append(code, button('Join', '', join));

  if (invited) {
    // Joining is the point of the visit, so it comes first and is the big one.
    const enter = button(`Join ${invited}`, 'primary', join);
    panel.append(
      el('p', 'hint invited', 'You have been asked to a table.'),
      name,
      enter,
      el('div', 'divider', 'or'),
      button('Create a lobby of your own', '', create),
    );
    code.hidden = true;
    panel.append(code);
  } else {
    panel.append(name, button('Create lobby', 'primary', create), el('div', 'divider', 'or join one'), row);
  }
  screen.append(masthead(), panel, controls());
  // Straight to the one thing left to fill in.
  queueMicrotask(() => name.focus());
  return screen;
}

export function renderLobby(view: ClientView, handlers: LobbyHandlers): HTMLElement {
  const screen = el('div', 'front');
  const panel = el('section', 'panel lobby-panel');

  // Kept as "Lobby CODE" in one heading: the scripts in `scripts/` read it.
  panel.append(el('h2', '', `Lobby ${view.room.code}`));

  const share = el('div', 'share');
  const codeBox = el('button', 'code', view.room.code);
  codeBox.setAttribute('title', 'Copy an invitation link');
  codeBox.addEventListener('click', () => {
    // The link, not the bare code: whoever is sent it has one thing to click
    // and nothing to type but their name.
    void navigator.clipboard?.writeText(inviteLink(view.room.code)).then(
      () => {
        codeBox.classList.add('copied');
        setTimeout(() => codeBox.classList.remove('copied'), 1_200);
      },
      () => {},
    );
  });
  share.append(codeBox, el('span', 'hint', 'Click to copy a link the others can open.'));
  panel.append(share);

  const list = el('ul', 'players');
  for (const player of view.players) {
    const item = el('li', player.ready ? 'ready' : '');
    item.append(el('span', 'flame'), el('span', 'name', player.displayName));
    if (player.isHost) item.append(el('span', 'tag', 'host'));
    if (!player.connected) item.append(el('span', 'tag warn', 'away'));
    item.append(el('span', 'tick', player.ready ? 'ready' : 'waiting'));
    list.append(item);
  }
  // The chairs nobody is in yet.
  for (let seat = view.players.length; seat < MAX_PLAYERS; seat++) {
    const item = el('li', 'empty');
    item.append(el('span', 'flame'), el('span', 'name', seat < MIN_PLAYERS ? 'an empty chair' : 'room for one more'));
    list.append(item);
  }
  panel.append(list);

  const needed = Math.max(0, MIN_PLAYERS - view.players.length);
  const waiting = view.players.filter((player) => !player.ready).length;
  panel.append(
    el(
      'p',
      'hint',
      needed > 0
        ? `${view.players.length} seated · needs ${needed} more to begin · seats ${MAX_PLAYERS}`
        : waiting > 0
          ? `${view.players.length} seated · waiting on ${waiting} to be ready`
          : `${view.players.length} seated · everyone is ready`,
    ),
  );

  const me = view.players.find((p) => p.playerId === view.you.playerId);
  const actions = el('div', 'lobby-actions');
  actions.append(
    button(me?.ready ? 'Not ready' : 'Ready', me?.ready ? '' : 'primary', () => handlers.setReady(!me?.ready)),
  );

  if (me?.isHost) {
    const canStart = view.players.length >= MIN_PLAYERS && view.players.every((p) => p.ready);
    const start = button('Begin the game', 'primary', () => handlers.start());
    start.toggleAttribute('disabled', !canStart);
    actions.append(start);
  }
  actions.append(button('Leave', 'quiet', () => handlers.leave()));
  panel.append(actions);

  screen.append(masthead(), panel, controls());
  return screen;
}
