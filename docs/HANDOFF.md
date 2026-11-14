# Handoff — start here

Read this first in a new session. It is the state of the project, the rules
that are not negotiable, how the code is laid out, what is next, and what is
waiting on a decision. `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` are the
long-form versions; this is the map.

---

## 0. Before anything else

**Work on branch `claude/vigilant-bell-l3ldus`.** It is not the repository's
default branch. The default is `claude/horror-poker-game-design-q6hdzf`, which
stops after Phase 2. `claude/horror-holdem-phase-4-w9umnr` carries Phases 3–7,
and `claude/vigilant-bell-l3ldus` is that plus the November audit: sixteen bug
fixes and the whole visual overhaul. Each fully contains the one before. There
is no `main` and no open pull request.

**Read `docs/AUDIT.md` next.** It is what was found wrong, what was fixed, what
the game looks like now, and — in §5 — what is still owed, in order.

```bash
git fetch origin claude/vigilant-bell-l3ldus
git checkout claude/vigilant-bell-l3ldus
npm install
npm run typecheck     # clean
npm test              # 575 tests, 46 files, all passing
npm audit             # 0
```

If those two commands are not clean on a fresh clone, stop and find out why
before changing anything.

---

## 1. What this is

**Cursed Poker**: last-man-standing supernatural Texas Hold'em for 4–6 friends
in the browser. A first-person seat at a round 3D table, a hooded Dealer that
is not a person, real No-Limit Hold'em underneath. Players read each other's
bodies, manage their own fear, and (later phases) spend pieces of themselves
to stay in. 100BB stacks, 60–90 minute matches.

TypeScript monorepo, npm workspaces:

| | |
|---|---|
| `shared/` | wire protocol (zod schemas), view types, constants: cards, blinds, presence, dealer, stress, composure |
| `server/` | authoritative simulation. `poker/` is the pure engine; `match/` is the outer state machine and the projection boundary; `net/` is transport, sessions, rooms |
| `client/` | Three.js scene (`scene/`), DOM overlay (`ui/`), input (`interaction/`), audio (`audio/`), first-person feel (`feel/`) |
| `docs/` | this file, `AUDIT.md`, `ARCHITECTURE.md`, `ROADMAP.md` |
| `tests/` | whole-match fuzzing, shuffle fairness, end-to-end over real Socket.IO |
| `scripts/` | dev runner, browser screenshot/check scripts, the stress report |

About 29k lines of TypeScript. Vite, Vitest, tsx, Socket.IO, Three.js, zod.

**Nothing is loaded.** No models, no images, no sound files: every surface is
painted into a canvas at start-up and every solid is turned, welded or sculpted
from numbers. That is a rule of the house, not an accident — keep it.

---

## 2. The rules — do not break these

1. **Poker is sacred.** Nothing supernatural touches deck order, the shuffle,
   card distribution, hand rankings, community cards or pot outcomes. Chips
   enter a stack from outside a pot only between hands, through `grantChips`.
2. **The server is authoritative** for the deck, hole cards, turns, betting,
   pots, showdown, eliminations, stress, tells, the Dealer, composure, and who
   may know what.
3. **`server/src/match/projection.ts` is the only module that turns match
   state into bytes a client receives.** It has three exits: `projectForViewer`
   (the per-player view), `presenceFrame` (the public body broadcast) and
   `selfFrame` (your own heart, owner-only). A fourth path is a design
   regression, not a feature.
4. **Hole cards go only to their owner, and only once they have physically
   looked.** Deck order is never exposed.
5. **Stress may not read a card** — not a hole card, a ranking, an equity or a
   draw. Tells are broadcast; a tell that rose with hand strength would be a
   decoder for hole cards. `stress-boundary.test.ts` deals two tables
   different decks under one script and requires every heart rate and tell to
   match while a hand is live.
6. **Separate sources of chance.** The deck, the Dealer and composure each
   have their own `RandomSource`. None may draw from another's.
7. **Anything broadcast is quantised or reduced to the coarsest thing that is
   still a tell.** Tremor and breathing go out on an 8-step grid; gaze is a
   subject (`seat 4`, `own cards`), not a vector; composing is one bit.
8. **The poker engine (`server/src/poker/`) imports nothing from the horror
   layer, and nothing from Three.js.**

The protocol has **allowlist tests** (`tests/integration.test.ts`,
`server/src/match/presence.test.ts`): adding a field to the presence frame
fails them until the field is added on purpose, with a comment saying why it
is safe. That is the intended workflow.

---

## 3. How the server talks to clients

Three channels from server to client, one direction each:

| Channel | Who gets it | When | Carries |
|---|---|---|---|
| `view` | each player, their own | on every match change | the situation: seats, stacks, board, legal actions, **your** cards (once looked), your stress, your composure |
| `presence` | everyone, identical | 12 Hz | bodies: gaze, peek, lift, lean, chips-in-hand, stillness, `tells`, `composing`, the Dealer, the room's dread |
| `self` | each player, their own | 4 Hz | your heart rate and stress scalar — because views only move when poker does |

Client → server messages are all zod-validated before game code sees them:
`lobby:*`, `poker:action`, `poker:peek`, `player:presence` (15 Hz, separately
rate-limited), `composure:begin`, `composure:input`.

A private change to one player (starting or finishing a composure challenge)
is pushed to **that player only** via `Match#flushTo`. A view refreshing on
everyone's screen at that moment would itself be a leak.

---

## 4. Where things are

| System | Server | Client | Shared |
|---|---|---|---|
| Poker engine | `server/src/poker/` | — | `poker-types.ts`, `cards.ts`, `blinds.ts` |
| Match state machine, timers | `match/match.ts`, `match-state.ts` | — | `view.ts` |
| The boundary | `match/projection.ts` | — | — |
| Bodies / presence | `match/presence.ts` | `interaction/presence-reporter.ts`, `scene/avatar.ts` | `presence.ts` |
| Card peeking | `match/presence.ts` (looks) | `interaction/peek.ts`, `card-peek-controller.ts`, `scene/hold.ts`, `cards.ts` | `presence.ts` (`PEEK`, `HAND_LIFT`) |
| The Dealer | `match/dealer.ts` | `scene/dealer.ts` | `dealer.ts` |
| Dread (the room) | `dreadLevel` in shared, `roomDread` in projection | `scene/table.ts` lighting, `audio/engine.ts` | `dealer.ts` |
| Stress model | `match/stress.ts` | — | `stress.ts` |
| Stress triggers | `match/match.ts` (`#raiseStress`, `#noticeStare`, `#noticeClock`, `#noticeRecheck`) | — | — |
| Tells on avatars | — | `scene/tells.ts`, `scene/avatar.ts` | — |
| First-person feel | — | `feel/pulse.ts`, `ui/tunnel.ts`, `scene/seated-camera.ts` (shake) | — |
| Composure | `match/composure/` (`challenge.ts`, `breath.ts`, `hold.ts`, `index.ts`) | `feel/composure-guide.ts`, `ui/composure.ts` | `composure.ts` |
| Telemetry / tuning | `match/stress-telemetry.ts`, `match/simulate.ts`, `net/stress-log-sink.ts` | — | — |
| Audio | — | `audio/cues.ts` (what), `audio/engine.ts` (how), `audio/loop.ts` | — |
| Surfaces (painted) | — | `scene/textures.ts`, `scene/noise.ts`, `scene/materials.ts` | — |
| Table, chairs | — | `scene/furniture.ts` | — |
| Room, door, candles | — | `scene/room-shell.ts` | — |
| Lamp, lit air, dust | — | `scene/lamp.ts`; the light itself in `scene/table.ts` | — |
| Heads, hair, clothes | — | `scene/figure.ts` (used by `avatar.ts`) | — |
| Chips, button | — | `scene/chips.ts`; breakdown and layout in `scene/layout.ts` | — |
| The lens | — | `scene/post.ts` | — |
| Quality tiers | — | `scene/quality.ts` | — |
| Overlay | — | `ui/hud.ts` (keyed sections, action clock), `ui/lobby.ts`, `style.css` | — |

---

## 5. Status

| Phase | State |
|---|---|
| 1 Poker engine | **Done.** Fuzzed, fairness-tested, chip conservation asserted at runtime |
| 2 Online private lobby | **Done.** Sessions, reconnect, rate limits, projection boundary |
| 3 The 3D table | **Done.** Seated camera, avatars with five fingers each, card atlas, chips |
| 4 Physical interactions | **Done**, plus five rounds of playtest fixes. Analog peek with real card bend, lift-to-inspect, IK hands, gaze, lean |
| 5 Dealer and atmosphere | **Done except one item:** frame times on real hardware (needs a real GPU) |
| 6 Heart rate and tells | **Done.** Stress model, tells, `self` channel, first-person feedback, avatar tells, telemetry/replay harness, all twelve stress events wired, stare scaled by dread |
| 7 Composure | **Done.** Interface, two minigames, masking effect, visible act, swap test |
| — Audit and visual overhaul | **Done** (November). See `AUDIT.md` |
| 8 First orbit and perks | **Next.** Not started |
| 9 Sacrifices | Not started |
| 10 Permanent elimination | Not started |
| 11 Full horror arc | Not started |

---

## 6. What is next: Phase 8 — first orbit and perks

From `ROADMAP.md`, with the design in `ARCHITECTURE.md` §7:

- Wire `server/src/poker/orbit.ts` (already written and tested) into the match
- A `PERK_RITUAL` state between hands; the blind clock pauses
  (`MatchState` already splits the clock into accumulated + running)
- The Dealer's ritual presentation
- Three private perk offers per player, drawn per player
- `PerkManager` as composable modifiers on stress / composure / tells /
  perception
- Prototype perks: Stoic, Liar, Coward, Gambler, Martyr, Corpse
- A test that no perk can reach the deck, cards or hand ranking

Composure and stress were built to be modified from outside: `StressTuning`
travels with the stress state, composure kinds are pluggable, and
`visibleStress` is a single function in the projection path. A perk is most
naturally a modifier at one of those seams, never inside the poker engine.

**Before starting Phase 8, a decision is needed on perk offers' privacy and
the ritual's pacing** — see §8.

---

## 7. Running it

```bash
npm run dev           # server :3001 + client :5173 together
npm run dev:fast      # short stacks, quick clocks — reach eliminations fast
npm test              # everything
npm run typecheck
npm run sim           # whole-match fuzzing only
npm run stress        # stress model over simulated evenings (see below)
```

Open http://localhost:5173 in 4–6 tabs. One creates a lobby, the others join
with the code, everyone readies, the host begins.

Add `?quality=low` or `?quality=high` to pin a quality tier. Without it the
game starts on `high` and steps itself down once if frames are slow.

At the table: drag or click to look (Escape releases pointer lock) ·
**hold right-click or `V` and pull toward you** to lift your cards · mouse
wheel to lean in · `F` fold · `C` check/call · `R` raise · `A` all in ·
**`B` to steady yourself**, then `Space` to breathe or hold.

**Environment variables**

| | |
|---|---|
| `ACTION_TIMEOUT_MS` | override the 30 s action clock (scripts use 600000) |
| `DEV_FAST=1` | short stacks and quick clocks |
| `STRESS_TELEMETRY_DIR` | record every match's stress inputs here, one file each |
| `SESSION_SECRET` | keep reconnect tokens valid across restarts |
| `CLIENT_ORIGIN`, `PORT`, `VITE_SERVER_URL` | deployment wiring |

**The stress report**

```bash
npm run stress                                   # 4 simulated six-handed evenings
npm run stress -- --players 4 --seeds 8
npm run stress -- --tune '{"halfLifeMs": 14000}' # baseline vs candidate, side by side
npm run stress -- --log recordings/*.stress.json # real matches
```

---

## 8. Waiting on a decision

These are the owner's calls, not the implementer's. Each has a default that
is in the code now.

| # | Decision | Current default |
|---|---|---|
| 1 | Should a **failed** composure attempt be a visible moment (a flinch, a sharp breath), or are the worse tells afterwards enough? | Tells only |
| 2 | Composure effect sizes: success hides 35–80% for 30 s, failure adds 30% of headroom for 12 s, 15 s cooldown | As stated; all in `COMPOSURE` in `shared/src/composure.ts` |
| 3 | Ship both minigames (picked at random) or only steady-breath? | Both |
| 4 | Is late-game shaking frequent enough? Bots cannot answer this; it needs real recorded matches | Unchanged; flagged |
| 5 | The Dealer's stare starts at a fifth of its weight and grows with dread. Right starting point? | `TRIGGERS.watchedCalm = 0.2` in `server/src/match/stress.ts` |
| 6 | Should time spent staring at your cards, and sitting perfectly still, feed stress? They are recorded in presence but are not stress inputs | Not wired |
| 7 | Does the blind clock pause for the perk ritual? (Phase 8) | Architecture recommends yes |
| 8 | Hand/finger rig for sacrifices (Phase 9): per-finger visibility + procedural grips is the recommendation; `Avatar.removeFinger` already hides one | Open |
| 9 | Branch hygiene: make `claude/vigilant-bell-l3ldus` the default (or merge it), so new sessions and clones start on the real code | Not done; needs the owner. Three branches deep now |
| 10 | Is the look right? Palette, faces, how dark and how early | In constants; see `AUDIT.md` §6 |
| 11 | Muck or show every hand at showdown? | Show |
| 12 | Stage an all-in runout street by street? | Not staged: it all arrives at once |
| 13 | Rematch in the same lobby? | No: a finished match ends at a banner |

Longer-horizon decisions that can safely wait are in `ARCHITECTURE.md` §11.

---

## 9. Known gaps and unverified things

- **It cannot be played with anybody who is not on your machine.** There is no
  production entry point and nothing serves the built client. `AUDIT.md` §5.1.
  This is the first thing to fix.
- **Nothing has been played by humans since Phase 4's playtest rounds.** The
  Dealer, stress, tells, the first-person feel, composure, their audio, and now
  the whole look have only been checked by tests and headless browser scripts.
- **Audio has never been listened to** (heartbeat, breathing, composure
  exhale, Dealer rise). `scripts/audio-check.mjs` only proves the context runs.
- **Frame times on real hardware** are unmeasured; all browser runs use
  software rendering, where the `high` tier takes about two seconds a frame.
  Draw calls and triangles are measured (`scripts/scene-budget.mjs`): 248 and
  251k for four players on `low`, 268 and 253k on `high`. The quality governor
  (`scene/quality.ts`) exists because nobody has the real number.
- **The overlay has no unit tests.** No DOM in the test environment. Its bugs
  were found and fixed by driving a browser.
- **Stress is tuned against bots.** Bots look and re-check at fixed rates and
  never because of their cards; real recordings (`STRESS_TELEMETRY_DIR`) are
  what to tune against.
- **Composure is not in stress telemetry**, and simulated bots never compose,
  so the stress report cannot see it.
- README's status section was refreshed in this handoff; if it and the
  roadmap ever disagree, the roadmap is the more carefully maintained one.

---

## 10. How work has been done here (keep doing it this way)

- **Every rule gets a test that fails when the rule is broken** — and the
  test is checked by actually breaking the rule once (a temporary edit,
  reverted). Several tests in this repo were caught passing vacuously that
  way.
- **"Does it ever happen?" tests** for anything tuned: `dread-profile.test.ts`
  and `stress-profile.test.ts` play whole evenings and assert that postures
  and events actually occur. Three thresholds and three stress events were
  found never firing this way.
- **Verify in a real browser** with the scripts in `scripts/` (they need
  `npm run dev` running, launched with `ACTION_TIMEOUT_MS=600000`). The repo
  pins its own Playwright, which does not match the browser preinstalled in
  the cloud environment, so pass the browser explicitly:
  `CHROME=/opt/pw-browsers/chromium node scripts/tell-shots.mjs`. Every script
  reads `CHROME` and `OUT` (where screenshots go; default `.shots/…`), and
  `QUALITY` (default `low`: the lens is too slow to photograph bodies through
  under software rendering).
- **To judge a change to how the room looks**, `scripts/look-shots.mjs`: the
  same ten camera positions every time, on the `high` tier, so two runs can be
  put side by side. `DREAD=0.9` photographs the end of the evening.
- **Wait on conditions, not clocks**, in browser scripts: four software-
  rendered pages run at a frame or two a second, and anything that eases on
  frame time (camera, avatars, the vignette, overlays) is slow there.
- **Pointer lock in scripts**: under lock every mouse move is a look; scripts
  track the pointer rather than teleporting it.
- **Dev hooks** (development builds only): `__view()`, `__bodies()`,
  `__feel(level|null)`, `__tells(seat, tells|null)`, `__freeLook(x,y,z,at)`,
  `__inspect()`, `__sceneStats()`, `__audio()`, `__dread(level|null)`,
  `__quality('low'|'high')`.
- **A symmetric placeholder hides sign errors.** Heads pitched the wrong way
  for four phases because a rounded box looks the same tilted up or down. When
  something stands in for a shape, test the direction it faces, not just the
  number that drives it.
- Commit messages explain *why*, with what was measured. Comments in the code
  explain decisions and the wrong turns before them; keep that up — several
  record bugs that would otherwise be reintroduced.
