// Takes screenshots of the real public/index.html (no mock server, no fake data).
// Usage: node scripts/capture.mjs   (needs Google Chrome; set CHROME_PATH to override)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const outDir = path.join(root, 'screenshots');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const types = { '.html': 'text/html', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
  const file = path.join(publicDir, name);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(4173, '127.0.0.1', r));
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
const shot = (page, name, full = false) => page.screenshot({ path: path.join(outDir, name), fullPage: full });
try {
  const desktop = await browser.newPage();
  await desktop.setViewport({ width: 1440, height: 900 });
  await desktop.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
  await shot(desktop, '01-desktop-landing.png', true);
  await desktop.click('#signupBtn');
  await shot(desktop, '02-desktop-create-account.png');
  await desktop.keyboard.press('Escape');
  await desktop.click('#demoBtn');
  await desktop.click('#sitesList .btn-dark');
  await new Promise((r) => setTimeout(r, 600));
  await shot(desktop, '03-desktop-demo-dashboard.png', true);

  const phone = await browser.newPage();
  await phone.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
  await shot(phone, '04-phone-landing.png', true);
  await phone.tap('#demoBtn');
  await shot(phone, '05-phone-demo-dashboard.png', true);

  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('Horizontal scroll on phone:', overflow);
} finally {
  await browser.close();
  server.close();
}
