#!/usr/bin/env node
/**
 * Portraits of the people at the table.
 *
 * The seated camera looks down at the felt, which is right for playing and
 * useless for checking whether a body reads as a body. This parks a camera
 * across the table at eye height and aims it at somebody's head, which is the
 * only way to see what a player sees when they look up at an opponent.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.shots/bodies';
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
await pages[0].waitForTimeout(3_000);

// Seat n sits at (n+1)/7 of the way round the ring, at radius 1.02. Eyes at
// about 1.16, which is where a head is.
const STATIONS = 7;
const seatAt = (seat, radius, y) => {
  const angle = ((seat + 1) / STATIONS) * Math.PI * 2;
  return [Math.sin(angle) * radius, y, -Math.cos(angle) * radius];
};

// The Dealer stands at station 0, a metre and a bit back from the middle, with
// whatever is under the hood about one-seven off the floor.
const DEALER_FACE = [0, 1.68, -1.07];

const shots = {
  // Him, from across his own table.
  'dealer': [[0, 1.5, 1.5], DEALER_FACE],
  'dealer-close': [[0.5, 1.6, 0.1], DEALER_FACE],
  // Across the table from seat 1, at the height of their face.
  'face-on': [seatAt(1, -1.55, 1.2), seatAt(1, 1.02, 1.16)],
  // Two seats along, which is the angle most opponents are actually seen from.
  'three-quarter': [seatAt(3, 1.5, 1.25), seatAt(1, 1.02, 1.16)],
  // Far enough back to see whole bodies rather than heads.
  'seated-figures': [seatAt(5, 2.1, 1.5), seatAt(1, 1.02, 1.0)],
};

for (const [name, [from, at]] of Object.entries(shots)) {
  await pages[0].evaluate(([p, look]) => window.__freeLook?.(p[0], p[1], p[2], look), [from, at]);
  await pages[0].waitForTimeout(700);
  await pages[0].screenshot({ path: `${OUT}/${name}.png` });
}

console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
