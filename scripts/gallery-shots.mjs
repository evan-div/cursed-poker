#!/usr/bin/env node
/**
 * Moments of play that the other shot scripts do not reach.
 *
 *   MODE=hand   the lobby, a flop, leaning in over it, and a showdown
 *   MODE=dread  short stacks and shoves until chairs empty and the room darkens
 *               (run the server with DEV_FAST=1 for this one)
 *
 * Four players, every one driven through the real UI by its keys. Waits on
 * conditions rather than clocks throughout: four software-rendered pages run
 * at a frame or two a second.
 *
 * Needs `npm run dev` running. Reads `CHROME` and `OUT`.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const MODE = process.env.MODE ?? 'hand';
const OUT = process.env.OUT ?? '.shots/gallery';
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
  // The cheap tier unless asked: a software renderer cannot afford the lens,
  // and these pictures are of what bodies do, not of the light. QUALITY=high
  // overrides it; see `scripts/look-shots.mjs` for photographing the room.
  await page.goto(`http://localhost:5173/?quality=${process.env.QUALITY ?? 'low'}`);
  await page.fill('input[placeholder="Your name"]', name);
  pages.push(page);
}
const me = pages[0];

await me.click('button:has-text("Create lobby")');
await me.waitForSelector('.players');
const code = (await me.textContent('.panel h2')).replace('Lobby ', '').trim();
for (const page of pages.slice(1)) {
  await page.fill('.code-input', code);
  await page.click('button:has-text("Join")');
  await page.waitForSelector('.players');
}
for (const page of pages.slice(1)) await page.click('button:has-text("Ready")');
if (MODE === 'hand') await me.screenshot({ path: `${OUT}/lobby.png` });
await me.click('button:has-text("Ready")');
await me.click('button:has-text("Begin the game")');
await me.waitForSelector('.table-canvas', { timeout: 180_000 });

const view = (page) => page.evaluate(() => window.__view());
/** Whoever may act presses `key`; returns whether anybody did. */
async function actWith(key) {
  for (const page of pages) {
    if (page.isClosed()) continue;
    const legal = await page.evaluate(() => window.__view()?.you.legalActions);
    if (legal) {
      await page.keyboard.press(key);
      await page.waitForTimeout(400);
      return true;
    }
  }
  await me.waitForTimeout(400);
  return false;
}
/** Settles the camera: the resting gaze is on your own cards. */
const settle = (ms = 2_500) => me.waitForTimeout(ms);

if (MODE === 'hand') {
  // To the flop, everybody checking or calling.
  for (let i = 0; i < 40 && ((await view(me)).hand?.board.length ?? 0) < 3; i++) await actWith('c');
  await settle(4_000);
  await me.screenshot({ path: `${OUT}/flop.png` });

  // Leaning in over the board. The lean follows the line of sight, so look up
  // from your own hand to the board first (drag upward), then roll the wheel.
  await me.mouse.move(640, 520);
  await me.mouse.down();
  await me.mouse.move(640, 492, { steps: 8 });
  await me.mouse.up();
  await settle(2_000);
  // No mouse move before the wheel: the click above took pointer lock, and
  // under lock every move is a look.
  for (let i = 0; i < 5; i++) {
    await me.mouse.wheel(0, -120);
    await me.waitForTimeout(80);
  }
  await settle(4_000);
  await me.screenshot({ path: `${OUT}/leaning-in.png` });
  for (let i = 0; i < 5; i++) await me.mouse.wheel(0, 120);

  // On to a showdown, and photograph the cards turned over at every seat.
  for (let i = 0; i < 60; i++) {
    const v = await view(me);
    if (v.hand?.seats.some((s) => s.revealedCards)) break;
    await actWith('c');
  }
  await me.evaluate(() => window.__freeLook(0, 2.3, 0.9, [0, 0.75, -0.15]));
  await settle(1_500);
  await me.screenshot({ path: `${OUT}/showdown.png` });
}

if (MODE === 'dread') {
  // Shove until two chairs are empty. The room only ever gets worse.
  const busted = () =>
    me.evaluate(() => (window.__view()?.players ?? []).filter((p) => !p.seated).length);
  for (let i = 0; i < 400 && (await busted()) < 2; i++) await actWith('a');
  // Who is still sitting, and is it us?
  const v = await view(me);
  console.log(`busted ${v.players.filter((p) => !p.seated).map((p) => p.displayName).join(', ')}`);
  const watcher = pages.find((_, i) => v.players[i]?.seated) ?? me;
  const dread = await watcher.evaluate(() => window.__bodies?.());
  console.log(`frame age ${dread?.frameAgeMs}`);
  await watcher.waitForTimeout(5_000);
  await watcher.screenshot({ path: `${OUT}/dark-room-seated.png` });
  await watcher.evaluate(() => window.__freeLook(0, 1.7, 2.4, [0, 1.0, -0.6]));
  await watcher.waitForTimeout(3_000);
  await watcher.screenshot({ path: `${OUT}/dark-room-wide.png` });
  await watcher.evaluate(() => window.__freeLook(0, 1.5, 0.6, [0, 1.6, -1.07]));
  await watcher.waitForTimeout(2_000);
  await watcher.screenshot({ path: `${OUT}/dealer-late.png` });
}

console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
