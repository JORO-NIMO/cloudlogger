import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const screenshotsDir = path.join(projectRoot, 'screenshots');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_URL = "http://127.0.0.1:8787";

async function runBrowserTestSuite() {
  console.log("Launching Chrome at:", CHROME_PATH);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    protocolTimeout: 180000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  try {
    // -------------------------------------------------------------
    // 1. Desktop Viewport (1440x900)
    // -------------------------------------------------------------
    console.log("1. Testing Desktop Viewport (1440x900)...");
    const desktopPage = await browser.newPage();
    await desktopPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await desktopPage.goto(APP_URL, { waitUntil: 'networkidle0' });
    await desktopPage.screenshot({ path: path.join(screenshotsDir, '01-desktop-initial.png') });
    console.log("Saved 01-desktop-initial.png");

    // -------------------------------------------------------------
    // 2. Tablet Viewport with Touch Emulation (768x1024)
    // -------------------------------------------------------------
    console.log("2. Testing Tablet Viewport with Touch (768x1024)...");
    const tabletPage = await browser.newPage();
    await tabletPage.setViewport({ width: 768, height: 1024, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await tabletPage.goto(APP_URL, { waitUntil: 'networkidle0' });
    await tabletPage.screenshot({ path: path.join(screenshotsDir, '02-tablet-touch.png') });
    console.log("Saved 02-tablet-touch.png");
    await tabletPage.close();

    // -------------------------------------------------------------
    // 3. Mobile Viewport with Touch Emulation (375x812 - iPhone X/12/13/14)
    // -------------------------------------------------------------
    console.log("3. Testing Mobile Viewport with Touch (375x812)...");
    const mobilePage = await browser.newPage();
    await mobilePage.setViewport({ width: 375, height: 812, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    await mobilePage.goto(APP_URL, { waitUntil: 'networkidle0' });
    await mobilePage.screenshot({ path: path.join(screenshotsDir, '03-mobile-touch-375px.png') });
    console.log("Saved 03-mobile-touch-375px.png");

    // Mobile Navigation Drawer Toggle
    console.log("4. Testing Mobile Navigation Drawer...");
    await mobilePage.evaluate(() => document.getElementById('mobileMenuBtn').click());
    await new Promise(r => setTimeout(r, 400));
    await mobilePage.screenshot({ path: path.join(screenshotsDir, '04-mobile-drawer-open.png') });
    console.log("Saved 04-mobile-drawer-open.png");
    await mobilePage.close();

    // -------------------------------------------------------------
    // 4. Small Screen Mobile (320x568 - iPhone SE 1st gen)
    // -------------------------------------------------------------
    console.log("5. Testing Small Screen 320x568...");
    const smallMobilePage = await browser.newPage();
    await smallMobilePage.setViewport({ width: 320, height: 568, hasTouch: true, isMobile: true });
    await smallMobilePage.goto(APP_URL, { waitUntil: 'networkidle0' });
    await smallMobilePage.screenshot({ path: path.join(screenshotsDir, '05-mobile-small-320px.png') });
    console.log("Saved 05-mobile-small-320px.png");
    await smallMobilePage.close();

    // -------------------------------------------------------------
    // 5. Account Creation / Registration Flow
    // -------------------------------------------------------------
    console.log("6. Testing Account Creation Modal & Registration...");
    await desktopPage.evaluate(() => document.getElementById('accountBtn').click());
    await new Promise(r => setTimeout(r, 400));
    await desktopPage.screenshot({ path: path.join(screenshotsDir, '06-account-register-modal.png') });
    console.log("Saved 06-account-register-modal.png");

    // Fill registration form via page evaluate for reliable typing
    await desktopPage.evaluate(() => {
      document.getElementById('regEmail').value = 'founder@startup.io';
      document.getElementById('regPassword').value = 'SuperSecret123!';
      document.getElementById('regSiteName').value = 'E-Commerce Storefront';
      document.getElementById('regDomain').value = 'store.startup.io';
    });

    await desktopPage.evaluate(() => {
      document.getElementById('registerForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    // Wait for account creation response and UI sync
    await new Promise(r => setTimeout(r, 1200));
    await desktopPage.screenshot({ path: path.join(screenshotsDir, '07-account-created-dashboard.png') });
    console.log("Saved 07-account-created-dashboard.png");

    // -------------------------------------------------------------
    // 6. Connected Sites Management & Adding a Site
    // -------------------------------------------------------------
    console.log("7. Testing Connected Sites Modal & Multi-Tenancy...");
    await desktopPage.evaluate(() => document.getElementById('sitesManageBtn').click());
    await new Promise(r => setTimeout(r, 400));

    // Add a second site
    await desktopPage.evaluate(() => {
      document.getElementById('newSiteName').value = 'Stripe Billing Microservice';
      document.getElementById('newSiteDomain').value = 'billing.startup.io';
      document.getElementById('addSiteForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 800));

    await desktopPage.screenshot({ path: path.join(screenshotsDir, '08-connected-sites-manager.png') });
    console.log("Saved 08-connected-sites-manager.png");
    await desktopPage.evaluate(() => document.getElementById('closeSitesBtn').click());

    // -------------------------------------------------------------
    // 7. Integration Code Snippets Modal
    // -------------------------------------------------------------
    console.log("8. Testing Installation Code Snippets Modal...");
    await desktopPage.evaluate(() => document.getElementById('quickSnippetBtn').click());
    await new Promise(r => setTimeout(r, 400));
    await desktopPage.screenshot({ path: path.join(screenshotsDir, '09-installation-snippet-modal.png') });
    console.log("Saved 09-installation-snippet-modal.png");
    await desktopPage.evaluate(() => document.getElementById('closeSnippetBtn').click());

    // -------------------------------------------------------------
    // 8. Interactive Log Ingestion & Payload Inspection
    // -------------------------------------------------------------
    console.log("9. Testing Live Log Ingestion & Payload Inspection...");
    await desktopPage.evaluate(() => document.getElementById('sendTestLogBtn').click());
    await new Promise(r => setTimeout(r, 1200));

    // Inspect payload
    await desktopPage.evaluate(() => {
      const inspectButtons = document.querySelectorAll('button[onclick*="viewPayload"]');
      if (inspectButtons.length > 0) inspectButtons[0].click();
    });
    await new Promise(r => setTimeout(r, 500));
    await desktopPage.screenshot({ path: path.join(screenshotsDir, '10-live-log-ingested-and-payload.png') });
    console.log("Saved 10-live-log-ingested-and-payload.png");
    await desktopPage.evaluate(() => document.getElementById('closePayloadBtn').click());

    // -------------------------------------------------------------
    // 9. Throttled 3G Connection Emulation
    // -------------------------------------------------------------
    console.log("10. Testing Throttled Slow 3G Connection...");
    const throttledPage = await browser.newPage();
    await throttledPage.setViewport({ width: 1280, height: 800 });

    // Emulate Slow 3G: 400kbps download, 400kbps upload, 400ms latency
    const client = await throttledPage.target().createCDPSession();
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: ((400 * 1024) / 8),
      uploadThroughput: ((400 * 1024) / 8)
    });

    console.log("Navigating over Slow 3G...");
    await throttledPage.goto(APP_URL, { waitUntil: 'load', timeout: 45000 });
    await new Promise(r => setTimeout(r, 1500));
    await throttledPage.screenshot({ path: path.join(screenshotsDir, '11-throttled-3g-connection.png') });
    console.log("Saved 11-throttled-3g-connection.png");
    await throttledPage.close();

    // -------------------------------------------------------------
    // 10. Embeddable Frame Mode (?embed=true)
    // -------------------------------------------------------------
    console.log("11. Testing Embeddable Frame Mode (?embed=true)...");
    const embedPage = await browser.newPage();
    await embedPage.setViewport({ width: 900, height: 550 });
    await embedPage.goto(`${APP_URL}/index.html?embed=true&project_id=saas-platform-one`, { waitUntil: 'networkidle0' });
    await embedPage.screenshot({ path: path.join(screenshotsDir, '12-embed-frame-view.png') });
    console.log("Saved 12-embed-frame-view.png");
    await embedPage.close();

    console.log("\n>>> ALL 12 BROWSER TESTING STAGES COMPLETED CLEANLY! <<<");
  } catch (err) {
    console.error("Browser Test Error:", err);
  } finally {
    await browser.close();
  }
}

runBrowserTestSuite();
