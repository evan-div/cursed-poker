#!/usr/bin/env node
/**
 * Drives real browsers around the table and takes screenshots.
 *
 * A 3D scene has failure modes no unit test reaches — geometry in the wrong
 * place, a camera pointed into the dark, a light that eats its own subject —
 * and every one of those was found this way rather than by reasoning about it.
 * This is a development tool, not a test: it needs both dev servers running and
 * it asserts nothing. Look at the pictures.
 *
 *   npm run dev                       # in another terminal
 *   node scripts/table-shots.mjs      # writes to .shots/
 *
 * Environment:
 *   PLAYERS=6                seats to fill
 *   OUT=.shots               where the images go
 *   CHROME=/path/to/chrome   browser binary, if Playwright's own is missing
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const PLAYERS = Number(process.env.PLAYERS ?? 6);
const OUT = process.env.OUT ?? '.shots';
const NAMES = ['Mara', 'Bern', 'Cass', 'Dov', 'Ilse', 'Prew'];

await mkdir(OUT, { recursive: true });

const launch = { args: ['--no-sandbox'] };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
// Software rendering, so this works on a machine with no GPU. Frame times under
// it mean nothing; draw calls and triangle counts are the same either way.
if (process.env.SOFTWARE_GL === '1') {
  launch.args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
}

const browser = await chromium.launch(launch);
const problems = [];

async function seat(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`${name}: ${error.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${name} console: ${m.text()}`));
  await page.goto('http://localhost:5173/');
  await page.fill('input[placeholder="Your name"]', name);
  return page;
}

const pages = [];
for (const name of NAMES.slice(0, PLAYERS)) pages.push(await seat(name));

await pages[0].click('button:has-text("Create lobby")');
await pages[0].waitForSelector('.players');
const code = (await pages[0].textContent('.panel h2')).replace('Lobby ', '').trim();
console.log(`lobby ${code}, ${PLAYERS} players`);

for (const page of pages.slice(1)) {
  await page.fill('.code-input', code);
  await page.click('button:has-text("Join")');
  await page.waitForSelector('.players');
}
for (const page of pages) await page.click('button:has-text("Ready")');
await pages[0].click('button:has-text("Begin the game")');
await pages[0].waitForSelector('.table-canvas', { timeout: 15_000 });
await pages[0].waitForTimeout(2_000);

const shot = (name) => pages[0].screenshot({ path: `${OUT}/${name}.png` });

/** Drags on the canvas the way a player turns their head. */
async function look(dx, dy) {
  await pages[0].mouse.move(720, 500);
  await pages[0].mouse.down();
  for (let i = 1; i <= 10; i++) await pages[0].mouse.move(720 + (dx * i) / 10, 500 + (dy * i) / 10);
  await pages[0].mouse.up();
  await pages[0].waitForTimeout(600);
}

await shot('seated');

/**
 * Lifts the local player's cards, the way a player does.
 *
 * Right button held, pointer drawn toward them. The card should come up off the
 * felt and tilt its face into the camera; if it does not, either the pose maths
 * or the peek plumbing is wrong, and the screenshot says which.
 */
async function peek(page, pixels) {
  await page.mouse.move(720, 500);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 12; i++) await page.mouse.move(720, 500 + (pixels * i) / 12);
  await page.waitForTimeout(300);
}

async function dropCards(page) {
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
}

// Get the head down over the cards *before* waiting for a hand. Everything
// between the wait and the peek is a race against the action clock: this player
// is not acting, so they will be folded out of the hand in thirty seconds, and
// the earlier shots in this file were all of an empty felt because of it.
await look(0, 130);
await shot('looking-at-own-cards');

// The prompt to peek exists only while this player is in a live hand and has
// not looked yet, so it is exactly the right signal to wait on.
await pages[0].waitForSelector('.hud-hint .hint-strong', { timeout: 90_000 });

await peek(pages[0], 70);
await shot('peek-partial');
await peek(pages[0], 130);
await shot('peek-full');

// And what the rest of the table sees while that is happening: a lifted card
// with nothing on it. This is the shot that matters.
await pages[2 % PLAYERS].waitForTimeout(300);
await pages[2 % PLAYERS].screenshot({ path: `${OUT}/peek-from-across-the-table.png` });

// Numbers, because the room is dark and a body blocks its own cards. This is
// the only honest way to ask whether the table actually saw it.
console.log('peeker:', JSON.stringify(await pages[0].evaluate(() => window.__bodies().me)));
console.log(
  'as the table sees it:',
  JSON.stringify(await pages[2 % PLAYERS].evaluate(() => window.__bodies().table)),
);

await dropCards(pages[0]);
await shot('cards-down');
await look(0, -130);

// Measured from the seated camera, because that is the one players use. The
// free-look positions below see the whole room at once and flatter nothing.
const budget = await pages[0].evaluate(async () => {
  const frames = [];
  let last = performance.now();
  await new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (++n < 90) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  frames.sort((a, b) => a - b);
  return { ...window.__sceneStats(), medianFrameMs: Number(frames[45].toFixed(2)) };
});
console.log('budget (seated):', JSON.stringify(budget));

await look(0, -150);
await shot('seated-looking-up');
await look(240, 0);
await shot('seated-toward-dealer');

// The free camera exists only in development builds.
for (const [name, at] of Object.entries({
  overhead: [0.01, 3.2, 0.01],
  wide: [2.6, 1.9, 2.6],
  across: [0, 1.5, 2.4],
})) {
  await pages[0].evaluate((p) => window.__freeLook?.(p[0], p[1], p[2]), at);
  await pages[0].waitForTimeout(400);
  await shot(name);
}

// With PLAY=<seconds> and a server in DEV_FAST mode, let the match run itself
// on action timeouts until somebody busts — the fastest way to see an empty
// chair without playing a tournament by hand.
const play = Number(process.env.PLAY ?? 0);
if (play > 0) {
  console.log(`letting the match run for ${play}s…`);
  const until = Date.now() + play * 1000;
  while (Date.now() < until) {
    const gone = await pages[0].evaluate(
      () => document.querySelectorAll('.plate').length,
    );
    await pages[0].waitForTimeout(2_000);
    if (gone < PLAYERS) break;
  }
  await pages[0].evaluate(() => window.__freeLook?.(1.9, 1.5, 1.9));
  await pages[0].waitForTimeout(500);
  await shot('after-elimination');
}

console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
console.log(`screenshots in ${OUT}/`);
await browser.close();
