/* 「像素字口味」3 倍放大对照：同一块界面区域，三种口味各截一条，拼成一竖排。
 *
 * 为什么要放大看：像素字清不清晰，在 1440×900 的整屏截图里看不出来 ——
 * 糊是「半像素灰边」，缩到 1/3 就没了。只有把 devicePixelRatio 拉到 3、
 * 截一小块，才能看到每个字到底是不是方硬的格子。
 *
 * 跑法：
 *   node design/hud-ac/tools/font-mode-zoom.mjs
 */
import { existsSync } from 'node:fs';
import { chromium } from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const URL = process.env.APP_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Administrator/.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe';
const OUT = process.env.OUT_DIR || '.';

const launch = { args: ['--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (existsSync(CHROME)) launch.executablePath = CHROME;

const b = await chromium.launch(launch);
/* DPR=3：Playwright 会按设备像素出图，等价于把这块区域放大 3 倍看 */
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '本地热座' }).click();
await page.getByRole('button', { name: '开始游戏' }).click();
await page.waitForSelector('#ac-hud-root .hud-topbtns', { timeout: 30000 });
await page.waitForTimeout(9000);

const toggle = page.locator('[data-host-tools] button').first();
const mode = () => page.evaluate(() => document.documentElement.dataset.acFont || 'round');

/* 只截「文字密度最高」的两块：状态条（含中文 + 数字 + 符号）与右侧岛民面板。
   位置不写死 —— 按元素实际包围盒算，否则换一版布局就全截到空白（第一次就踩了）。 */
const REGIONS = {
  status: '.hud-status',
  panel: '.hud-side .ac-panel, .hud-side',
};

async function clipOf(selectors) {
  return page.evaluate((sels) => {
    for (const s of sels.split(',').map((x) => x.trim())) {
      const el = document.querySelector(s);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) {
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        }
      }
    }
    return null;
  }, selectors);
}

const clips = {};
for (const [name, sel] of Object.entries(REGIONS)) {
  clips[name] = await clipOf(sel);
  console.log(`  ${name}: ${clips[name] ? JSON.stringify(clips[name]) : '未找到元素'}`);
}

const shots = [];
for (const step of [0, 1, 2]) {
  if (step) { await toggle.click(); await page.waitForTimeout(2400); }
  const m = await mode();
  for (const [name, clip] of Object.entries(clips)) {
    if (!clip) continue;
    const file = `${OUT}/zoom-${name}-${m}.png`;
    await page.screenshot({ path: file, clip });
    shots.push(file);
  }
  console.log(`  ${m.padEnd(6)} → zoom-{${Object.keys(clips).join(',')}}-${m}.png`);
}

await toggle.click();
await page.waitForTimeout(1000);
console.log(`  循环回位：${await mode()}`);
await b.close();
