import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const screenshotsDir = path.join(projectRoot, 'screenshots');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LIVE_URL = "https://cloudlogger.pages.dev";

async function captureNewTheme() {
  console.log("Launching Chrome for theme capture...");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.goto(LIVE_URL, { waitUntil: 'networkidle0', timeout: 30000 });

    // 1. Desktop Dashboard with 1/3 Navy, 1/3 White, 1/3 Orange theme + SafeSpaces Logo
    await page.screenshot({ path: path.join(screenshotsDir, '13-navy-orange-dashboard.png') });
    console.log("Saved 13-navy-orange-dashboard.png");

    // 2. Full Page screenshot showing header to safespaceshub.com footer
    await page.screenshot({ path: path.join(screenshotsDir, '17-fullpage-safespaces-footer.png'), fullPage: true });
    console.log("Saved 17-fullpage-safespaces-footer.png");

    // 3. Open Platform Documentation Modal
    await page.evaluate(() => document.getElementById('docsBtn').click());
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(screenshotsDir, '14-platform-docs-modal.png') });
    console.log("Saved 14-platform-docs-modal.png");
    await page.evaluate(() => document.getElementById('closeDocsBtn').click());

    // 4. Open Whop $5 Billing Modal
    await page.evaluate(() => document.getElementById('billingBtn').click());
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(screenshotsDir, '15-whop-billing-modal.png') });
    console.log("Saved 15-whop-billing-modal.png");
    await page.evaluate(() => document.getElementById('closeBillingBtn').click());

    // 5. Mobile Viewport (375x812) with touch
    const mobilePage = await browser.newPage();
    await mobilePage.setViewport({ width: 375, height: 812, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await mobilePage.goto(LIVE_URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await mobilePage.screenshot({ path: path.join(screenshotsDir, '16-mobile-navy-orange.png') });
    console.log("Saved 16-mobile-navy-orange.png");

    console.log("Theme capture complete!");
  } catch (err) {
    console.error("Theme capture error:", err);
  } finally {
    await browser.close();
  }
}

captureNewTheme();


