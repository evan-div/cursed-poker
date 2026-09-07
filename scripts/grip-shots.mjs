#!/usr/bin/env node
/**
 * A close look at the hand holding the cards.
 *
 * Peels, then pulls past the break so the pair comes off the table, and takes
 * the same moment from three places: the player's own eyes, an opponent's, and
 * a free camera parked beside the grip. The grip is the thing that cannot be
 * checked by reasoning — a hand can satisfy every number in `hold.test.ts` and
 * still look like it is balancing the cards on its knuckles.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.shots/grip';
await mkdir(OUT, { recursive: true });

const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const launch = { args };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
const browser = await chromium.launch(launch);
const problems = [];

async function seat(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  await page.goto('http://localhost:5173/');
  await page.fill('input[placeholder="Your name"]', name);
  return page;
}

const pages = [];
for (const name of ['Mara', 'Bern', 'Cass', 'Dov']) pages.push(await seat(name));

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
await pages[0].waitForTimeout(2_000);

const me = pages[0];
async function look(dx, dy) {
  await me.mouse.move(640, 440);
  await me.mouse.down();
  for (let i = 1; i <= 10; i++) await me.mouse.move(640 + (dx * i) / 10, 440 + (dy * i) / 10);
  await me.mouse.up();
  await me.waitForTimeout(500);
}

await look(0, 130);
await me.waitForSelector('.hud-hint .hint-strong', { timeout: 90_000 });

// Peel, then keep pulling past the break so the pair leaves the felt.
await me.mouse.move(640, 440);
await me.mouse.down({ button: 'right' });
for (let i = 1; i <= 14; i++) await me.mouse.move(640, 440 + (150 * i) / 14);
await me.waitForTimeout(400);
await me.screenshot({ path: `${OUT}/peeling.png` });
console.log('peeling:', JSON.stringify(await me.evaluate(() => window.__bodies().me)));

for (let i = 1; i <= 20; i++) await me.mouse.move(640, 590 + (260 * i) / 20);
await me.waitForTimeout(700);
await me.screenshot({ path: `${OUT}/lifted-own-eyes.png` });
console.log('lifted:', JSON.stringify(await me.evaluate(() => window.__bodies().me)));

await pages[2].waitForTimeout(300);
await pages[2].screenshot({ path: `${OUT}/lifted-from-across.png` });

// A camera right beside the hand, which is the only way to see a grip. Seat 0
// sits at 2*PI/7 round the ring, so its cards come up at about (0.58, 1.0,
// -0.46) and every shot below is aimed there rather than at the table.
const CARDS = [0.58, 1.0, -0.46];
for (const [name, at] of Object.entries({
  'grip-side': [1.35, 1.06, 0.05],
  'grip-front': [0.14, 1.05, -0.95],
  'grip-above': [0.75, 1.45, -0.55],
  'grip-behind': [1.35, 1.2, -1.15],
})) {
  await pages[1].evaluate(
    ([p, look]) => window.__freeLook?.(p[0], p[1], p[2], look),
    [at, CARDS],
  );
  await pages[1].waitForTimeout(600);
  await pages[1].screenshot({ path: `${OUT}/${name}.png` });
}

// What all that rounding costs. Triangles are the number to watch: every hard
// edge traded for a soft one is vertices, and this scene has a lot of edges.
console.log('budget:', JSON.stringify(await pages[1].evaluate(() => window.__sceneStats())));

for (const [name, at] of Object.entries({
  wide: [2.4, 1.8, 2.4],
  overhead: [0.01, 3.0, 0.01],
})) {
  await pages[1].evaluate((p) => window.__freeLook?.(p[0], p[1], p[2]), at);
  await pages[1].waitForTimeout(600);
  await pages[1].screenshot({ path: `${OUT}/${name}.png` });
}

console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
