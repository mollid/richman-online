/* 像素字口味的**全量溢出审计**：对给定口味，遍历 HUD 里所有可见元素，
 * 列出「内容比盒子宽/高」的地方，按严重程度排序。
 *
 * 为什么不靠截图找：16px 的秋叶圆体比原字号大 ~45%，撑爆的地方散落在
 * 顶栏 / 状态条 / 侧栏 / 弹层 / 行囊 / 地块信息条……一屏截图只能看到一个角度，
 * 而且很多溢出不显眼（文字刚好顶到边缘）。逐元素量一遍才是完整清单。
 *
 * 口径：
 *   - 只看 `overflow` 为 visible 的元素（auto/scroll 的滚动容器是设计如此，另报但不算账）
 *   - 横向容忍 2px、纵向容忍 6px（亚像素取整误差）
 *   - 同一条紧凑路径只报最严重的一条
 *
 * 跑法：
 *   node design/hud-ac/tools/font-mode-audit.mjs                # 逐口味各跑一遍
 *   node design/hud-ac/tools/font-mode-audit.mjs qiuye          # 只跑指定口味
 */
import { existsSync } from 'node:fs';
import { chromium } from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const URL = process.env.APP_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Administrator/.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe';
const ONLY = process.argv[2] || '';

const launch = { args: ['--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (existsSync(CHROME)) launch.executablePath = CHROME;

const b = await chromium.launch(launch);
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '本地热座' }).click();
await page.getByRole('button', { name: '开始游戏' }).click();
await page.waitForSelector('#ac-hud-root .hud-topbtns', { timeout: 30000 });
await page.waitForTimeout(8000);

const audit = () => page.evaluate(() => {
  const tolX = 2, tolY = 6;
  const roots = [
    document.querySelector('#ac-hud-root'),
    document.querySelector('.ac-banners'),
    document.querySelector('.ac-sheet'),
  ].filter(Boolean);

  const path = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; n && i < 5; i++, n = n.parentElement) {
      const cls = (n.className && typeof n.className === 'string')
        ? n.className.trim().split(/\s+/).filter((c) => !/^(is-|has-)/.test(c))[0] || ''
        : '';
      parts.push(n.tagName.toLowerCase() + (cls ? '.' + cls : ''));
      if (/^(html|body)$/.test(n.tagName.toLowerCase())) break;
    }
    return parts.reverse().join(' > ');
  };

  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (!root.contains(el)) continue;

      const scrollX = cs.overflowX, scrollY = cs.overflowY;
      const isScroller = /^(auto|scroll|hidden)$/.test(scrollX) || /^(auto|scroll|hidden)$/.test(scrollY);
      const dx = el.scrollWidth - el.clientWidth;
      const dy = el.scrollHeight - el.clientHeight;
      const badX = dx > tolX, badY = dy > tolY;
      if (!badX && !badY) continue;

      const kind = badX && badY ? 'xy' : badX ? 'x' : 'y';
      const key = kind + '|' + path(el);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind,
        scroller: isScroller,
        dx, dy,
        avail: Math.round(el.clientWidth),
        need: Math.round(el.scrollWidth),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 42),
        p: path(el),
      });
    }
  }
  out.sort((a, c) => (a.kind === 'xy' ? -2 : a.kind === 'x' ? -1 : 0) - (c.kind === 'xy' ? -2 : c.kind === 'x' ? -1 : 0)
    || (Math.max(c.dx, c.dy) - Math.max(a.dx, a.dy)));
  return out;
});

const toggle = page.locator('[data-host-tools] button').first();
const MODES = ONLY ? [ONLY] : ['round', 'pix12', 'qiuye'];

/* 审计不止初始屏：侧栏 5 个页签各有各的排版，逐个切过去各量一遍。
 * 股市弹层（React 面板）单独点开 —— 那是内容最密的一块。 */
const TABS = ['岛民', '岛况', '股市', '账本', '播报'];

for (const want of MODES) {
  for (let i = 0; i < 3; i++) {
    const cur = await page.evaluate(() => document.documentElement.dataset.acFont || 'round');
    if (cur === want) break;
    await toggle.click();
    await page.waitForTimeout(1400);
  }
  await page.waitForTimeout(1200);
  const cur = await page.evaluate(() => document.documentElement.dataset.acFont || 'round');

  let worst = [];
  for (const tab of TABS) {
    const btn = page.locator(`.hud-topbtns [data-tab="${tab}"]`);
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(700); }
    const rows = await audit();
    if (rows.length) worst.push(...rows.map((r) => ({ ...r, tab })));
  }
  /* 去重（同一条问题会在多个页签重复出现） */
  const dedup = [...new Map(worst.map((r) => [r.kind + '|' + r.p + '|' + r.text, r])).values()];
  console.log(`\n===== 【${cur}】 5 个侧栏页签合计 ${dedup.length} 处放不下 =====`);
  for (const r of dedup.slice(0, 30)) {
    const dim = r.kind === 'y' ? `高 ${r.need}/${r.avail}` : `宽 ${r.need}/${r.avail}`;
    console.log(`  ${r.kind === 'xy' ? '‼' : r.kind === 'x' ? '✗' : '⇕'} [${r.tab}] ${String(r.kind === 'y' ? r.dy : r.dx).padStart(4)}px  ${dim.padEnd(14)} ${r.p}  「${r.text}」${r.scroller ? '  (滚动容器)' : ''}`);
  }

  /* 股市弹层： dock 的「更多动作 2」里 */
  const more = page.locator('.hud-act button', { hasText: '更多动作' });
  if (await more.count()) {
    await more.first().click();
    await page.waitForTimeout(500);
    const openStock = page.getByRole('button', { name: /开股市|股市/ }).last();
    if (await openStock.count()) { await openStock.click(); await page.waitForTimeout(1600); }
    const rows = await audit();
    console.log(`  ── 股市弹层：${rows.length} 处放不下`);
    for (const r of rows.slice(0, 12)) {
      const dim = r.kind === 'y' ? `高 ${r.need}/${r.avail}` : `宽 ${r.need}/${r.avail}`;
      console.log(`    ${r.kind === 'xy' ? '‼' : r.kind === 'x' ? '✗' : '⇕'} ${String(r.kind === 'y' ? r.dy : r.dx).padStart(4)}px  ${dim.padEnd(14)} ${r.p}  「${r.text}」${r.scroller ? '  (滚动容器)' : ''}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}
await b.close();
