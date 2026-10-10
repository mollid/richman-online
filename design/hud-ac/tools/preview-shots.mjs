/* 生成 preview/iso-*.png。**全程真鼠标**（见 tools/interaction-smoke.mjs 顶部注释：element.click()
 * 绕过命中测试，用它驱动出来的图不能代表真人操作）。
 *
 * 跑法：node design/hud-ac/tools/preview-shots.mjs
 * 浏览器路径用环境变量 CHROME_PATH 覆盖（默认取 agent-browser 的 Chromium）。
 *
 * 为什么必须能一键重出：本轮改了 hud.css 的工具条 max-width、world.js 的 ISO.maxAspect、
 * hud.js 的读数文案 —— 旧图全是改前状态，拿它当交付图会误导。
 */
import { chromium } from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const URL = process.env.D25_URL || 'file:///D:/Work/richman%20online/design/hud-ac/index.html';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Administrator/.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe';
const OUT = 'D:/Work/richman online/design/hud-ac/preview/';

const SHOTS = [
  { name: 'iso-1-top', vw: 1150, vh: 1145, dsf: 2, act: 'top' },
  { name: 'iso-2-near', vw: 1150, vh: 1145, dsf: 2, act: 'iso' },
  { name: 'iso-3-mid', vw: 1150, vh: 1145, dsf: 2, act: 'iso-pull' },
  { name: 'iso-4-other-player', vw: 1150, vh: 1145, dsf: 2, act: 'iso-other' },
  { name: 'iso-5-1024x768', vw: 1024, vh: 768, dsf: 2, act: 'iso' },
  { name: 'iso-6-390x844', vw: 390, vh: 844, dsf: 2, act: 'iso' },
  { name: 'iso-7-1440x900', vw: 1440, vh: 900, dsf: 2, act: 'iso' },
  /* 用户那台：1530×731 ≈ 2.09:1，Δ1.25x 出来正好 1912×914（跟他给的截图同尺寸）。
     这三张是「我点了没反应」的直接答复：全程真鼠标点过去的。 */
  { name: 'iso-8-user-1-top', vw: 1530, vh: 731, dsf: 1.25, act: 'top' },
  { name: 'iso-9-user-2-iso', vw: 1530, vh: 731, dsf: 1.25, act: 'iso' },
  { name: 'iso-10-user-3-back', vw: 1530, vh: 731, dsf: 1.25, act: 'iso-back' },
];

const b = await chromium.launch({
  executablePath: CHROME,
  args: ['--allow-file-access-from-files', '--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

for (const s of SHOTS) {
  const page = await b.newPage({ viewport: { width: s.vw, height: s.vh }, deviceScaleFactor: s.dsf });
  /* 掐掉 Google Fonts：网络一慢，page.goto 会被样式表阻塞到超时，
     page.screenshot 会卡在「waiting for fonts to load」。字体不是断言对象。 */
  await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.D25World?.cameraState, null, { timeout: 30000 });
  const settle = () => page.waitForFunction(() => !globalThis.D25World.isCameraLocked(), null, { timeout: 25000 });
  await settle();
  await page.waitForTimeout(2600);           // 软件渲染，首帧慢

  if (s.act !== 'top') {
    await page.locator('[data-cam-mode]').click();     // 真鼠标
    await settle();
    await page.waitForTimeout(1800);
  }
  if (s.act === 'iso-pull') {
    const hb = await page.locator('.d25-host').boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.wheel(0, 420);
    await page.waitForTimeout(900);
  }
  if (s.act === 'iso-other') {
    await page.locator('.d25-bar [data-cam-demo]').click();   // 巡演到下一位：机位会真的动
    await settle();
    await page.waitForTimeout(1400);
  }
  if (s.act === 'iso-back') {
    await page.locator('[data-cam-mode]').click();     // 「🗺 回到全盘」，同样真鼠标
    await settle();
    await page.waitForTimeout(1800);
  }

  const info = await page.evaluate(() => {
    const c = globalThis.D25World.cameraState();
    const h = globalThis.D25World.heroOnScreen();
    return {
      mode: c.mode, pid: c.pid,
      az: +c.az.toFixed(1), el: +c.el.toFixed(1), view: +c.view.toFixed(1), aspect: +c.aspect.toFixed(3),
      cells: globalThis.D25World.visibleCells().count,
      ndc: h ? h.ndc : null, inside: h ? h.inside : null,
      calls: globalThis.D25World.stats().calls,
    };
  });
  console.log(s.name.padEnd(22), JSON.stringify(info));
  await page.screenshot({ path: OUT + s.name + '.png' });
  await page.close();
}

await b.close();
