#!/usr/bin/env node
/**
 * What a frightened opponent looks like from across the felt.
 *
 * Seats four players, has one of them pick their cards up, then — on another
 * player's screen only — pins that seat's tells with the dev hook and
 * photographs it calm, then shaking, breathing hard and soaked. Two frames a
 * moment apart at each level, because a tremor is invisible in one still.
 *
 * Needs `npm run dev` running.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.shots/tells';
await mkdir(OUT, { recursive: true });

const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const launch = { args };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
const browser = await chromium.launch(launch);
const problems = [];

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
await pages[0].waitForTimeout(2_000);

// The subject picks their cards up: hold V and pull toward themselves, well
// past the curl and through the break.
const subject = pages[2];
const seat = await subject.evaluate(() => window.__bodies().me.seat);
await subject.mouse.move(640, 200);
await subject.keyboard.down('v');
for (let i = 0; i < 6; i++) {
  await subject.mouse.move(640, 200);
  await subject.mouse.move(640, 790, { steps: 12 });
}
await pages[0].waitForFunction(
  (s) => (window.__bodies().table.find((t) => t.seat === s)?.lift ?? 0) > 0.9,
  seat,
  { timeout: 20_000 },
);

// Nobody else is needed now, and four software-rendered pages run at a frame
// or two a second — which matters, because everything here eases on frame time.
await pages[1].close();
await pages[3].close();

// Seat n sits at (n+1)/7 of the way round the ring. See `body-shots.mjs`.
const STATIONS = 7;
const seatAt = (s, radius, y) => {
  const angle = ((s + 1) / STATIONS) * Math.PI * 2;
  return [Math.sin(angle) * radius, y, -Math.cos(angle) * radius];
};

const viewer = pages[0];
const shots = {
  across: [seatAt(seat, -0.9, 1.25), seatAt(seat, 0.75, 1.05)],
  close: [seatAt(seat, 0.1, 1.22), seatAt(seat, 0.95, 1.14)],
};

const levels = {
  calm: { tremor: 0, breathing: 0, sweat: 'DRY' },
  soaked: { tremor: 1, breathing: 1, sweat: 'SOAKED' },
};

for (const [level, tells] of Object.entries(levels)) {
  await viewer.evaluate(([s, t]) => window.__tells(s, t), [seat, tells]);
  // Sweat takes a few seconds to come up; wait for it rather than for a clock.
  await viewer.waitForFunction(
    ([s, want]) => Math.abs(window.__tells(s).sweat - want) < 0.03,
    [seat, tells.sweat === 'SOAKED' ? 1 : 0],
    { timeout: 120_000, polling: 200 },
  ).catch(() => problems.push(`sweat never settled at ${level}`));

  for (const [name, [from, at]] of Object.entries(shots)) {
    await viewer.evaluate(([p, look]) => window.__freeLook?.(p[0], p[1], p[2], look), [from, at]);
    await viewer.waitForTimeout(400);
    await viewer.screenshot({ path: `${OUT}/${level}-${name}-a.png` });
    await viewer.waitForTimeout(90);
    await viewer.screenshot({ path: `${OUT}/${level}-${name}-b.png` });
  }
}

console.log(`subject seat ${seat}`);
console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
