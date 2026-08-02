const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  try {
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:8100' });
    const pages = await browser.pages();
    if (pages.length === 0) { console.log("No pages."); process.exit(1); }
    const page = pages[0];

    // Get console logs
    const logs = await page.evaluate(() => {
      // If we didn't catch earlier logs, we can at least look for global errors
      return window.errors || [];
    });
    console.log("Captured errors:", logs);

    // Get HTML
    const html = await page.content();
    fs.writeFileSync('debug_dom.html', html);
    
    // Screenshot
    await page.screenshot({ path: 'debug_screenshot.png' });
    
    console.log("Saved DOM and Screenshot.");
    await browser.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Puppeteer error:", err);
    process.exit(1);
  }
})();
