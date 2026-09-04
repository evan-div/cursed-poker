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

## Phase 2 — Online private lobby ✅ complete

The goal was a **complete, playable poker game through a plain developer UI**
before any Three.js work began.

- [x] `shared/messages.ts` — message schemas with runtime (zod) validation
- [x] `Transport` interface; Socket.IO implementation behind it
- [x] `RoomManager` — private lobbies, CSPRNG invite codes, join rate limiting
- [x] `SessionManager` — HMAC-signed, room-bound, expiring session tokens
- [x] `Match` — the outer state machine; owns the loop, the clocks and the timeouts
- [x] **`projection.ts` — the single hidden-information boundary**, with a test
      suite that is itself mutation-checked against a deliberate leak
- [x] Seat assignment, ready-up, host start at 4-6 players
- [x] Reconnect: same seat, same chips, same hole cards
- [x] Disconnect policy: shortened clock, auto-check/fold, seat preserved
- [x] Per-connection and per-address rate limiting
- [x] Dev UI: seats, board, pot, blind clock, hole cards, action bar, event log
- [x] Integration tests: whole matches driven through the real transport

**Exit criteria met.** Verified two ways: an automated 6-player match over real
Socket.IO, and four live Chromium browsers playing five hands through the dev
UI — creating a lobby, joining by code, readying up, acting, and surviving a
full page reload mid-match with the same seat and the same cards.

**55 new tests** (156 total).

---

## Phase 3 — The 3D table ✅ complete

- [x] Vite client workspace with shared types wired in (done in Phase 2)
- [x] Three.js scene replacing the dev UI; DOM kept for the lobby and HUD
- [x] Round table of seven stations, chairs, room shell, lighting
- [x] Placeholder human avatars: head, torso, arms, hands, **five separate fingers each**
- [x] Placeholder Dealer — hooded, taller than everyone, two red eyes, long hands
- [x] Cards from a runtime-generated atlas; chips as one instanced mesh; pot
- [x] Seated first-person camera with clamped free-look and a resting gaze
- [x] Empty-chair state for eliminated players
- [x] Nameplates projected from world space into the DOM overlay
- [x] **Performance budget established**: 173 draw calls and 8.3k triangles at
      six players, growing ~21 draw calls per seat (see ARCHITECTURE §15)
- [x] `npm run shots` — drives real browsers around the table and screenshots it

Deliberately left for later: lighting is a readable placeholder, not the
oppressive room the brief describes (Phase 5), faces are featureless, and nothing
animates yet (Phase 6).

**29 new tests** (185 total).

---

## Phase 4 — Physical interactions ✅ complete

- [x] Pointer lock revisited: offered on click, released on Escape, drag-look
      still works unlocked, and every action has a key so a locked player never
      has to leave the room to bet
- [x] Progressive analog card peek — hold right-click or `V`, pull toward you;
      exposure tracks input continuously and a released card falls
- [x] **Hole cards arrive when you look at them**, not at the deal. The gesture
      is load-bearing rather than decorative, and a client that never peeks never
      receives the cards
- [x] Owner-only card faces; the peek *pose* replicated, never the card
- [x] Gaze as a replicated input — a subject (`seat 4`, `own cards`, `the pot`),
      not a vector, so tell-reading stays a human skill
- [x] `presence` as a second server channel at 12 Hz, with no per-viewer half
- [x] Silence replicated as stillness: not reporting is not a way to hide
- [x] Avatars turn their heads toward what their owner is looking at, and lean
      over their cards as they lift them
- [x] Camera attention bias — a soft pull toward the acting player, a raise, a
      showdown; instantly and completely surrendered to any deliberate look
- [x] Betting: keyboard bindings, wheel sizing, and "hands on chips" replicated
      as a tell without ever replicating the amount
- [x] The Phase 3 HUD card readout removed — the cards are on the table now

**70 new tests** (255 total), and a `__bodies()` dev hook, because two of this
phase's three real bugs were invisible in a screenshot.

---

## Phase 5 — The Dealer and atmosphere

- [ ] Dealer model: tall, hooded, face lost in black, two dim red eyes
- [ ] Lighting that lets a lifted card be read without flattening the room —
      the current lamp leaves a steeply tilted card in its own shadow
- [ ] Deal / watch / lean / rise animation set
- [ ] Independent head tracking; unnatural stillness; occasional twitch
- [ ] Lighting pass; positional audio foundation
- [ ] `HorrorDirector` v1 driven by player count, elapsed time, sacrifices, eliminations

---

## Phase 6 — Heart rate and tells

- [ ] Server-side stress model with named stress events
- [ ] Feed tremor into `PeekGesture`'s `unsteadiness`, which is wired and inert
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
npm test              # 255 tests
npm run typecheck
npm run sim           # whole-match fuzzing only
```

To actually play:

```bash
npm run dev           # server on :3001 and table on :5173, together
npm run dev:fast      # short stacks and quick clocks, for reaching eliminations
```

Open <http://localhost:5173> in four to six tabs or browsers. One creates a
lobby, the rest join with the code, everyone readies up, the host begins. Set
`SESSION_SECRET` to keep reconnect tokens working across a server restart. See
the README for what to check if the UI shows `offline`.

At the table:

| | |
|---|---|
| Look around | drag, or click the table for pointer lock (Escape releases) |
| **Look at your cards** | hold right-click or `V`, then pull the mouse toward you |
| Act | `F` fold · `C` check/call · `R` raise · `A` all in, or click |
| Size a bet | the slider, or the mouse wheel over it |

You will not see your own cards until you lift them, and everyone else can see
you do it.
