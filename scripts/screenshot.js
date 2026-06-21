import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

// Captures demo screenshots of the running UI using the system Chrome (no
// browser download). Requires the server to be running on PORT (default 3000).
// Output: docs/screenshots/*.png

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = `http://localhost:${process.env.PORT || 3000}`;
const OUT = 'docs/screenshots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars'],
    defaultViewport: { width: 760, height: 1080, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle0' });

  // Seed some activity so trending + counts look realistic.
  const seed = ['iphone 15', 'iphone 15', 'iphone 15', 'python tutorial', 'python tutorial',
    'chatgpt', 'chatgpt', 'weather today', 'netflix', 'java tutorial'];
  await page.evaluate(async (queries) => {
    for (const q of queries) {
      await fetch('/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    }
    await fetch('/admin/flush', { method: 'POST' });
  }, seed);

  // 1) Suggestions dropdown
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('#search');
  await page.type('#search', 'ip', { delay: 40 });
  await page.waitForSelector('#suggestions:not([hidden])', { timeout: 5000 });
  await sleep(300);
  await page.screenshot({ path: `${OUT}/01-suggestions.png` });
  console.log('saved 01-suggestions.png');

  // 2) Full page after submitting a search (response + trending)
  await page.keyboard.press('Enter');
  await sleep(500);
  await page.screenshot({ path: `${OUT}/02-response-trending.png`, fullPage: true });
  console.log('saved 02-response-trending.png');

  // 3) Basic mode for the same prefix (to contrast ranking visually)
  await page.click('input[value="basic"]');
  await page.click('#search', { clickCount: 3 });
  await page.type('#search', 'iphone', { delay: 40 });
  await page.waitForSelector('#suggestions:not([hidden])', { timeout: 5000 });
  await sleep(300);
  await page.screenshot({ path: `${OUT}/03-basic-mode.png` });
  console.log('saved 03-basic-mode.png');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
