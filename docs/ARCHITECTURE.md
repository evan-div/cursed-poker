# Horror Texas Hold'em — Architecture

Status: living document. Phases 1 (poker engine), 2 (online private lobbies) and
3 (the 3D table) are implemented; everything from Phase 4 on is design intent,
not code.

---

## 1. What was here before

Nothing. `evan-div/cursed-poker` was an empty repository — no commits, no files,
no history. There is nothing to preserve and no legacy to work around, so every
decision below is a fresh one.

---

## 2. The one rule everything else bends around

> The supernatural layer never touches the deck.

This is not a slogan; it is an architectural constraint that decides the shape of
the whole codebase. It means:

- The poker engine is a **separate, pure, dependency-free module**. It imports no
  transport, no renderer, no stress model, no perk system.
- Horror systems **read** poker state and **subscribe** to poker events. There is
  no function anywhere that lets them write into a hand.
- Chips enter a stack from outside a pot through exactly one door: `grantChips`,
  which only works **between hands**. A sacrifice is nothing more than that.
- Fairness is **testable**, and tested: the shuffle is chi-square checked against
  positional bias, the evaluator is cross-validated against an independently
  written reference over 200,000 hands, and 140 complete fuzzed matches assert
  chip conservation and correct pot awards after every single action.

If someone later "improves pacing" by nudging card distribution, `tests/fairness.test.ts`
fails. That is the point.

---

## 3. Project layout

```
/shared     cards, poker vocabulary, blind structures, tuning constants
/server     authoritative simulation
  /poker    the engine — no I/O, no framework, no horror
/tests      cross-cutting: whole-match fuzzing, shuffle fairness
/client     (Phase 3) Three.js presentation
/docs
```

`/shared` is deliberately thin. It holds things both sides must agree on
*exactly* — card encoding, action shapes, blind data — and nothing else. Balance
constants live there because the client wants to display them, not because the
engine reads them.

### Module map (current)

| Module | Responsibility |
|---|---|
| `poker/random.ts` | `RandomSource` interface; CSPRNG for play, seeded for tests; Fisher-Yates |
| `poker/deck.ts` | `SecretDeck` — the deck, loudly named so leak audits can grep for it |
| `poker/evaluator.ts` | Fast bitmask evaluator + an independent slow reference for tests |
| `poker/pots.ts` | Side pots, dead money, uncalled bets, odd-chip distribution |
| `poker/hand-engine.ts` | One hand of No-Limit Hold'em as a pure state machine |
| `poker/table.ts` | Seats, stacks, button rotation, blind level, the between-hands seam |
| `poker/orbit.ts` | First-orbit tracking (button bookkeeping only) |
| `match/match.ts` | The outer state machine: one lobby, empty room to last player standing |
| `match/projection.ts` | **The hidden-information boundary.** The only path from state to bytes |
| `match/clock.ts` | Time, injected, so every timeout is testable |
| `net/transport.ts` | The transport seam; `net/socketio-transport.ts` is the only file that names Socket.IO |
| `net/sessions.ts` | HMAC-signed, room-bound, expiring reconnect tokens |
| `net/rooms.ts` | Lobby lifecycle and invite codes |
| `net/rate-limit.ts` | Token buckets for message flooding and code guessing |
| `net/game-server.ts` | Wires it together; validates every inbound payload |
| `client/scene/layout.ts` | Every position on the table, as pure maths |
| `client/scene/game-scene.ts` | The renderer; a pure function of `ClientView` |
| `client/scene/table.ts` | Room, table, chairs, lighting |
| `client/scene/avatar.ts` | A seated person, with five separate fingers per hand |
| `client/scene/dealer.ts` | The hooded figure at the seventh station |
| `client/scene/cards.ts` | Card meshes, and the client's one privacy decision |
| `client/scene/chips.ts` | Every chip on the table, in one draw call |
| `client/scene/seated-camera.ts` | A head on a neck, clamped to what a chair allows |
| `client/ui/*` | The DOM overlay: lobby, HUD, projected nameplates |

### Module map (planned)

Server: `SacrificeManager`, `PerkManager`, `StressModel`, `TellDeriver`,
`HorrorDirector`.

Client: `CardPeekController`, `InteractionManager`, attention bias in the camera,
`TellVisualizer`, `AudioManager`, `SacrificePresentation`.

None of these are god classes. They communicate through the event stream and
plain data, not by reaching into each other.

---

## 4. Networking: Socket.IO, behind a `Transport` interface

**Recommendation: Socket.IO** for the prototype, wrapped in a ~40-line transport
interface so it can be replaced without touching game code.

The traffic has two completely different profiles, and the choice is driven by
the first one:

| | Poker state | Presence / tells |
|---|---|---|
| Rate | ~1 message per 3-10s per room | 10-20 Hz |
| Size | small | tiny |
| Loss tolerance | zero | high |
| Ordering | required | irrelevant |
| Per-recipient content | **different for every player** | mostly uniform |

That last row is the deciding factor.

**Colyseus** was the strongest temptation: rooms, reconnection, and binary delta
state sync out of the box. It is the wrong fit here for two reasons.

1. Its model is *one authoritative room state, automatically diffed and
   broadcast to everyone*. Hiding hole cards means `@filter()` /
   `@filterChildren()`, which turns "did we leak a hole card?" into a property of
   decorator metadata scattered across schema classes. This project needs the
   leak surface to be **one function with its own test suite**.
2. It wants poker state to live in `Schema` subclasses — coupling the engine to
   the transport, which is exactly the thing rule §2 forbids. The realistic
   outcome is maintaining a hand-written Schema mirror of the engine state,
   i.e. doing the projection manually anyway while paying for a framework being
   fought.

And its headline feature — binary delta compression of high-frequency state — is
optimizing a problem that does not exist at one message every few seconds for six
players.

**Raw `ws`** is the other serious option and is genuinely fine. It costs roughly
500-800 lines of infrastructure (room routing, heartbeats, reconnect/resume,
framing, acknowledgements) before a single hand is played. That is real work with
no gameplay payoff.

**Socket.IO** gives, for a ~40KB gzipped client and some protocol overhead:

- **Per-socket emit as the default.** `io.to(socketId).emit(...)` is the natural
  primitive for hidden information. Broadcast is the opt-in, not the default —
  the safe direction for a game built on secrets.
- **Rooms** matching lobbies one-to-one.
- **Reconnection** with backoff and connection-state recovery. A game-level
  resume is still needed (re-project the full view on rejoin), but the socket
  plumbing is free.
- **Typed events**: `Server<ClientToServerEvents, ServerToClientEvents>` pairs
  cleanly with a `/shared` message module and runtime validation.
- **Volatile emits** — dropped rather than buffered — which is exactly right for
  the 15 Hz gaze/tremor channel where a stale packet is worse than no packet.
- **Acknowledgements with timeouts** for actions that need confirmation.

Nothing about the game is latency-bound; the poker layer is turn-based and the
tell channel is cosmetic and interpolated. Trading a few milliseconds of protocol
overhead for correct-by-default privacy and a working reconnect story is the
right trade.

**Escape hatch:** all of it sits behind `Transport` (`send(playerId, msg)`,
`broadcast(roomId, msg)`, `onMessage`, `onDisconnect`). If the tell channel ever
justifies WebTransport or WebRTC datachannels, that is a second transport
alongside the first, not a rewrite.

---

## 5. Authority split

### The server owns, without exception

Deck and shuffle · hole cards · community cards · turn order · legal-action
validation · every bet, call, raise, fold · pots and side pots · showdown ·
payouts · stacks · button · blind level and the match clock · sacrifice
eligibility, count and chip grants · elimination · perk offers and selections ·
the stress/heart-rate simulation · derived tell values · horror escalation tier ·
**and who is allowed to know what**.

### The client owns

Rendering · animation · audio mixing · camera and free-look · local input · UI
affordances · interpolation of cosmetic state · the visual degree of its *own*
card peek.

### The client owns nothing that decides a poker outcome, and nothing that decides what another player may know.

Three consequences that are easy to get wrong:

**Gaze and card-peeking are inputs, not local state.** Where a player looks and
whether they just re-checked their cards is *other players' information*. It goes
to the server and is re-broadcast in derived form. It never travels peer-to-peer,
and a client cannot suppress its own tells by not sending them — silence is
itself replicated as stillness.

**Tells are derived server-side.** The client reports raw inputs (gaze vector,
peek amount, action latency); the server owns `heartRate` and emits only
`{ tremor: 0.42, breathing: 0.55, sweat: 'moderate' }`. A modified client cannot
fake composure it does not have, because it never had the number in the first
place.

**The card face never leaves its owner's client.** The peek *pose* is replicated;
the peeked card is not. Opponents receive "seat 3 is looking at their cards,
0.6 exposure" and render their own abstraction of it.

### The projection boundary

One module — `server/src/match/projection.ts` — converts authoritative match
state into a per-viewer view. **Nothing else may serialize match state toward a
client.**

```
projectForViewer(match: MatchState, viewerId: string | null, now: number): ClientView
```

It is tested three ways, deliberately overlapping:

1. **Structurally, over live fuzzed matches.** `projection.test.ts` walks every
   viewer's view at every decision point of complete matches, collects every
   numeric array in the object tree, and asserts each one is either seat indices
   or cards that viewer is entitled to. An unclassified numeric array is a
   failure, so a newly added card-bearing field cannot slip through unnoticed.
2. **Mutation-checked.** Deliberately changing the projector to expose live hole
   cards makes four of the six tests fail with the exact path of the leak. A
   security test that cannot fail is worthless, so this was verified.
3. **End-to-end, across clients.** `tests/integration.test.ts` records every view
   every real Socket.IO client receives during a whole match, then cross-
   references them: no client may ever have been sent a card that another client
   was holding at that moment, unless that seat was openly revealed.

`tests/match-simulation.test.ts` covers the engine half: the event stream carries
no deck, no burn pile, and no hole card belonging to a player who was not
required to show.

---

## 6. State machines

The brief's flat list of states is workable but hides the invariant that matters.
Splitting it into two nested machines makes that invariant **structural**:

### Outer: match (server, per room)

```
LOBBY
  └─ MATCH_START
       └─ HAND_IN_PROGRESS ──┐
            │                │
            ▼                │
       HAND_SETTLEMENT       │
            │                │
            ▼                │
       BETWEEN_HANDS ────────┘
            ├─ ELIMINATION_CHECK
            ├─ SACRIFICE_WINDOW      (horror layer)
            ├─ PERK_RITUAL           (horror layer, once)
            └─ BLIND_LEVEL_CHECK
            │
            ▼
        MATCH_END
```

### Inner: hand (`hand-engine.ts`, pure)

```
PREFLOP → FLOP → TURN → RIVER → SHOWDOWN → COMPLETE
```
with early exit to `COMPLETE` whenever one contender remains.

**Why this shape:** every supernatural system lives in `BETWEEN_HANDS`, and the
outer machine has no transition from `HAND_IN_PROGRESS` into it. A sacrifice
*cannot* interrupt a hand, not because we remembered to check, but because
there is no edge in the graph. `table.ts` enforces the same thing at runtime:
`grantChips`, `eliminate` and `setLevel*` all throw if a hand is in progress.

The inner machine is browser-free, socket-free and clock-free. A test can play a
complete tournament in milliseconds without rendering a mesh — which is what
`tests/match-simulation.test.ts` does, 140 matches at a time.

---

## 7. The first-orbit perk ritual

**Definition.** One orbit is complete when every active player has held the
dealer button once.

**Why not "N hands".** With 4-6 players and eliminations, counting hands drifts
immediately. The tracker (`poker/orbit.ts`) instead records the set of seats that
have *held the button*, and completes when every seat **still in the match** is in
that set. A player who leaves before taking the button is no longer owed one, so
their departure cannot freeze the ritual. A hand-count safety valve
(`handsPlayed >= initialSeats.length`) guarantees the ritual can never be delayed
past one hand per starting seat however pathological the field becomes.

**When it fires.** `recordHand` is called during `BETWEEN_HANDS`, after
settlement. Because it is only reachable from that state, the ritual can never
land mid-hand. The sequence is:

1. Hand N completes, `settleHand` writes stacks back.
2. `ELIMINATION_CHECK` and `SACRIFICE_WINDOW` run.
3. Orbit tracker updates. If it just completed → `PERK_RITUAL`.
4. The Dealer interrupts. Each player is offered `choicesPerPlayer` (3) perks,
   drawn per-player so offers differ. Selections are private.
5. Perks are recorded on the authoritative player record. Play resumes.

**Open decision:** whether the blind clock pauses during the ritual.
Recommendation: **yes** — it is a forced interruption, and letting blinds climb
during a cutscene punishes players for something they did not choose.

---

## 8. Layering sacrifices onto tournament poker

This is the cleanest part of the design, and it is worth stating precisely.

**A sacrifice, from the poker engine's point of view, is one thing: a stack
changing size between hands.** That is the entire contamination surface.

The engine has no `sacrifice` symbol anywhere in it. The table layer exposes:

```ts
grantChips(table, seatIndex, amount, reason)   // between hands only
eliminate(table, seatIndex)                    // between hands only, stack must be 0
bustedSeats(table)                             // read-only report
```

`settleHand` deliberately **does not eliminate anyone**. It writes stacks back,
moves the button, and *reports* which seats finished at zero. Whether a busted
player leaves, sacrifices, or sits there bleeding is a decision taken outside the
poker layer entirely.

So `SacrificeManager` (Phase 9) is:

```
on BETWEEN_HANDS:
  for each seated player:
    eligible = sacrificesUsed < 3 AND (stack == 0 OR stack < 20 * bigBlind)
    offer/require accordingly
  on accept:
    grantChips(table, seat, round(rebuyBigBlinds * bigBlind), 'sacrifice:FINGER_REMOVAL')
    player.sacrificesUsed++
    player.bodyState.push(...)     // permanent, purely presentational
  for each still-busted player with no sacrifices left:
    eliminate(table, seat)
```

Every guarantee the brief asks for falls out of this structure rather than out of
discipline:

- *A sacrifice can never occur mid-hand* — there is no API that permits it.
- *A sacrifice must never change the result of the previous hand* — the previous
  hand is already `COMPLETE` and its `result` is immutable before the window
  opens.
- *Rebuy value scales with blinds* — it is expressed in big blinds and multiplied
  at grant time.
- *Poker stays trustworthy* — deleting the entire horror layer leaves a working
  tournament, and every poker test still passes.

Sacrifice value is currently `25BB` (`DEFAULT_SACRIFICE_CONFIG`) as a starting
point, explicitly not locked. Total chips in play grow with sacrifices, so this
number and the blind curve must be tuned together.

---

## 9. Major technical risks

**Permanently altered hands.** Sacrifice 2 removes a finger, and every subsequent
animation must respect it. Retargeting animations to a modified skeleton at
runtime is the expensive way. Mitigation: author the hand as its own rig with
per-finger visibility and procedural/IK grips rather than baked full-hand poses,
so removing a finger is a state flag, not a new animation set. **This decision
must be made before any avatar modelling begins.**

**Six animated humanoids plus the Dealer in WebGL.** Skinned meshes, shadows and
dynamic lights all compete for the same budget. Mitigation: one shared skeleton
and mesh with per-instance material variation; bake room lighting; allow at most
one or two real-time shadow-casting lights (the table lamp, the Dealer). Budget
this in Phase 3 rather than discovering it in Phase 11.

**"The table remembers."** Blood, smears and trophies accumulate for 60-90
minutes. Spawning decal meshes is unbounded growth. Mitigation: accumulate into a
fixed-size render target / decal atlas on the table surface. Cost is then
constant regardless of how ugly the match gets.

**Card peeking must be tactile without leaking.** The analog peek is the game's
signature interaction and its most delicate privacy surface. The card face is
owner-only; opponents receive an abstracted pose. The risk is *design*, not
security: making the abstraction readable enough to be a tell but ambiguous
enough not to be a decoder.

**Tuning stress and tells has no ground truth.** There is no unit test for "this
feels tense." Mitigation: build a replay/telemetry harness early (record inputs,
replay matches, inspect stress curves offline) so balancing is data-driven rather
than vibes-driven.

**Long-lived server state.** A 90-minute match with reconnects means room state
must survive disconnects and ideally a server restart. Mitigation: keep
`TableState` and match state plain-JSON serializable — already true — so
snapshotting is trivial when it is needed.

**Clock handling.** Blind levels advance on wall time. Ritual pauses, backgrounded
browser tabs and slow clients must not desync it. The server owns the clock
absolutely; clients only display it.

**Audio density.** Six players' breathing and heartbeats plus positional
ambience turns to mud fast. Needs a mixing budget and ducking rules, not just
more sounds.

---

## 10. Major multiplayer and security risks

**Hole-card leakage — the single highest-severity risk.** Mitigations: one
projection function as the sole serialization path; deck never in any broadcast;
automated tests over fuzzed states asserting no unauthorized card appears.
Already enforced at the engine level.

**Predictable shuffles.** Use the CSPRNG only. Never seed from time, a player id,
or a match id. `SeededRandomSource` exists for tests and is never reachable from
a real match — `startHand` defaults to `CryptoRandomSource`.

**Client-side validation only.** Every action is re-validated server-side against
server state. `legalActions` is a UI convenience, never a trust boundary.

**Eliminated players as a leak vector.** A busted player who can see live hole
cards can coach a surviving friend. Eliminated players must receive the same
public projection as anyone else. **This needs a decision before Phase 10.**

**Out-of-band collusion.** Four to six friends on a voice call can share hole
cards freely, and no technical measure fixes that. This is a private-lobby game
between friends; it is a social contract, not a threat model. Worth stating so
nobody builds anti-collusion machinery that costs real work and buys nothing.

**Tell spoofing.** If tells were computed client-side, a patched client would
always look calm. Deriving them server-side from server-owned stress removes the
attack entirely.

**Timing side channels.** Reaction speed is *deliberately* a tell, but the
protocol must not add ones players did not choose: deal to all seats
simultaneously, and keep hole-card messages fixed-size so packet timing and
length reveal nothing about hand strength.

**Reconnect hijacking.** A rejoining player must prove identity or a seat can be
stolen — with it, that seat's hole cards. Use unguessable signed session tokens
bound to the room, never a seat index or player name.

**Room-code brute force.** Lobby codes need enough entropy plus join rate
limiting, or private lobbies are only private by obscurity.

**Action spam / DoS.** Per-socket rate limiting, and a bounded action queue per
room.

**Composure minigame trust.** The server issues the challenge and validates the
result against server-side timing windows. A client that reports "I succeeded"
is not evidence.

---

## 11. Decisions that can safely wait

- The exact composure minigame (behind an interface from day one).
- The final perk list and every balance number.
- Sacrifice rebuy size beyond the 25BB placeholder.
- What victory *means* narratively.
- Voice chat.
- Avatar art direction and any customization.
- Spectator mode features.
- Accounts, persistence, matchmaking, progression.
- Whether tells can be deliberately faked (the advanced mechanic).

---

## 12. Decisions needed soon

| Decision | Needed by | Status |
|---|---|---|
| Tells derived server-side or client-side | Phase 6 | **Server-side**, and the protocol is already shaped for it: the client sends inputs, the server sends derived state |
| What an eliminated player sees | Phase 10 | Public projection only. Already true — an eliminated player's view is built by the same function as everyone else's |
| Hand/finger rig approach | Phase 3, before modelling | Open. Recommendation: per-finger visibility + procedural grips |
| Does the blind clock pause for rituals | Phase 8 | Open. Recommendation: yes. `MatchState` already splits the clock into accumulated and running so pausing is a two-line change |
| View deltas instead of whole views | When profiling says so | Open, and deliberately deferred (§14) |

---

## 13. Decisions already made and why

**Button movement.** The button advances to the next seat still holding chips.
Because the blinds derive from the button, the big blind moves forward by exactly
one contesting seat per hand, so nobody ever posts it twice in a row — asserted
over 40 hands in `table.test.ts`. This is a deliberate simplification of the live
dead-button rule: after an elimination a player can be *skipped* for a big blind,
which costs them nothing. Revisit only if it ever feels unfair in play.

**Antes.** Big-blind ante: one ante posted by the big blind for the table. A short
stack posts the ante first and the blind from what remains (TDA convention), so
being all-in for less than one blind is representable. Ante money is dead — it
can never come back as an uncalled bet, which `pots.ts` handles explicitly.

**Blind structure.** Data, not logic (`shared/blinds.ts`). Default targets 60-90
minutes: 100BB starting stacks, eight-minute levels, antes from level 5,
shortening to six minutes from level 9 so a stalled match still terminates. The
fuzzer reports median 60 min / p90 124 min with random players, who bust far
faster than real ones — a floor, and the input to real balancing.

**Raise semantics.** `BET` and `RAISE` both carry `to` (total for the street),
never `by`. `ALL_IN` is sugar the server resolves — including the case where raise
rights are closed and a shove is legally just a call.

**Undersized all-ins.** An all-in short of a full raise does not reopen the
betting for anyone who already acted at that level; they may call or fold only.
Players who had not yet acted keep full rights. This is the standard rule and the
one most implementations get wrong, so it has three dedicated tests.

**Immutability.** `applyAction` never mutates its input; it returns new state.
Callers keep old states for free, and a validation throw can never leave a
half-applied hand behind.

**Chip conservation is asserted in production**, not only in tests. Silently
losing a chip would be experienced by players as the game cheating, which is the
one unacceptable failure mode.

---

## 14. Decisions made in Phase 2

**Whole views, not deltas.** Every state change sends each player a complete
`ClientView`. A view is a few kilobytes and a poker table produces roughly one
message per action, so delta encoding would optimise a problem that does not
exist while introducing an entire class of desync bugs. Narration arrives
separately as an event stream, which is for animation and the log and is never a
source of truth: if the events and the view disagree, the view is right.

**Time is injected.** Everything that waits — action clocks, showdown display,
blind levels, reconnect grace — goes through a `Clock` interface. Tests drive a
manual clock, so a 90-minute match with timeouts runs in milliseconds and no test
sleeps.

**The disconnect policy.** A player who drops keeps their seat, their chips and
their cards; only their clock changes. They get a shortened action timer, but
only while somebody else is still connected — a table that has entirely dropped
out gets the full clock rather than auto-folding its way through the match. A
timeout checks when checking is free and folds only when it must, so a lost
connection never costs a hand it did not have to.

**Actions carry a hand number.** `poker:action` names the hand it was decided in
and is rejected if that hand has ended. Without it, a laggy client can fold a
hand that is already over and have the fold land on the next one.

**Session tokens.** HMAC-SHA256 over a payload carrying player, room and issue
time, compared in constant time, expiring after twelve hours. Player ids are
random, never derived from a name or a seat. Whoever holds the token holds that
seat's hole cards, so nothing about it is guessable.

**Two rate limits, for two different attacks.** Per connection (20 messages a
second, burst 40) against flooding; per address (12 a minute) on lobby
create/join, because that is the code-guessing surface. Without the second, 887
million lobby codes fall quickly and a private lobby is only private by
obscurity.

**Lobby codes read aloud.** Six characters from a 31-character alphabet with no
`0`/`O` and no `1`/`I`/`L`, drawn from the CSPRNG.

**The blind level shown is the level in play.** The view reports the level the
current hand is actually being played at, taken from the table, not the level the
wall clock has reached. A countdown that has run past zero means the blinds go up
when the next hand is dealt. Showing a player 200/400 while they post 50/100
would be a lie, and the first version did exactly that until a test caught it.

**Rooms live in memory.** A match is one 60-90 minute session between friends and
there is nothing worth persisting across a restart yet. `MatchState` is plain
JSON on purpose, so snapshotting is a small change when that stops being true.

---

## 15. Decisions made in Phase 3

**A ring of seven, and the Dealer takes one of them.** Not a casino oval with the
house on one side: a round table where he is simply *one of the seats*, which
makes two players his immediate neighbours and nobody safely opposite him. The
shape should say séance before anything else does.

**Nothing is loaded.** The table, the chairs, the bodies, the Dealer and all
fifty-two card faces are built from primitives and a canvas at startup. No
models, no textures, no asset pipeline, no versioning — the whole scene changes
shape by editing numbers. That will not survive contact with real art direction,
but it is the right trade while the layout is still moving.

**One texture for every card.** The atlas is painted into a single canvas at
startup, so the board and twelve hole cards share one material. Cell geometry is
a pure function with its own tests, because a UV convention error renders every
card upside down and looks like an art problem rather than a maths one.

**The world holds objects; the DOM holds words.** Cards, chips, hands and the
Dealer are in the scene. Names, stacks, the blind clock and the action bar are
DOM on top of it. Text in WebGL is expensive, blurry and awkward to click, and a
bet slider is a bet slider.

**Nameplates sit at chest height, not above heads.** A seated player looks *down*
at the felt, so anything floating over a head is outside the frustum. The first
version put every label behind the top bar where nobody could see it.

**One mesh per finger.** This was the open question from Phase 2, and the answer
is per-finger meshes with procedural placement rather than baked hand poses. The
second sacrifice takes a finger and the hand stays that way for the rest of the
match; that has to be a property of the model, not an animation that ends. Hiding
a mesh is the cheapest possible way to make it permanent, and `Avatar.removeFinger`
already does it.

**Cameras look down -Z; bodies face +Z.** Opposite signs, and mixing them seats
four of six players facing into the dark. The first version did exactly that, and
the test agreed with it because the test restated the same wrong convention. The
tests now build a real `PerspectiveCamera` and ask Three.js which way it is
looking rather than asserting an assumption twice.

**Free-look on drag, not pointer lock.** Pointer lock is the better feel and
Phase 4 should revisit it, but it fights a DOM action bar, and a table you cannot
bet at is not worth looking around. Yaw and pitch are clamped to what someone in
a chair could manage, which does more for feeling stuck at this table than any
amount of geometry.

**The scene is a pure function of the view.** `GameScene.apply(view)` derives
everything from the latest `ClientView` and keeps no history of its own. It never
renders a card it was not given: `visibleFaces` — the single place the client
decides what a card shows — is pulled out as a pure function with its own tests,
so "we never draw a face we do not have" is a property rather than a claim.

### The performance budget

Measured from the seated camera, which is the one players actually use, with
`npm run shots`:

| Players | Draw calls | Triangles |
|---|---|---|
| 4 | 131 | 6.5k |
| 6 | 173 | 8.3k |

The shape that matters is the slope: **about twenty-one draw calls and a thousand
triangles per seated player**, from the twenty or so meshes a body needs in order
to have separately articulated hands. That is affordable at six and would not be
at sixteen, which is fine — the table seats six.

A camera that can see the whole room at once (the debug free-look) costs about
thirty more draw calls than any seat does, because a seated player has the far
half of the room behind their own shoulder. Frustum culling is doing real work
here, and it is worth measuring from a seat rather than from above.

Deliberate choices behind those numbers:

- **Chips are a single `InstancedMesh`.** Several hundred of them, six stacks,
  six bets and the pot, for one draw call. This is the one count that could
  genuinely run away, so it was solved before it became a problem.
- **Materials are shared from one palette**, so the renderer switches material
  state a handful of times per frame rather than once per object.
- **One shadow-casting light.** The lamp over the table, at a 1024² map.
  Everything else is unshadowed fill, and heavy fog does the rest.
- **Pixel ratio is capped at 2.** A 3× display would otherwise quadruple the
  pixel cost of a scene whose point is that most of it is dark.

Frame times were not measured on real hardware — the automated runs use software
rendering, where they mean nothing. Getting a number on a real GPU is worth doing
before Phase 5 adds atmosphere on top of this.

The next lever, if six animated players ever cost too much, is merging each
avatar's static parts into one geometry and keeping only the hands separate. It
is deliberately not done yet: nothing has proved it necessary, and it would trade
away the joint hierarchy that Phase 6's trembling needs.

### What Phase 3 knowingly leaves undone

Lighting is a placeholder — one lamp and some fill, enough to be readable. The
oppressive, dirty, intimate room the brief describes is Phase 5's job, and doing
it now would mean tuning atmosphere against geometry that is still moving. Faces
are featureless blocks for the same reason. Nothing animates yet.
