import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GROUP_HEX, TYPE_HEX } from '../src/index.js';

/**
 * 棋盘配色的防漂移守卫。
 *
 * `world.js` 是 `<script>` 直挂的 vanilla，不能 import，所以它自己留了一份
 * `GROUP_HEX` / `TYPE_HEX`。这份拷贝目前**是对的**，但没有任何东西保证它一直对 ——
 * 而 `hud.js` 里那行「图例色块直接取 world.js 的 GROUP_HEX」其实是假的，
 * world 从没导出过这两个常量。
 *
 * 所以直接拿源码比对：world 改色而 shared 没跟上，这条会红。
 */
const WORLD = readFileSync(new URL('../../client/public/ac-hud/world.js', import.meta.url), 'utf8');

/** 从 `const NAME = { key: 0x......, ... }` 里抠出键值对 */
function parseHexTable(name: string): Record<string, number> {
  const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(WORLD);
  if (!m?.[1]) throw new Error(`world.js 里找不到 ${name} —— 改名或删了就要同步改这条守卫`);
  const out: Record<string, number> = {};
  for (const pair of m[1].matchAll(/'?([a-zA-Z-]+)'?\s*:\s*(0x[0-9a-fA-F]+)/g)) {
    const [, key, hex] = pair;
    if (key && hex) out[key] = Number(hex);
  }
  return out;
}

describe('棋盘配色：shared 与 world.js 必须逐色一致', () => {
  it('六个集团色一致', () => {
    expect(parseHexTable('GROUP_HEX')).toEqual(GROUP_HEX);
  });

  it('功能格底色一致（只比 shared 认得的那些，world 可以有多余的）', () => {
    const world = parseHexTable('TYPE_HEX');
    for (const [type, hex] of Object.entries(TYPE_HEX)) {
      expect(world[type], `格型 ${type} 的颜色两边不一致`).toBe(hex);
    }
  });

  it('world.js 确实还没导出这两张表（导出了就把这份守卫换成读全局）', () => {
    // 这条不是在断言坏味道长期存在，是在提醒：等 HUD 全 React 化后连同 hud.js 的拷贝一起删
    expect(WORLD).toContain('const GROUP_HEX');
  });
});
