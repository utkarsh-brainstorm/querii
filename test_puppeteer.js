const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:8100' });
  const page = (await browser.pages())[0];
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  
  await page.waitForTimeout(1000);
  
  console.log("Calling get_settings...");
  const settings = await page.evaluate(() => window.pywebview.api.get_settings());
  console.log("Settings:", settings);
  
  console.log("Calling get_schema...");
  const schema = await page.evaluate(() => window.pywebview.api.get_schema());
  console.log("Schema:", schema);
  
  console.log("Calling open_file_dialog...");
  // Use race with timeout so we don't hang forever
  const dialogPromise = page.evaluate(() => window.pywebview.api.open_file_dialog());
  const timeoutPromise = new Promise(r => setTimeout(() => r('TIMEOUT'), 3000));
  
  const result = await Promise.race([dialogPromise, timeoutPromise]);
  console.log("Dialog result:", result);
  
  await browser.disconnect();
  process.exit(0);
})();
