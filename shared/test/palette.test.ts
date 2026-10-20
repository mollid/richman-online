import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GROUP_HEX, TYPE_HEX } from '../src/index.js';

/**
 * 棋盘配色的防漂移守卫。
 *
 * `world.js` 是 `<script>` 直挂的 vanilla，不能 import。它现在优先读
 * `globalThis.RICHMAN_BOARD_SKIN`（由 React 层注入，见 `installBoardSkin()`），
 * 但「file:// 直接打开」时没有注入源，所以仍留了一份 FALLBACK 表。
 * 这份兜底没有任何东西保证它一直跟 shared 一致 —— 所以直接拿源码比：
 * world 改色而 shared 没跟上，这条会红。
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

describe('棋盘配色：shared 与 world.js 的兜底表必须逐色一致', () => {
  it('六个集团色一致', () => {
    expect(parseHexTable('FALLBACK_GROUP_HEX')).toEqual(GROUP_HEX);
  });

  it('功能格底色一致（只比 shared 认得的那些，world 可以有多余的）', () => {
    const world = parseHexTable('FALLBACK_TYPE_HEX');
    for (const [type, hex] of Object.entries(TYPE_HEX)) {
      expect(world[type], `格型 ${type} 的颜色两边不一致`).toBe(hex);
    }
  });

  it('world.js 优先读注入的皮肤，兜底只是兜底', () => {
    expect(WORLD).toContain('RICHMAN_BOARD_SKIN');
    expect(WORLD).toMatch(/const GROUP_HEX = \(SKIN && SKIN\.group\) \|\| FALLBACK_GROUP_HEX/);
  });
});
