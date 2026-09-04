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
client/   developer UI (Three.js replaces it in Phase 3)
tests/    whole-match fuzzing, shuffle fairness, end-to-end integration
docs/     architecture and roadmap
```

## Playing it

```bash
npm install
npm run dev:server    # authoritative server on :3001
npm run dev:client    # dev UI on :5173
```

Open :5173 in four to six tabs. One player creates a lobby, the others join with
the code, everyone readies up, the host begins.

## Commands

```bash
npm test          # full suite
npm run typecheck
npm run sim       # whole-match fuzzing only
```

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, networking choice,
  authority split, state machines, risks, open decisions
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased implementation checklist
