#!/usr/bin/env node
/**
 * What the scene costs, with nobody doing anything.
 *
 * Sits four players down, starts a hand and reads the renderer's own counters.
 * Frame times under software rendering mean nothing; draw calls and triangles
 * are the same numbers a real GPU would see, and they are the ones that move
 * when the geometry changes shape.
 */
import { chromium } from 'playwright';

const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const launch = { args };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
const browser = await chromium.launch(launch);

const pages = [];
for (const name of ['Mara', 'Bern', 'Cass', 'Dov']) {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
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

console.log(JSON.stringify(await pages[0].evaluate(() => window.__sceneStats())));
await browser.close();
