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

**Phase 1 complete — the poker engine.** No-Limit Hold'em for 4-6 players with
side pots, split pots, correct raise-reopening rules, big-blind antes, button
rotation and blind progression. 101 tests, including 140 fuzzed whole matches and
a shuffle fairness suite.

Nothing is networked or rendered yet, by design — see [docs/ROADMAP.md](docs/ROADMAP.md).

## Layout

```
shared/   card encoding, poker vocabulary, blind structures, tuning constants
server/   authoritative simulation
  poker/  the engine — no I/O, no framework, no horror
tests/    whole-match fuzzing, shuffle fairness
docs/     architecture and roadmap
```

## Commands

```bash
npm install
npm test          # full suite
npm run typecheck
npm run sim       # whole-match fuzzing only
```

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, networking choice,
  authority split, state machines, risks, open decisions
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased implementation checklist
