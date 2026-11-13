#!/usr/bin/env node
/**
 * What the room looks like, from the same places every time.
 *
 * The other shot scripts photograph *moments* — a peek, a tell, a showdown.
 * This one photographs the *room*: a fixed set of camera positions, so a change
 * to a material, a light or a piece of furniture can be judged against the
 * picture taken before it. Run it, change something, run it again with a
 * different `OUT`, and put the two folders side by side.
 *
 * Four players sit down and play to the flop, so there are cards, chips, bets
 * and a pot on the table; then one page walks the camera round.
 *
 *   OUT=.shots/look   where the pictures go
 *   QUALITY=high      which quality tier to photograph (see `quality.ts`)
 *   DREAD=0.8         pin the room's dread for the wide shots (development hook)
 *   ONLY=seat,wide    just these shots
 *   W=1280 H=800      the size of the picture
 *
 * Needs `npm run dev` running, with `ACTION_TIMEOUT_MS=600000`. Reads `CHROME`.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.shots/look';
const QUALITY = process.env.QUALITY ?? 'high';
const DREAD = process.env.DREAD === undefined ? null : Number(process.env.DREAD);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const SIZE = { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) };
await mkdir(OUT, { recursive: true });

const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const launch = { args };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
const browser = await chromium.launch(launch);
const problems = [];

const pages = [];
for (const name of ['Mara', 'Bern', 'Cass', 'Dov']) {
  // Only the page being photographed is drawn at full size, or pays for the
  // expensive tier: under a software renderer the other three are pure cost.
  const first = pages.length === 0;
  const viewport = first ? SIZE : { width: 320, height: 200 };
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${name} console: ${m.text()}`);
  });
  await page.goto(`http://localhost:5173/?quality=${first ? QUALITY : 'low'}`);
  await page.fill('input[placeholder="Your name"]', name);
  pages.push(page);
}
const me = pages[0];

await me.click('button:has-text("Create lobby")');
await me.waitForSelector('.players');
const code = await me.evaluate(() => window.__view().room.code);
for (const page of pages.slice(1)) {
  await page.fill('.code-input', code);
  await page.click('button:has-text("Join")');
  await page.waitForSelector('.players');
}
for (const page of pages) await page.click('button:has-text("Ready")');
await me.click('button:has-text("Begin the game")');
await me.waitForSelector('.table-canvas', { timeout: 300_000 });

const view = () => me.evaluate(() => window.__view());
async function actWith(key) {
  for (const page of pages) {
    const legal = await page.evaluate(() => window.__view()?.you.legalActions);
    if (legal) {
      await page.keyboard.press(key);
      await page.waitForTimeout(350);
      return true;
    }
  }
  await me.waitForTimeout(350);
  return false;
}

// To the flop with one bet out on it, so there is something of everything.
for (let i = 0; i < 40 && ((await view()).hand?.board.length ?? 0) < 3; i++) await actWith('c');
await actWith('r');

if (DREAD !== null) await me.evaluate((level) => window.__dread?.(level), DREAD);

/** Waits for a number of frames to have actually been drawn, however slow they are. */
async function frames(count) {
  await me.evaluate(
    (n) =>
      new Promise((resolve) => {
        let left = n;
        const tick = () => (--left <= 0 ? resolve(undefined) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );
}

const SHOTS = [
  // name, camera x y z, look-at x y z
  ['seat', null],
  ['wide', [0, 1.75, 2.75], [0, 1.0, -0.4]],
  ['table', [0.0, 1.75, 1.25], [0, 0.76, -0.05]],
  ['dealer', [0.05, 1.42, 0.35], [0, 1.52, -1.07]],
  ['felt', [0.25, 1.05, 0.5], [-0.05, 0.76, -0.1]],
  ['board', [0.0, 1.02, 0.14], [0, 0.76, -0.07]],
  ['chips', [0.62, 0.95, 0.55], [0.36, 0.78, 0.32]],
  ['faces', [-0.2, 1.3, -0.25], [0.6, 1.16, 0.75]],
  ['corner', [1.9, 1.6, 1.9], [-1.2, 1.1, -1.6]],
  ['door', [0.9, 1.35, 0.6], [0, 1.25, -3.2]],
  ['above', [0, 2.6, 0.02], [0, 0.76, 0]],
];

for (const [name, from, at] of SHOTS) {
  if (ONLY && !ONLY.has(name)) continue;
  if (from) await me.evaluate(([f, a]) => window.__freeLook(f[0], f[1], f[2], a), [from, at]);
  await frames(name === 'seat' ? 8 : 4);
  await me.screenshot({ path: `${OUT}/${name}.png`, timeout: 240_000 });
  console.log(`shot ${name}`);
}

console.log(JSON.stringify(await me.evaluate(() => window.__sceneStats())));
console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
