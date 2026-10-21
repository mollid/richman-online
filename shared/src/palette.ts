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
  residential: 0xa9dd8f,
  commercial: 0x8ed1f5,
  industrial: 0xd7c49c,
  tech: 0xc2b2ee,
  coastal: 0x87dfd1,
  financial: 0xf6c07c,
};

/** 无集团格型（功能格）的底色 */
export const TYPE_HEX: Partial<Record<BoardCell['type'], number>> = {
  start: 0xffd98a,
  chance: 0xffc9dc,
  news: 0xcfe1ff,
  'free-card': 0xded4ff,
  points: 0xffeeb0,
  lottery: 0xc9f2df,
  magic: 0xe8d2ff,
  tax: 0xe5dcc6,
  hospital: 0xffd9db,
  jail: 0xd8deea,
  game: 0xc9ecff,
  shop: 0xffdfba,
  bank: 0xf6ecd0,
  god: 0xffcf95,
  company: 0xd8c6a0,
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
