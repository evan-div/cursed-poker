# Cursed Poker

Last-man-standing supernatural Texas Hold'em for 4-6 friends, in the browser.

Players sit around a physical 3D table with a Dealer that is not a person. They
play legitimate poker, read each other's bodies, manage their own stress, and
spend pieces of themselves to stay in the game. One player walks away.

## The rule everything else obeys

**Poker is sacred.** The supernatural layer never touches the deck, the card
distribution, the hand rankings, or the pot. A royal flush is always a royal
flush. If someone wins a hand, they won it at poker.

Horror acts on stress, perception, tells, composure, appearance, sacrifice
resources and the room — never on what cards exist. This is enforced
architecturally, not by discipline: the poker engine imports nothing from the
horror layer, and chips can only enter a stack from outside a pot **between
hands**, through one function.

## Status

**Phases 1-4 complete — four to six friends can sit at the table and play.**

- **The poker engine.** No-Limit Hold'em for 4-6 players: side pots, split pots,
  correct raise-reopening rules, big-blind antes, button rotation, blind
  progression. Pure, browser-free and framework-free.
- **Private lobbies over the wire.** Authoritative server, invite codes,
  reconnect that restores your seat and your cards, disconnect handling, rate
  limiting.
- **The table in 3D.** A round table of seven, six seated players and the hooded
  figure that deals to them, from a first-person seat you cannot get up from.
- **Bodies.** You lift your own cards to look at them, and everybody watches you
  do it. Where you look, how far you lifted, and whether your hands are on your
  chips all reach the rest of the table — and going quiet just makes you still.

255 tests, including 140 fuzzed whole matches, a shuffle fairness suite, and a
hidden-information suite that audits every player's view at every decision point.

The Dealer, the lighting, stress, tells, perks and sacrifices are still ahead —
see [docs/ROADMAP.md](docs/ROADMAP.md).

## Layout

```
shared/   card encoding, poker vocabulary, blind data, wire protocol, view types
server/   authoritative simulation
  poker/  the engine — no I/O, no framework, no horror
  match/  the outer state machine and the projection boundary
  net/    transport, sessions, rooms, rate limiting
client/   the table
  scene/  Three.js: layout, table, avatars, Dealer, cards, chips, camera
  ui/     DOM overlay: lobby, HUD, nameplates
tests/    whole-match fuzzing, shuffle fairness, end-to-end integration
docs/     architecture and roadmap
```

## Playing it

```bash
npm install
npm run dev
```

That starts both the server (:3001) and the dev UI (:5173) together, labels their
output, and stops both on Ctrl-C. Open <http://localhost:5173> in four to six
tabs — one player creates a lobby, the others join with the code, everyone
readies up, the host begins.

### At the table

| | |
|---|---|
| Look around | drag, or click the table for pointer lock (Escape releases) |
| **Look at your cards** | hold right-click or `V`, then pull the mouse toward you |
| Act | `F` fold · `C` check/call · `R` raise · `A` all in, or click |
| Size a bet | the slider, or the mouse wheel over it |

You will not see your own cards until you lift them. That is deliberate: the
look is the game. Everyone at the table can see you take it, and see how long
you spend, and see you take another one right after the flop.

To run them in separate terminals instead:

```bash
npm run dev:server    # authoritative server on :3001
npm run dev:client    # dev UI on :5173
```

Both are long-running, so each needs its own terminal — the server prints
`listening on :3001` and then stays in the foreground. That is success, not a
hang.

### If it does not connect

The UI says `offline` in the top right when the socket cannot reach the server.

- **Something else is on :5173 or :3001.** The dev UI now refuses to start on a
  different port rather than silently sliding to :5174 and failing to connect.
  Free the port (`lsof -ti:5173 | xargs kill`) or set `PORT` for the server and
  `VITE_SERVER_URL` for the client to match.
- **A stale server from a previous run.** `lsof -ti:3001 | xargs kill`.
- **Reconnect tokens stop working after a restart.** `npm run dev` generates a
  secret once into `.dev-session-secret` (gitignored) and reuses it, so lobbies
  survive the restarts that saving a file causes. Running the server on its own
  with `npm run dev:server` does not — set `SESSION_SECRET` yourself there.
- **The server restarts every few seconds on its own.** Fixed: `tsx watch` was
  following the workspace's hoisted `node_modules` and restarting on any change
  in it, which dropped every socket. If you see it again, check the `--exclude`
  flags on `@cursed/server`'s `dev` script.

`CLIENT_ORIGIN` restricts which browser origin may connect. Leave it unset in
development and any `localhost` origin is accepted; set it in production and only
that origin is.

## Commands

```bash
npm test          # full suite
npm run typecheck
npm run sim       # whole-match fuzzing only
npm run shots     # drive real browsers around the table and screenshot it
```

`npm run shots` needs `npm run dev` already running. In a development build the
browser console also has `__bodies()`, which reports what that client believes
every seat's body is doing — the room is dark and players block their own cards,
so replication is easier to check as numbers than as a picture.

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, networking choice,
  authority split, state machines, risks, open decisions
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased implementation checklist
