# Implementation Roadmap

Ordered so that there is a **playable build as early as possible**, and so each
phase can be tested before the next one leans on it. Nothing here is built ahead
of the phase that needs it.

---

## Phase 1 — Poker engine ✅ complete

- [x] Card encoding, deck, CSPRNG-backed Fisher-Yates shuffle
- [x] Hand evaluator (fast) + independent reference evaluator (tests)
- [x] Cross-validation: 200,000 random 7-card hands, 50,000 matchups
- [x] Blinds, big-blind antes, partial/all-in blind posting
- [x] Betting: check, bet, call, raise, fold, all-in
- [x] Minimum-raise maths and raise-reopening rules (incl. undersized all-ins)
- [x] Side pots, split pots, dead money, uncalled-bet return, odd chips
- [x] Community cards with burns; automatic run-out when everyone is all-in
- [x] Showdown, hand ranking, payout, winning-five-cards reporting
- [x] 4-6 players, 100BB starting stacks
- [x] Button rotation and blind progression (`table.ts`)
- [x] First-orbit tracker (`orbit.ts`)
- [x] Between-hands seam: `grantChips` / `eliminate` / `bustedSeats`
- [x] Whole-match fuzzing: 140 matches, invariants after every action
- [x] Shuffle fairness tests (chi-square, permutation coverage, deal uniformity)
- [x] Chip conservation asserted at runtime, not just in tests

**101 tests. No 3D, no network, no browser.**

---

## Phase 2 — Online private lobby

The goal is a **complete, playable poker game through a plain developer UI**
before any Three.js work begins.

- [ ] `/shared/messages.ts` — client↔server message schema + runtime validation
- [ ] `Transport` interface; Socket.IO implementation behind it
- [ ] `RoomManager` — private lobbies, invite codes with real entropy, join rate limiting
- [ ] `SessionManager` — signed, room-bound, unguessable session tokens
- [ ] `MatchController` — the outer state machine; owns the clock and the loop
- [ ] **`projection.ts` — the single hidden-information boundary** (+ its own test suite)
- [ ] Seat assignment, ready-up, match start at 4-6 players
- [ ] Reconnect: resume the same seat, restore the same hole cards
- [ ] Disconnect policy: auto-check/fold on timeout, seat preserved
- [ ] Per-socket action rate limiting
- [ ] Minimal HTML dev UI: stacks, board, pot, action buttons, log
- [ ] Integration test: a full 6-player match driven through the real transport

**Exit criteria:** six people in different browsers finish a whole tournament,
disconnect and rejoin mid-match, and nobody can see anyone else's cards.

---

## Phase 3 — The 3D table

- [ ] Scene bootstrap: Vite + Three.js client, shared types wired in
- [ ] Poker table, six seats, room shell
- [ ] Placeholder human avatars (head, torso, arms, hands with individual fingers)
- [ ] Placeholder Dealer volume
- [ ] Card and chip rendering; community card area; pot display
- [ ] Seated first-person camera with free-look
- [ ] Empty-chair state for departed players
- [ ] **Performance budget established here**: draw calls, shadow-casting lights,
      shared skeleton/mesh strategy for six animated humanoids

---

## Phase 4 — Physical interactions

- [ ] Progressive analog card peek (hold + move; exposure tracks input)
- [ ] Owner-only card faces; abstracted peek pose replicated to opponents
- [ ] Gaze direction as replicated input
- [ ] Visible card-check behaviour on other avatars
- [ ] Betting and chip interactions
- [ ] Camera attention bias — soft pull toward the acting player, instantly
      overridden by any deliberate look

---

## Phase 5 — The Dealer and atmosphere

- [ ] Dealer model: tall, hooded, face lost in black, two dim red eyes
- [ ] Deal / watch / lean / rise animation set
- [ ] Independent head tracking; unnatural stillness; occasional twitch
- [ ] Lighting pass; positional audio foundation
- [ ] `HorrorDirector` v1 driven by player count, elapsed time, sacrifices, eliminations

---

## Phase 6 — Heart rate and tells

- [ ] Server-side stress model with named stress events
- [ ] First-person feedback: heartbeat, breathing, tremor, camera instability,
      tunnel vision, unsteady peeking
- [ ] Server-derived third-person tell state (`tremor`, `breathing`, `sweat`, …)
- [ ] Avatar tell visualization
- [ ] Telemetry/replay harness so tuning is data-driven

---

## Phase 7 — Composure

- [ ] `ComposureChallenge` interface (issue → input → server-validated result)
- [ ] One prototype minigame behind it
- [ ] Success reduces visible tells; failure temporarily worsens them
- [ ] Verify a second minigame can be swapped in without touching the stress model

---

## Phase 8 — First orbit and perks

- [ ] Wire `orbit.ts` into `MatchController`
- [ ] `PERK_RITUAL` state; blind clock pauses
- [ ] Dealer ritual presentation
- [ ] Three private perk offers per player, drawn per-player
- [ ] `PerkManager` as composable modifiers on stress / composure / tells / perception
- [ ] Prototype perks: Stoic, Liar, Coward, Gambler, Martyr, Corpse
- [ ] Test: no perk can reach deck, cards, or hand ranking

---

## Phase 9 — Sacrifices

- [ ] `SACRIFICE_WINDOW` in `BETWEEN_HANDS`
- [ ] Eligibility: busted, or voluntary below 20BB; max 3 per player
- [ ] Chip grant in big blinds via `grantChips`
- [ ] Permanent per-player body state
- [ ] Presentation: palm slice → finger removal → tooth extraction
- [ ] Persistent consequences: four-fingered hand rig, blood on cards/chips/table
- [ ] Dealer's growing trophy collection

---

## Phase 10 — Permanent elimination

- [ ] Bust with no sacrifices left → elimination sequence
- [ ] Dealer rises, approaches, takes the player into the dark
- [ ] Eliminated player keeps a first-person camera through it
- [ ] Others witness it from their seats
- [ ] Chair stays empty; match continues
- [ ] **Eliminated players receive the public projection only**

---

## Phase 11 — Full horror arc

- [ ] Escalation tiers driven by survivors, time, sacrifices, eliminations
- [ ] Environmental deterioration; accumulated blood and damage
- [ ] Distinct heads-up state: room contracts, darkness closes in, ambience
      strips back, Dealer moves close, heartbeat dominates
- [ ] Placeholder final-survivor sequence

---

## Running the current build

```bash
npm install
npm test          # 101 tests
npm run typecheck
npm run sim       # whole-match fuzzing only
```
