#!/usr/bin/env node
/**
 * What fear looks like from the inside.
 *
 * Seats four players, then forces one of them through a range of stress levels
 * with the dev hook and photographs their own view at each. Also checks the
 * three things about first-person feedback that a screenshot cannot show:
 *
 *   - the private `self` channel is actually arriving (the felt heart moves off
 *     resting once a hand is dealt, before anything is forced);
 *   - the camera shakes while the reported gaze holds still;
 *   - tunnel vision sits under the HUD, so it can never cover a button.
 *
 * Needs `npm run dev` running.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.shots/feel';
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
await pages[0].waitForTimeout(2_500);

const me = pages[0];

/**
 * Waits for the felt stress to settle on something, rather than for a fixed
 * time: four software-rendered pages run at a few frames a second, and the
 * body eases on frame time, so wall-clock waits measure the machine instead.
 */
const settleOn = (predicate, label) =>
  me
    .waitForFunction(predicate, null, { timeout: 30_000, polling: 100 })
    .catch(() => failures.push(`never settled: ${label}`));

// The private channel is live: the heart has been told something.
const before = await me.evaluate(() => window.__feel());
check(before.stress > 0, `own heart is moving before anything is forced (stress ${before.stress.toFixed(3)}, ${before.heartRate.toFixed(1)} bpm)`);

for (const stress of [0, 0.5, 0.8, 1]) {
  await me.evaluate((s) => window.__feel(s), stress);
  await me.waitForFunction((s) => Math.abs(window.__feel().stress - s) < 0.02, stress, {
    timeout: 30_000,
    polling: 100,
  });
  await me.screenshot({ path: `${OUT}/stress-${String(stress).replace('.', '_')}.png` });
}

// Shake without gaze: at full panic the camera is moving every frame and the
// reported target is not.
const samples = await me.evaluate(async () => {
  const out = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const felt = window.__feel();
    out.push({ shake: felt.shake, gaze: JSON.stringify(felt.gaze), tunnel: felt.tunnel });
  }
  return out;
});
const shakes = new Set(samples.map((s) => `${s.shake.yaw.toFixed(5)},${s.shake.pitch.toFixed(5)}`));
const gazes = new Set(samples.map((s) => s.gaze));
check(shakes.size > 20, `the head is shaking at full panic (${shakes.size} distinct poses in 40 frames)`);
check(gazes.size === 1, `the reported gaze holds still meanwhile (${[...gazes].join(' | ')})`);
check(samples.every((s) => s.tunnel > 0.5), 'the edges have closed in');

// The stacking rule: whatever is on top at the HUD's buttons and nameplates is
// the HUD or a nameplate, never the vignette.
const stacking = await me.evaluate(() => {
  const order = [...document.querySelector('.stage').children].map((c) => c.className.split(' ')[0]);
  const tunnel = order.indexOf('tunnel');
  return {
    order,
    belowPoker: tunnel > order.indexOf('table-canvas') &&
      tunnel < order.indexOf('nameplates') &&
      tunnel < order.indexOf('hud'),
  };
});
check(stacking.belowPoker, `tunnel sits between the table and the HUD (${stacking.order.join(' > ')})`);

// And hands back.
await me.evaluate(() => window.__feel(null));
await settleOn(() => Math.abs(window.__feel().stress - window.__feel().reported) < 0.05, 'handing back');
const after = await me.evaluate(() => window.__feel());
check(after.reported < 0.5 && Math.abs(after.stress - after.reported) < 0.05, `hands back to the server (felt ${after.stress.toFixed(3)}, reported ${after.reported.toFixed(3)})`);

console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
if (failures.length || problems.length) process.exit(1);
