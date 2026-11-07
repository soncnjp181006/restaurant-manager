import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  console.log('Current URL:', page.url());
  const html = await page.content();
  const testIds = [...html.matchAll(/data-testid=["']([^"']+)["']/g)].map(m => m[1]);
  console.log('Test IDs on page:', [...new Set(testIds)]);
  await browser.close();
})().catch(console.error);
