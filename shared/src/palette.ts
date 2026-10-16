import type { BoardCell, PropertyGroup } from './types.js';

/**
 * 棋盘配色 —— 集团色与格型色的唯一出处。
 *
 * 现状是同一份色值抄了两遍：`world.js` 里 `GROUP_HEX` / `TYPE_HEX`（数字，喂 three.js 材质），
 * `hud.js` 里 `GROUP` / `TYPE_MINI`（字符串，喂小地图 canvas）。hud.js 那行注释写着
 * 「图例色块直接取 world.js 的 GROUP_HEX」，但 `GROUP_HEX` 其实是 world 的私有常量、
 * 根本没导出 —— 注释描述的是意图，不是事实。
 *
 * 这两个脚本都是 `<script>` 直挂的 vanilla，不能 import，所以拷贝是结构逼出来的。
 * 收进 shared 之后：React 侧直接 import，两个老脚本改读 `globalThis.HUD_PALETTE`
 * （由 React 层在 mount 之前注入）。在那之前，`palette.test.ts` 逐色比对 world.js 源码，
 * 漂了会红 —— 至少不再是静默的。
 */
export const GROUP_HEX: Record<PropertyGroup, number> = {
  residential: 0x8fd07a,
  commercial: 0x7ec8ef,
  industrial: 0xc9b48a,
  tech: 0xb7a6e6,
  coastal: 0x7fd8c8,
  financial: 0xf0b96a,
};

/** 无集团格型（功能格）的底色 */
export const TYPE_HEX: Partial<Record<BoardCell['type'], number>> = {
  start: 0xffe08a,
  chance: 0xffd0e0,
  news: 0xdfe9ff,
  'free-card': 0xe6e0ff,
  points: 0xfff0b8,
  lottery: 0xd6f2e6,
  magic: 0xf0d9ff,
  tax: 0xe8e2d2,
  hospital: 0xffe3e3,
  jail: 0xe3e6ee,
  game: 0xd9f0ff,
  shop: 0xffe6c8,
  bank: 0xf2ead2,
  god: 0xffd9a8,
  company: 0xd9c9a3,
};

/** canvas 要的是 `#rrggbb` 字符串，world 要的是数字 —— 一处定义，两种形态都给出 */
export const hexString = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export const GROUP_CSS: Record<PropertyGroup, string> = Object.fromEntries(
  (Object.entries(GROUP_HEX) as Array<[PropertyGroup, number]>).map(([k, v]) => [k, hexString(v)]),
) as Record<PropertyGroup, string>;

export const TYPE_CSS: Partial<Record<BoardCell['type'], string>> = Object.fromEntries(
  (Object.entries(TYPE_HEX) as Array<[BoardCell['type'], number]>).map(([k, v]) => [k, hexString(v)]),
);

/** 一块格子在小地图上该涂什么色：有集团取集团色，否则按格型，都没有给奶油底 */
export function miniColor(cell: BoardCell): string {
  if (cell.group && GROUP_CSS[cell.group]) return GROUP_CSS[cell.group];
  return TYPE_CSS[cell.type] ?? '#fffbef';
}
