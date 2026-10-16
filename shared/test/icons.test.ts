import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CELL_ICON,
  FACILITY_ICON,
  GOD_ICON,
  ITEM_ICON,
  NPC_ICON,
  ALL_ITEM_IDS,
  GODS,
  type CellType,
  type FacilityType,
  type VillainKind,
} from '../src/index.js';

/**
 * 图标表的完整性守卫。
 *
 * 这张表存在的唯一理由就是防「静默画不出东西」，所以它自己也得有人守。
 * `hud.js` 那三张表漂了 7 个真道具没人发现（全渲染成兜底 🧰），就是因为
 * 既没有类型牵连、也没有测试 —— 而 `hud.js` 连 typecheck 都不参与。
 */

/** 直接读实际发布的那份 sprite：表里写了、图里没有，等于白写 */
const SPRITE = readFileSync(new URL('../../client/public/mp/sprite.svg', import.meta.url), 'utf8');
const SYMBOLS = new Set([...SPRITE.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));

const ALL_TABLES: Array<[string, Record<string, string>]> = [
  ['CELL_ICON', CELL_ICON],
  ['FACILITY_ICON', FACILITY_ICON],
  ['NPC_ICON', NPC_ICON],
  ['ITEM_ICON', ITEM_ICON],
  ['GOD_ICON', GOD_ICON],
];

describe('图标表与 sprite 必须同源', () => {
  it('sprite 里确实有这些 symbol', () => {
    const missing = new Set<string>();
    for (const [name, table] of ALL_TABLES) {
      for (const [key, id] of Object.entries(table)) {
        if (!SYMBOLS.has(id)) missing.add(`${name}.${key} → #${id}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('没有空字符串图标（画不出东西且不报错）', () => {
    const empties = ALL_TABLES.flatMap(([name, t]) =>
      Object.entries(t).filter(([, v]) => !v.trim()).map(([k]) => `${name}.${k}`),
    );
    expect(empties).toEqual([]);
  });

  it('每个道具都有图标 —— ALL_ITEM_IDS 是运行时真值，类型上穷举不了', () => {
    const missing = ALL_ITEM_IDS.filter((id) => !ITEM_ICON[id]);
    expect(missing).toEqual([]);
    expect(ALL_ITEM_IDS.length).toBeGreaterThan(0);
  });

  it('表里没有指向不存在道具的死键', () => {
    const dead = Object.keys(ITEM_ICON).filter((id) => !ALL_ITEM_IDS.includes(id));
    expect(dead).toEqual([]);
  });

  it('每位神明都有图标', () => {
    const missing = GODS.map((g) => g.id).filter((id) => !GOD_ICON[id]);
    expect(missing).toEqual([]);
    expect(GODS.length).toBe(12);
  });

  it('格型 / 设施 / 恶人三个联合类型全覆盖', () => {
    // 联合类型这边靠 satisfies 兜编译期；运行时再数一遍，防有人把 satisfies 摘了
    const cells: CellType[] = [
      'start', 'property', 'commercial', 'chance', 'news', 'free-card', 'points', 'lottery',
      'magic', 'tax', 'hospital', 'jail', 'game', 'shop', 'bank', 'god', 'company', 'blank',
    ];
    const facs: FacilityType[] = ['park', 'mall', 'hotel', 'gas', 'lab'];
    const villains: VillainKind[] = ['thief', 'protection', 'robber', 'rent-thief'];
    expect(cells.filter((c) => !CELL_ICON[c])).toEqual([]);
    expect(facs.filter((f) => !FACILITY_ICON[f])).toEqual([]);
    expect(villains.filter((v) => !NPC_ICON[v])).toEqual([]);
    expect(Object.keys(CELL_ICON)).toHaveLength(cells.length);
  });
});
