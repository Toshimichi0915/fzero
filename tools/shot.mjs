// Usage: node tools/shot.mjs <url> <out.png> [waitMs] [js-to-eval-before-shot]
import puppeteer from 'puppeteer-core';
const [url, out, wait = '4000', js = ''] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required', ...(process.env.UNCAP ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])],
  defaultViewport: { width: +(process.env.W || 1600), height: +(process.env.H || 900) },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await new Promise((r) => setTimeout(r, Number(wait)));
if (js) {
  try { const r = await page.evaluate(js); if (r !== undefined) logs.push('[eval] ' + JSON.stringify(r)); } catch (e) { logs.push('[evalerr] ' + e.message); }
  await new Promise((r) => setTimeout(r, 1500));
}
await page.screenshot({ path: out });
console.log(logs.filter(l=>!l.includes('vite')).slice(0, 60).join('\n'));
await browser.close();
