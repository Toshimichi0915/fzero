// Drive the UI with keys and take screenshots at each step.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const steps = JSON.parse(process.argv[3]); // [[waitMs, key|null, shotName|null, js?]]
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (!m.text().includes('vite') && !m.text().includes('GPU stall')) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(process.argv[4] || 'http://localhost:5173/', { waitUntil: 'load' });
for (const [wait, key, shot, js] of steps) {
  await new Promise((r) => setTimeout(r, wait));
  if (key) { if (key.startsWith('hold:')) { const [, k, ms] = key.split(':'); await page.keyboard.down(k); await new Promise(r=>setTimeout(r, +ms)); await page.keyboard.up(k);} else await page.keyboard.press(key); }
  if (js) { try { const r = await page.evaluate(js); if (r !== undefined) logs.push('[eval] ' + JSON.stringify(r)); } catch (e) { logs.push('[evalerr] ' + e.message); } }
  if (shot) await page.screenshot({ path: `${out}/${shot}.png` });
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
