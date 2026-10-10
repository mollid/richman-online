/* 量「像素字模式把容器撑爆了多少」—— 逐口味量同几行文字的自然宽度 vs 可用宽度。
 *
 * 输入是三种口味下的同一块 DOM，输出是每条被量元素的 (可用宽, 内容自然宽, 行数)。
 * 行数 > 1 就是换行了；差值就是「还差多少像素才能放回一行」。
 * 改 CSS 之前先量，别凭感觉调。
 *
 * 跑法：node design/hud-ac/tools/font-mode-measure.mjs
 */
import { existsSync } from 'node:fs';
import { chromium } from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const URL = process.env.APP_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Administrator/.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe';

const launch = { args: ['--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (existsSync(CHROME)) launch.executablePath = CHROME;

const b = await chromium.launch(launch);
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '本地热座' }).click();
await page.getByRole('button', { name: '开始游戏' }).click();
await page.waitForSelector('#ac-hud-root .hud-topbtns', { timeout: 30000 });
await page.waitForTimeout(8000);

const TARGETS = [
  ['岛民·资产行', '.ac-list__tx small'],
  ['岛民·姓名行', '.ac-list__tx b'],
  ['岛民·排名行', '.hud-rank em'],
  ['面板底注', '.hud-foot'],
  ['顶栏·名字', '.ac-hud__who b'],
];

const measure = () => page.evaluate((targets) => {
  const out = [];
  for (const [label, sel] of targets) {
    const el = document.querySelector(sel);
    if (!el) { out.push([label, null]); continue; }
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    /* scrollWidth 对不换行的块级元素给的是内容宽；为避免浮动误差用 Range 量文本本身。
       两个坑都要避开：
       1) 换行后 clientRects 是**每行一个矩形**，自然宽度要跨行相加（只取 max 会漏掉换行部分，
          第一版就是这么写的，于是量出「差 -2 却报了 2 行」这种自相矛盾的结果）。
       2) **同一行**里的嵌套行内元素也会各出一个矩形，而整段矩形已经覆盖它们 —— 一律相加会把
          「相对榜首 100% · 脚下「起点」」量成 141 + 29 = 170，凭空报出一条不存在的溢出
          （§9 原第 7 条「.hud-rank em 溢出 29px」就是这么来的，实测该元素 max-content 就是 141）。
       所以：按行归组，行内取左右并集，跨行才相加。 */
    const r = document.createRange();
    r.selectNodeContents(el);
    const groups = [];
    for (const q of [...r.getClientRects()]) {
      if (!q.width) continue;
      const g = groups.find((x) => Math.abs(x.top - q.top) < q.height * 0.6);
      if (g) { g.left = Math.min(g.left, q.left); g.right = Math.max(g.right, q.right); }
      else groups.push({ top: q.top, left: q.left, right: q.right });
    }
    const natural = Math.round(groups.reduce((s, g) => s + (g.right - g.left), 0));
    const lines = Math.max(1, Math.round(el.getBoundingClientRect().height / lh));
    out.push([label, {
      font: Math.round(parseFloat(cs.fontSize) * 100) / 100,
      avail: Math.round(el.clientWidth),
      natural,
      lines,
      over: natural - el.clientWidth,
    }]);
  }
  return out;
}, TARGETS);

const toggle = page.locator('[data-host-tools] button').first();
for (const step of [0, 1, 2]) {
  if (step) { await toggle.click(); await page.waitForTimeout(2200); }
  const mode = await page.evaluate(() => document.documentElement.dataset.acFont);
  console.log(`\n【${mode}】`);
  for (const [label, m] of await measure()) {
    if (!m) { console.log(`  ${label.padEnd(12)} —`); continue; }
    const flag = m.lines > 1 ? '⬅ 换行' : '  ';
    console.log(`  ${label.padEnd(12)} ${String(m.font).padStart(5)}px  可用 ${String(m.avail).padStart(3)}  自然 ${String(m.natural).padStart(3)}  差 ${(m.over > 0 ? '+' : '') + m.over}  ${m.lines} 行 ${flag}`);
  }
}

await toggle.click();
await b.close();
