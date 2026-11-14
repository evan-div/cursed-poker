# Audit — November 2026

A full read of the codebase at the end of Phase 7, a run of everything that
can be run, and a look at the game in a browser. This is what was found, what
was fixed, what the game looks like now, and what is still owed.

Read `HANDOFF.md` first if you have not; this assumes it.

---

## 1. In one page

**The foundations are good.** The poker engine is honest and well tested, the
hidden-information boundary really is one module, and the habit of proving a
rule by breaking it has caught real bugs. Nothing in this audit found a way for
one player to learn another's cards, or for anything supernatural to reach the
deck.

**It had bugs a first evening with friends would have hit.** No action clock on
screen, a bet slider that reset itself mid-drag, a finished match nobody could
leave, a rules error in the poker itself, and heads that looked at the ceiling.
All fixed, each with a test that failed first. Sixteen in total; see §2.

**It looked like its own scaffolding.** Boxes, cylinders and flat colour on a
floor that ran out into fog. It is now a room: see §3.

**The biggest thing left is not a bug.** There is no way to play this with
friends who are not on your machine. Everything else in §5 is smaller than that.

| | Before | After |
|---|---|---|
| Tests | 530 in 40 files | 575 in 46 files |
| `npm audit` | 6 findings (2 critical) | 0 |
| Client bundle | 717 kB (195 kB gzip) | 712 kB (197 kB gzip): the same, with the whole visual layer added |
| Draw calls, 4 players, whole frame | 161 | 248 (268 with the lens) |
| Triangles, 4 players, whole frame | 78k | 251k |
| Surfaces painted at start-up | none | 0.65 s, in the background |

---

## 2. What was wrong, and is fixed

Every one of these has a test that was seen to fail before the fix, except
where noted. Commit hashes are on `claude/vigilant-bell-l3ldus`.

### The poker itself

| | |
|---|---|
| **Short all-ins that add up to a raise did not reopen the betting.** | Bet 100, all-in 125, call, all-in 200, call: the bettor now faces a full raise of 100 and may re-raise. The engine judged each all-in on its own and said no. The tournament rule (TDA 43/47) measures what a player *faces* when the action returns. Late-game short-stack play is exactly where this comes up. `hand-engine.ts`. |

### Server

| | |
|---|---|
| **A connection could hold two seats.** | Creating or joining a second lobby on the same socket left the first seat attached: it read as connected for ever, so its room could never be swept. Any client could pin a dozen rooms a minute in memory. One connection now speaks for one seat. |
| **A lobby everybody left had no host.** | Whoever later joined it by code could never start it. The next arrival takes the chair. |
| **Internal errors were sent to the client and logged nowhere.** | An exception's text went to whoever provoked it, verbatim, and nobody running the server ever saw it. Deliberate refusals still explain themselves; anything else is reported server-side and the client hears only that something went wrong. |
| **Looking at your cards pushed a view to the whole table.** | Not a leak — nothing in it was secret — but it was an exact copy of a tell the table is meant to get by watching, and it rebuilt everyone's overlay. It goes to the looker alone, like composure already did. |
| **One table's failure would end every table.** | An exception escaping a match timer was uncaught: Node exits and every room in memory goes with it. The clock contains it and logs it. |

### Client

| | |
|---|---|
| **There was no action clock.** | Thirty seconds to act and nothing on screen said so. The stress model's own comment said "the countdown is on everybody's screen"; it was not. Now a line above the buttons, a count when it is yours or nearly gone, and the same clock on the acting player's nameplate. |
| **The bet slider reset itself.** | The whole overlay was rebuilt on every view, so sizing a raise was undone by anything arriving — and the next `R` raised the minimum. The overlay is now keyed part by part. *Verified in a browser; the overlay has no unit tests (§5).* |
| **A finished match could not be left.** | The session token was kept for ever, so every reload resumed into the same table. The only way out was clearing site data. There is now a Leave control. *Verified in a browser.* |
| **Heads pitched the wrong way.** | Looking down at your cards tipped the face at the ceiling; a "bow" threw the head back; the Dealer looked over everybody's heads. Invisible while a head was a rounded box, and found the moment heads had faces. |
| **Every stack over 20 big blinds looked identical.** | A pile was a chip count capped at ninety. The chip leader and a player about to bust had the same stack. Chips now have denominations. |
| **Countdowns used the local clock.** | A machine five minutes fast lost five minutes from every blind level. |
| **The opposite player's nameplate was under the top bar.** | Clamped. |
| **The room tone ticked every seven seconds.** | Its loop did not close. Folded into itself. |
| **The audio context was never closed.** | Now closed with the scene. |
| **Twelve arms allocated ~60 objects a frame.** | The solver writes into a caller's solution. |

### Dependencies and build

`npm audit` reported six findings on a fresh clone. All cleared: Vite and
source-map-js by patch, vitest 3 → 5 and zod 3 → 4 by major, with the suite
passing unmodified. The zod advisory was not reachable here (no schema validates
a collection, and the socket caps a message at 8 kB) but it was the one finding
in code that ships.

Nobody had run a production build. It works. zod turned out to be in the browser
bundle — the client imports only types from the protocol, but a bundler cannot
know that building a schema has no side effects — and declaring the shared
package side-effect free removed it (−93 kB). The lens and the painters then
put about the same back, which is why the bundle is the size it was.

---

## 3. What it looks like now

Nothing is loaded. Every surface is still built at start-up from numbers; what
changed is what the numbers build.

**The table.** Baize with a nap, worn pale where arms rest and cards are dealt,
stained, with a gilt heptagram printed on it joining the seven stations — the
layout was always a seven-pointed figure. A stitched oxblood rail with a row of
brass tacks under it. A pedestal turned on a lathe.

**The room.** Panelled walls with damask paper above. A door at the Dealer's
back with cold light round its edges. Four portraits with the eyes scored out.
Drapes, a sideboard with bottles, a rug, a ceiling. A green glass shade over
the table, a shaft of lit air under it, and dust turning over in the shaft.

**Chips and cards.** Five denominations relative to the big blind, with edge
spots; a heap for the pot; a dealer button on the felt. Cards with drawn suits,
court figures (none of them has eyes), an ornate back that reads the same either
way up, rounded corners, and mipmaps so the board no longer shimmers.

**People.** Sculpted heads — brow, sockets, nose, jaw — which under a lamp
directly overhead puts every eye in shadow. Six looks, one per seat: skin, hair,
coat, collar, cuffs; one wears spectacles, one a cap, one pearls.

**The Dealer.** A cowl with an opening and nothing in it but two lights; a torn
robe that hangs in folds; a mantle; hands the colour of bone.

**The lens.** Bloom on light sources only, a grade that drains colour as dread
rises, grain, a vignette, and colour fringing driven by the player's own fear.

**The room answers to dread.** This is the part worth playing for. As the
evening goes: the candles gutter and go out, one at a time; the walls stop being
findable; the lamp's pool tightens and reddens; the door gets brighter; the
Dealer's eyes go from two dull points to something that flares. Nobody is told.
All of it runs off the one number every client already receives.

### What it costs

Measured with `scripts/scene-budget.mjs`, four players, a hand in progress, the
whole frame including the shadow pass:

| | Draw calls | Triangles |
|---|---|---|
| Before | 161 | 78k |
| After, `low` | 248 | 251k |
| After, `high` | 268 | 253k |

(The architecture doc's table said 8.3k triangles at six players. It was
measured before rounded edges and five-fingered hands and never updated.)

Some things got cheaper: seven chairs were 42 draw calls and are 2. Most of the
growth is bodies — hair, collars, cuffs — and is doubled by the shadow pass.
All of it is well inside what an integrated GPU does at sixty frames a second.

**Two tiers.** `high` is the lens, the lit air, the candles' light and a 2048
shadow map. `low` drops all four. A governor watches frame times and steps a
machine down once if it cannot hold thirty frames a second. `?quality=low` or
`?quality=high` pins a tier.

**Start-up.** Painting the surfaces was first measured at five seconds on the
main thread, which would have been a freeze as the table appeared. Slow-varying
noise is now computed on a coarse grid and interpolated, and painting starts
when the page loads rather than when the match does: about 0.65 s, done while
the player is still typing their name.

---

## 4. What could not be verified

Said plainly, because these are the places a surprise would come from.

- **Nobody has played it.** Still. Everything since Phase 4 — the Dealer,
  stress, tells, composure, and now the entire look — has been checked by tests
  and headless browsers only.
- **Frame rate on a real GPU is unmeasured.** This environment has only a
  software renderer, where the `high` tier takes two seconds a frame. The
  numbers above are counts, not times. The governor exists because of this.
- **The audio has still never been heard**, by anyone. The loop fix is proven
  on samples; whether the room *sounds* right is unknown.
- **The lens was tuned by screenshot.** Bloom, grade and grain look right in
  stills. Whether the grain crawls or the fringing is tiring over an hour is a
  question for a person at a monitor.
- **The overlay has no unit tests.** There is no DOM in the test environment.
  The slider, clock and leave flow were verified by driving a real browser.

---

## 5. What is still owed

In the order I would do them.

### 5.1 It cannot be played with friends who are not in the room

The client's server address defaults to `localhost:3001`, the server accepts
only loopback origins unless told otherwise, there is no production entry
point, and nothing serves the built client. To play this over the internet
today you would deploy two things by hand and get the CORS and URL settings
right yourself.

The smallest fix is one process: the Node server serves the built client from
the same origin (no CORS at all), a `npm run build && npm start`, and a
Dockerfile. Half a day. Two things to settle with it:

- **Rate limiting behind a proxy.** Join attempts are limited per remote
  address. Behind any reverse proxy every player shares one address, so twelve
  joins a minute is the limit for the whole world. Needs `X-Forwarded-For`
  handling, deliberately, with a trusted-proxy setting.
- **A restart ends every match.** Rooms are in memory. `SESSION_SECRET` keeps
  tokens valid across a restart, but there is no room for them to resume into.
  `MatchState` was kept as plain JSON for exactly this; snapshotting it is the
  natural next step and is not yet done.

### 5.2 Play it

Four people, one evening, with `STRESS_TELEMETRY_DIR` set. Most of the open
decisions in `HANDOFF.md` §8 are waiting on exactly this, and so is every
"could not be verified" above.

### 5.3 Smaller things, each a real gap

- **No rematch.** A finished match ends at a banner. The same six people have
  to make a new lobby and pass a new code round.
- **An all-in runout arrives all at once.** When everybody is all-in the flop,
  turn and river land in one update. It is the most dramatic moment in poker,
  in a horror game, and it is over in a frame. Staging the reveal is
  presentation only — the cards are already public — and would be worth a lot.
- **Every hand is shown at showdown.** There is no mucking. That is a legitimate
  house rule, but it is a rule nobody chose; it deserves a decision.
- **`PlayerRecord.timeouts` is counted and never read.** Either the sit-out
  behaviour it was for should exist, or the field should go.
- **Keyboard and mouse only.** Pointer lock, right-click and held keys. There
  is no touch path at all; on a phone the table cannot be played.
- **Fingers are one bone each.** Hands are the part of a body a player sees
  closest and they are the least changed thing in this pass. A second joint
  would let fingers wrap a card; the grip tests measure fingertips, so it needs
  care.
- **Eyes do not move.** Gaze is the head only. Fine at this distance; worth
  knowing.
- **Composure is still invisible to telemetry** (already in the handoff).

### 5.4 Things I looked for and did not find

Worth recording, so nobody looks again without a reason.

- **A way to see another player's cards.** The projection boundary holds; the
  allowlist tests do what they claim.
- **Injection through display names.** Stripped of control characters by the
  schema and only ever written as text.
- **A path from the horror layer into the engine.** `server/src/poker/` imports
  nothing from outside itself and `shared/`.
- **Forgeable sessions.** HMAC-signed, constant-time compared, room-bound,
  expiring.

---

## 6. Decisions

The nine in `HANDOFF.md` §8 stand. What this audit adds or changes:

| # | Decision | Recommendation |
|---|---|---|
| 9 | Branch hygiene | **More urgent.** There are now three branches and the default is still Phase 2. Open a PR from `claude/vigilant-bell-l3ldus`, which contains everything, and make its target the default. |
| 10 | Is the look right? | Yours to judge. The palette, the faces, how dark the room gets and how early are all taste, and all in a handful of constants: `ROOM` in `table.ts`, `LIGHTS` in `room-shell.ts`, `GRADE`/`BLOOM` in `post.ts`, `LOOKS` in `figure.ts`. |
| 11 | Muck or show at showdown? | Show, as now, for a game about reading people — but decide it. |
| 12 | Stage all-in runouts? | Yes. |
| 13 | Rematch in the same lobby? | Yes, before a second playtest. |

---

## 7. Checking any of this

```bash
npm install
npm run typecheck        # clean
npm test                 # 575 tests, 46 files
npm audit                # 0
npm --workspace @cursed/client run build

ACTION_TIMEOUT_MS=600000 npm run dev
CHROME=/opt/pw-browsers/chromium node scripts/look-shots.mjs       # the room, ten angles
DREAD=0.9 CHROME=... node scripts/look-shots.mjs                   # the end of the evening
QUALITY=high CHROME=... node scripts/scene-budget.mjs              # what it costs
```

New development hooks: `__dread(level|null)` pins the room's dread;
`__quality('low'|'high')` switches tier.
