#!/usr/bin/env node
/**
 * Does the room actually make a noise?
 *
 * Web Audio cannot run under vitest, so `cues.test.ts` covers what a sound
 * *means* and this covers whether the engine comes up at all: a real browser, a
 * real click, a real `AudioContext`, and the graph wired to the destination.
 * It cannot hear anything — nothing can, in a headless browser — so it asserts
 * the things that are checkable and leaves the mix to ears.
 */
import { chromium } from 'playwright';

const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
const launch = { args };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
const browser = await chromium.launch(launch);
const problems = [];

const pages = [];
for (const name of ['Mara', 'Bern', 'Cass', 'Dov']) {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${name} console: ${m.text()}`));
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

// A real click on the table, which is what the browser wants before any sound.
await pages[0].mouse.move(450, 300);
await pages[0].mouse.down();
await pages[0].mouse.up();
await pages[0].waitForTimeout(1_500);

const state = await pages[0].evaluate(() => ({
  hasAudioContext: typeof AudioContext !== 'undefined',
  ...(window.__audio?.() ?? { running: 'no hook' }),
}));
console.log('audio:', JSON.stringify(state));
if (state.running !== true) problems.push(`audio did not start: ${JSON.stringify(state)}`);
console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no page errors');
await browser.close();
