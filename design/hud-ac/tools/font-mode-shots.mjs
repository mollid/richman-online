/* 「像素字口味」实机截图：在真实对局里逐个口味截一张，用来看实际效果。
 *
 * 为什么要脚本而不是手点：口味开关挂在 <html> 的 class 上，而弹层 / 横幅 / 既有 React 面板
 * 是 #ac-hud-root 的兄弟节点，肉眼看不出「哪几块跟着变了、哪几块没变」。
 * 一次跑完三种口味、同一机位、同一帧，才好并排比较。
 *
 * 跑法（需要 docker 全栈已起）：
 *   node design/hud-ac/tools/font-mode-shots.mjs
 *   APP_URL=http://localhost:8080 node design/hud-ac/tools/font-mode-shots.mjs
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
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });

/* ── 走到真实对局：本地热座 → 开始游戏 ───────────────────────────────── */
await page.getByRole('button', { name: '本地热座' }).click();
await page.getByRole('button', { name: '开始游戏' }).click();
await page.waitForSelector('#ac-hud-root .hud-topbtns', { timeout: 30000 });
/* 棋盘相机入场动画 + 首帧渲染，留足时间（截图环境是 swiftshader 软渲染，帧率只有个位数） */
await page.waitForTimeout(9000);

const fontMode = () => page.evaluate(() => document.documentElement.dataset.acFont || '(none)');
const label = (m) => ({ round: 'round', pix12: 'fusion', qiuye: 'qiuye' }[m] || m);

/* 只走真按钮：顶栏第一个宿主工具按钮就是口味开关（见 AcHudLayer 的 tools 数组） */
const toggle = page.locator('[data-host-tools] button').first();

const shot = async (name) => {
  const mode = await fontMode();
  const file = `${OUT}/hud-font-${label(mode)}.png`;
  await page.screenshot({ path: file });
  console.log(`  ${mode.padEnd(6)} → ${file}`);
};

console.log('口味截图（真实对局，1440×900）');
await shot();

await toggle.click();
await page.waitForTimeout(2200);
await shot();

await toggle.click();
await page.waitForTimeout(2500);
await shot();

/* 秋叶模式下的侧栏页签 —— 内容适配主要就发生在这一栏，逐页签留档 */
const cur0 = await fontMode();
if (cur0 !== 'qiuye') {
  for (let i = 0; i < 3; i++) {
    if ((await fontMode()) === 'qiuye') break;
    await toggle.click();
    await page.waitForTimeout(1500);
  }
}
for (const tab of ['岛民', '股市', '账本']) {
  const btn = page.locator(`.hud-topbtns [data-tab="${tab}"]`);
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(900); }
  const file = `${OUT}/hud-font-qiuye-tab-${tab}.png`;
  await page.screenshot({ path: file });
  console.log(`  qiuye·${tab} → ${file}`);
}

/* 回到默认口味，顺带验证第三档能绕回来 */
await toggle.click();
await page.waitForTimeout(1200);
const back = await fontMode();
console.log(`  循环回位：${back}`);

await b.close();

const real = errs.filter((t) => !/favicon/.test(t));
console.log(real.length ? `\n控制台 ${real.length} 条：\n  ` + real.slice(0, 6).join('\n  ') : '\n控制台 0 error');
if (real.length) process.exitCode = 1;
