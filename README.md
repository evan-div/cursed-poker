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

**Phases 1 and 2 complete — the game is playable online.**

- **The poker engine.** No-Limit Hold'em for 4-6 players: side pots, split pots,
  correct raise-reopening rules, big-blind antes, button rotation, blind
  progression. Pure, browser-free and framework-free.
- **Private lobbies over the wire.** Authoritative server, invite codes,
  reconnect that restores your seat and your cards, disconnect handling, rate
  limiting, and a plain developer UI you can finish a whole tournament in.

156 tests, including 140 fuzzed whole matches, a shuffle fairness suite, and a
hidden-information suite that audits every player's view at every decision point.

Nothing is rendered in 3D yet, by design — see [docs/ROADMAP.md](docs/ROADMAP.md).

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
- **Reconnect tokens stop working after a restart.** Expected: without
  `SESSION_SECRET` the server generates a random one at boot. Set it to keep
  sessions across restarts.

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

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, networking choice,
  authority split, state machines, risks, open decisions
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased implementation checklist
