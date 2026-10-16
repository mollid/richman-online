import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 小地图取景框与 3D 棋盘的几何对齐守卫。
 *
 * 两边各写一份方环换算：`world.js:ringPos()` 把格号换成世界坐标，
 * `client/src/ui/hud/minimap.ts` 再把世界坐标反算成小地图像素。这两个函数必须互逆，
 * 否则近景里那块取景框会相对格子偏掉 —— 而近景下画面只露几格，偏一格看着仍然"差不多对"，
 * 靠眼睛永远发现不了。（旧 hud.js 那版反函数写的是 `+8` 而 world 的原点是 9，正是偏一格。）
 *
 * world.js 是 `<script>` 直挂的 vanilla，不能 import，所以按源码比对 —— 与 palette.test.ts 同招。
 */
const WORLD = readFileSync(new URL('../../client/public/ac-hud/world.js', import.meta.url), 'utf8');
const MINI = readFileSync(new URL('../../client/src/ui/hud/minimap.ts', import.meta.url), 'utf8');

/** `const SPACING = 2.0;` */
function worldSpacing(): number {
  const m = /const SPACING\s*=\s*([\d.]+)/.exec(WORLD);
  if (!m?.[1]) throw new Error('world.js 里找不到 const SPACING —— 改名或删了就要同步改这条守卫');
  return Number(m[1]);
}

/** `ringPos()` 里的 `{ x: (col - 9) * SPACING, ... }` 那个原点 */
function ringOrigin(): number {
  const m = /function ringPos[\s\S]*?x:\s*\(col\s*-\s*(\d+)\)\s*\*\s*SPACING/.exec(WORLD);
  if (!m?.[1]) throw new Error('world.js 的 ringPos 不再是 (col - N) * SPACING 这个形式了 —— 反算那边要跟着改');
  return Number(m[1]);
}

/** `MINI = { cell: 6, pad: 7, scale: 2, spacing: 2 }` 里的 spacing */
function miniSpacing(): number {
  const m = /export const MINI = \{[^}]*spacing:\s*([\d.]+)/.exec(MINI);
  if (!m?.[1]) throw new Error('minimap.ts 里找不到 MINI.spacing —— 定标口径换了就要同步改这条守卫');
  return Number(m[1]);
}

/** 方环兜底那一支用的原点表达式 */
function miniOriginExpr(): string {
  const m = /const origin\s*=\s*([^;]+);/.exec(MINI)?.[1];
  if (!m) throw new Error('minimap.ts 里没有 const origin —— 反算的原点必须显式写出来，不许埋进算式');
  return m.trim();
}

describe('小地图与 3D 棋盘同源', () => {
  it('格距定标一致（世界单位 → 像素的 k 由它推）', () => {
    expect(miniSpacing()).toBe(worldSpacing());
  });

  it('方环原点按 L=17 反算等于 world 的中心（(L+1)/2 = 9，不是 L/2 也不是 8）', () => {
    const expr = miniOriginExpr();
    expect(expr, '兜底原点应当写成 (L + 1) / 2').toBe('(L + 1) / 2');
    const L = 17; // 64 格 = 17×17 外圈
    expect((L + 1) / 2).toBe(ringOrigin());
  });

  it('取景框中心落在某个玩家脚下时，反算回的那一格确实是它', () => {
    // 拿 L=17 手算一遍互逆：col=9 → x=0 → 反算回 9；四角 col=1 / 17 也各就各位
    const o = ringOrigin();
    const sp = worldSpacing();
    for (const col of [1, 9, 17]) {
      const x = (col - o) * sp;
      expect(x / sp + (17 + 1) / 2).toBe(col);
    }
  });

  it('有 layout 时不走兜底：取景框与格子都读同一份 view.layout', () => {
    expect(MINI).toContain('layout?.cells');
    expect(MINI).toContain('miniColor');
  });
});
