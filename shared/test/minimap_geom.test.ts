import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { boardLayout } from '../src/index.js';
import map0 from '../src/maps/map0.json';
import map1 from '../src/maps/map1.json';
import map2 from '../src/maps/map2.json';
import map3 from '../src/maps/map3.json';

/**
 * 棋盘几何的同源守卫：**形状只有一份，就是地图自带坐标。**
 *
 * 历史包袱：曾经有个「64 格方环」当兜底 —— `world.js:ringPos()` 排世界坐标，
 * `minimap.ts` 反算成像素，`BoardRenderer` 再排一遍等距格位，`hud.js` 还排一遍 CSS grid。
 * 四份实现、一个偏一格的 `+8`、一个走反了方向，全因为「假设棋盘是个 17×17 外圈」。
 * 但产品里四张地图每张都带坐标、格数 103~144 不等，环这个假设从来就没成立过。
 *
 * 现在几何只在 `boardLayout` 算，渲染层只消费。这条测试守两件事：
 * 1. 四张图都真的能算出几何（谁再退回环，就会在这里露馅）；
 * 2. 四个消费方都不许再出现环形排布（按源码比对 —— vanilla 脚本不能 import，与 palette.test.ts 同招）。
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const WORLD = read('../../client/public/ac-hud/world.js');
const HUD = read('../../client/public/ac-hud/hud.js');
const MINI = read('../../client/src/ui/hud/minimap.ts');
const RENDERER = read('../../client/src/game/BoardRenderer.ts');
const SNAP = read('../../client/src/game/acSnapshot.ts');

const MAPS = [map0, map1, map2, map3];

describe('四张地图都自带坐标，环这个兜底不成立', () => {
  it('每张图都能算出几何，格数各不相同（103/144/110/118）', () => {
    const sizes = MAPS.map((m) => {
      const L = boardLayout(m.cells as never);
      expect(L, `地图 ${m.mapId} ${m.name} 必须能算出几何`).not.toBeNull();
      expect(L!.cells).toHaveLength(m.cells.length);
      // 质心归零：渲染层把世界原点当画面中心用
      const sx = L!.cells.reduce((s, p) => s + p.x, 0) / L!.cells.length;
      const sz = L!.cells.reduce((s, p) => s + p.z, 0) / L!.cells.length;
      expect(sx).toBeCloseTo(0, 6);
      expect(sz).toBeCloseTo(0, 6);
      return m.cells.length;
    });
    expect(sizes).toEqual([103, 144, 110, 118]);
    expect(new Set(sizes).size).toBe(4); // 形状各不相同，排成同一个环一定是假的
  });

  it('快照只交 layout，不再补一份环形几何', () => {
    expect(SNAP).toContain('layout: boardLayout(game.board)');
    expect(SNAP, 'acSnapshot 不该再往快照里塞 view.ring').not.toContain('ring:');
    expect(SNAP).not.toContain('ringLayout');
  });
});

describe('渲染层不许再排环形棋盘', () => {
  it('3D 世界层不排形状，只读 layout', () => {
    expect(WORLD, 'ringPos 应当已删').not.toMatch(/function ringPos/);
    expect(WORLD).toContain('LAYOUT.cells[i]');
  });

  it('小地图没有几何就不画，不再伪造方环', () => {
    expect(MINI).toContain('if (!cells) return null');
    expect(MINI).not.toContain('ringCells(');
  });

  it('回放盘按地图坐标做等距投影，不再是 64 格环', () => {
    expect(RENDERER).not.toMatch(/function perimeterGrid/);
    expect(RENDERER).not.toContain('ringCells(');
    expect(RENDERER).toContain('boardLayout(this.board, LAYOUT_SPACING)');
    // 没有坐标就不渲染，而不是排个环顶替
    expect(RENDERER).toContain('this.noLayout = true');
  });

  it('旧整壳的平面棋盘按坐标绝对定位，不再用 CSS grid 排环', () => {
    expect(HUD, 'hud.js 不该再出现方环行列算法').not.toMatch(/Math\.ceil\(.*length \/ 4\)/);
    expect(HUD).not.toMatch(/--ring-l/);
    expect(HUD).toContain('d.dataset.cellId = String(cell.id)');
    // 定标由 layout 的包围盒推：世界 1 单位 → cw 像素
    expect(HUD).toContain('const cw = Math.max(12, Math.min(44');
  });
});
