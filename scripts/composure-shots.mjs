#!/usr/bin/env node
/**
 * Steadying yourself, in a real browser.
 *
 * Seats four players, has one press B, and plays whatever the server issued —
 * a breath in time, or a held breath — by dispatching key events from inside
 * the page on the exact rhythm the challenge asked for. Then waits out the
 * cooldown, asks again, and does nothing, to see a fumble.
 *
 * Checks what a screenshot cannot: that the challenge reached only its owner,
 * that following the guide is scored as a success by the server, and that
 * doing nothing is scored as a failure.
 *
 * Needs `npm run dev` running.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.shots/composure';
await mkdir(OUT, { recursive: true });

const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const launch = { args };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
const browser = await chromium.launch(launch);
const problems = [];
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

const pages = [];
for (const name of ['Mara', 'Bern', 'Cass', 'Dov']) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  await page.goto('http://localhost:5173/');
  await page.fill('input[placeholder="Your name"]', name);
  pages.push(page);
}

await pages[0].click('button:has-text("Create lobby")');
await pages[0].waitForSelector('.players');
const code = (await pages[0].textContent('.panel h2')).replace('Lobby ', '').trim();
for (const page of pages.slice(1)) {
  await page.fill('.code-input', code);
  await page.click('button:has-text("Join")');
  await page.waitForSelector('.players');
}
for (const page of pages) await page.click('button:has-text("Ready")');
await pages[0].click('button:has-text("Begin the game")');
await pages[0].waitForSelector('.table-canvas', { timeout: 15_000 });
await pages[0].waitForTimeout(1_500);
// All four stay open: a closed page is a disconnected player, whose short
// clock folds them on their turn and pushes a view to everybody — which is
// exactly what the privacy check below must not be confused by.

const me = pages[0];
const other = pages[1];
const challengeOf = (page) => page.evaluate(() => window.__view()?.you.composure.challenge ?? null);

// --- Done properly, until both kinds have been played ------------------------

/** Plays a challenge on its own rhythm, from inside the page. */
const play = (c) =>
  me.evaluate(async (c) => {
    const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { key: ' ', bubbles: true }));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (c.kind === 'BREATH') {
      key('keydown');
      key('keyup');
      for (const gap of c.spec.gapsMs) {
        await wait(gap);
        key('keydown');
        key('keyup');
      }
    } else {
      key('keydown');
      await wait(c.spec.holdMs);
      key('keyup');
    }
  }, c);

/** Waits out the cooldown, presses B, and returns the new challenge. */
async function ask(previous) {
  const view = await me.evaluate(() => window.__view());
  await me.waitForTimeout(Math.max(0, view.you.composure.readyAt - view.serverTime) + 1_000);
  await me.keyboard.press('b');
  await me.waitForFunction(
    (id) => {
      const c = window.__view()?.you.composure.challenge;
      return c && c.id !== id;
    },
    previous?.id ?? null,
    { timeout: 5_000 },
  );
  return challengeOf(me);
}

const played = new Set();
let challenge = null;
for (let attempt = 0; attempt < 5 && played.size < 2; attempt++) {
  const before = await other.evaluate(() => window.__view()?.serverTime);
  challenge = await ask(challenge);
  console.log(`issued ${challenge.kind} ${JSON.stringify(challenge.spec)}`);
  check((await challengeOf(other)) === null, 'nobody else was told');
  check((await other.evaluate(() => window.__view()?.serverTime)) === before, 'nobody else even received a view');

  if (!played.has(challenge.kind)) {
    // The guide, mid-challenge, before the first key.
    await me.waitForFunction(
      () => Number(getComputedStyle(document.querySelector('.composure')).opacity) > 0.95,
      null,
      { timeout: 15_000 },
    );
    await me.screenshot({ path: `${OUT}/${challenge.kind.toLowerCase()}-guide.png` });
  }
  await play(challenge);
  await me.waitForFunction(
    (id) => window.__view()?.you.composure.result && !window.__view()?.you.composure.challenge,
    challenge.id,
    { timeout: 10_000 },
  );
  const result = await me.evaluate(() => window.__view().you.composure.result);
  check(result.outcome === 'STEADIED', `following the ${challenge.kind} guide was scored ${result.outcome} (${result.quality.toFixed(2)})`);
  if (!played.has(challenge.kind)) await me.screenshot({ path: `${OUT}/${challenge.kind.toLowerCase()}-steadied.png` });
  played.add(challenge.kind);
}
check(played.size === 2, `played both kinds (${[...played].join(', ')})`);

// --- One fumbled ------------------------------------------------------------

challenge = await ask(challenge);
// The guide fades in on rendered frames, and software rendering here is a
// frame or two a second: wait for it rather than for a clock.
await me.waitForFunction(
  () => Number(getComputedStyle(document.querySelector('.composure')).opacity) > 0.95,
  null,
  { timeout: 15_000 },
);

await me.waitForFunction(() => window.__view()?.you.composure.result?.outcome === 'SHAKEN', null, {
  timeout: 20_000,
});
await me.waitForFunction(
  () => Number(document.querySelector('.composure-word')?.style.opacity ?? 0) > 0.5,
  null,
  { timeout: 15_000 },
);
await me.screenshot({ path: `${OUT}/faltered.png` });
const bad = await me.evaluate(() => window.__view().you.composure.result);
check(bad.outcome === 'SHAKEN', `doing nothing was scored ${bad.outcome} (${bad.quality.toFixed(2)})`);

console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
if (failures.length || problems.length) process.exit(1);
