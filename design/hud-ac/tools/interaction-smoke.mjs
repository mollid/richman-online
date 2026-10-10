/* 交互冒烟测试：**必须用真鼠标**（Playwright 的 locator.click / mouse.*），不能用 element.click()。
 *
 * 为什么单独写这个文件：
 *   world.js 的拖拽实现会在 pointerdown 时 setPointerCapture()，而 mount() 收到的 el 就是
 *   .d25-stage —— 舞台工具条（复位 / 正俯视 / 斜 45° / 低角度 / 近景等距 / 镜头巡演）全在它里面。
 *   指针在按钮上按下时被 stage 抢走，随后的 mouseup / click 会被重定向到 stage，
 *   按钮自己的 onclick 永远不触发。实测：
 *       pointerdown → BUTTON   mousedown → BUTTON
 *       mouseup     → .d25-stage   click → .d25-stage   ← 丢了
 *   而 element.click() 是 DOM 直调、不过命中测试，所以「自动化全绿、真人全废」，
 *   这个 bug 从第一轮活到了第三轮才被用户点出来。
 *   ⇒ 凡是「点击」类的断言，一律走真鼠标 + 断言事件落点。
 *
 * 跑法：
 *   node design/hud-ac/tools/interaction-smoke.mjs
 *   浏览器路径用环境变量 CHROME_PATH 覆盖（默认取 agent-browser 的 Chromium）。
 */
import { chromium } from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const URL = process.env.D25_URL || 'file:///D:/Work/richman%20online/design/hud-ac/index.html';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Administrator/.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe';

const fails = [];
const oks = [];
const ok = (name, cond, detail) => (cond ? oks : fails).push(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

const b = await chromium.launch({
  executablePath: CHROME,
  args: ['--allow-file-access-from-files', '--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errs = [];
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
/* 断网跑：页面从 Google Fonts 拉 M PLUS Rounded / Nunito，网络一慢，page.screenshot 就会卡在
   「waiting for fonts to load」直到超时（踩过一次，整整 30 秒后抛 TimeoutError）。
   字体不是本测试的断言对象，直接挡掉，让测试不依赖网络、结果可复现。 */
await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
/* 上面把 Google Fonts 掐了，浏览器必然为那两个被 abort 的请求报「Failed to load resource」。
   那不是应用缺陷，是测试自己造的，要从控制台断言里剔掉 —— 否则每次都是一条假红。 */
const isSelfInflicted = (t) => /Failed to load resource|net::ERR_FAILED/.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !isSelfInflicted(m.text())) errs.push('console: ' + m.text()); });

const cam = () => page.evaluate(() => {
  const c = globalThis.D25World.cameraState();
  return { mode: c.mode, state: c.state, az: +c.az.toFixed(1), el: +c.el.toFixed(1), view: +c.view.toFixed(1), locked: c.locked };
});
const settle = () => page.waitForFunction(() => !globalThis.D25World.isCameraLocked(), null, { timeout: 15000 });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => globalThis.D25World?.cameraState, null, { timeout: 25000 });
await settle();
await page.waitForTimeout(1800);

/* ── A. 事件落点：工具条按钮的真鼠标 click 必须落在按钮自己身上 ───────────── */
{
  await page.evaluate(() => {
    window.__t = [];
    for (const t of ['pointerdown', 'mouseup', 'click']) {
      document.addEventListener(t, (e) => window.__t.push(t + ':' + e.target.tagName + (e.target.closest?.('.d25-bar') ? ':bar' : '')), true);
    }
  });
  await page.locator('[data-view="tilt"]').click();
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => window.__t);
  ok('工具条 click 落在按钮上（没被 setPointerCapture 甩到 stage）',
    t.includes('click:BUTTON:bar'), JSON.stringify(t));
}

/* ── B. 四个视角预设：真鼠标点，机位必须真的变 ───────────────────────────── */
{
  const seen = {};
  for (const v of ['top', 'tilt', 'side', 'reset']) {
    await page.locator(`[data-view="${v}"]`).click();
    await page.waitForTimeout(450);
    seen[v] = await cam();
  }
  ok('正俯视 生效', near(seen.top.el, 78, 1) && seen.top.el !== 46, `el=${seen.top.el}`);
  ok('斜 45° 生效', near(seen.tilt.az, 45, 1) && near(seen.tilt.el, 38, 1), `az=${seen.tilt.az} el=${seen.tilt.el}`);
  ok('低角度 生效', near(seen.side.az, 30, 1) && near(seen.side.el, 26, 1), `az=${seen.side.az} el=${seen.side.el}`);
  ok('复位 生效', near(seen.reset.az, 0, 1) && near(seen.reset.el, 46, 1), `az=${seen.reset.az} el=${seen.reset.el}`);
}

/* ── C. 近景等距：真鼠标点，切到 iso + 小地图出现 + 预设置灰 ──────────────── */
{
  await page.locator('[data-cam-mode]').click();
  await settle();
  await page.waitForTimeout(700);
  const c = await cam();
  ok('近景等距 切换到 iso', c.mode === 'iso' && c.view < 20, `mode=${c.mode} view=${c.view}`);
  const mini = await page.evaluate(() => {
    const n = document.querySelector('canvas[data-minimap]');
    return n ? getComputedStyle(n).display : 'NO-NODE';
  });
  ok('小地图 显示', mini !== 'none' && mini !== 'NO-NODE', String(mini));
  const pd = await page.evaluate(() => document.querySelector('[data-view="tilt"]').disabled);
  ok('iso 下视角预设 置灰', pd === true, `disabled=${pd}`);
  const label = await page.evaluate(() => document.querySelector('[data-cam-mode]').textContent.trim());
  ok('切换按钮文案 变为「回到全盘」', /回到全盘/.test(label), label);
}

/* ── D. 真鼠标拖拽 / 滚轮 ────────────────────────────────────────────────── */
{
  const hb = await page.locator('.d25-host').boundingBox();
  const cx = hb.x + hb.width / 2, cy = hb.y + hb.height / 2;
  const before = await cam();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 130, cy + 25, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const afterDrag = await cam();
  ok('拖拽 转视角', Math.abs(afterDrag.az - before.az) > 10 && Math.abs(afterDrag.el - before.el) > 1,
    `az ${before.az}→${afterDrag.az}, el ${before.el}→${afterDrag.el}`);

  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(350);
  const afterWheel = await cam();
  ok('滚轮 推拉', Math.abs(afterWheel.view - afterDrag.view) > 0.3,
    `view ${afterDrag.view}→${afterWheel.view}`);
}

/* ── E. 回到全盘：真鼠标点，可视格数必须回到全盘量级 ─────────────────────── */
{
  await page.locator('[data-cam-mode]').click();
  await settle();
  await page.waitForTimeout(900);
  const cells = await page.evaluate(() => globalThis.D25World.visibleCells().count);
  const c = await cam();
  ok('回到全盘 放得下整盘', c.mode === 'top' && cells >= 40, `mode=${c.mode} cells=${cells}`);
}

/* ── F. 镜头巡演：真鼠标点，必须真的锁一次输入并改变机位 ─────────────────── */
{
  await page.evaluate(() => globalThis.D25World.setView('reset'));
  await page.waitForTimeout(300);
  const before = await cam();
  await page.locator('.d25-bar [data-cam-demo]').click();
  await page.waitForTimeout(250);
  const lockedNow = await page.evaluate(() => globalThis.D25World.isCameraLocked());
  await settle();
  await page.waitForTimeout(600);
  const after = await cam();
  ok('巡演 触发输入锁', lockedNow === true, `locked=${lockedNow}`);
  ok('巡演 真的拉近（不只是平移注视点）',
    Math.abs(after.view - before.view) > 3 || Math.abs(after.el - before.el) > 2,
    `view ${before.view}→${after.view}, el ${before.el}→${after.el}`);
}

/* ── G. 无报错 ───────────────────────────────────────────────────────────── */
ok('控制台无 error', errs.length === 0, errs.join(' | '));

console.log([...oks, ...fails].join('\n'));
console.log(`\n${oks.length} passed, ${fails.length} failed`);
await b.close();
process.exit(fails.length ? 1 : 0);
