import type { BoardCell, PropertyGroup } from './types.js';
import { GROUP_CSS, GROUP_HEX, miniColor, TYPE_CSS, TYPE_HEX } from './palette.js';

/**
 * 格子外观的唯一出处 —— 改格子皮肤只改这一个文件。
 *
 * 为什么需要它：同一个格子在四个地方各画了一遍，尺寸与配色各存了一份拷贝
 * （`world.js` 的 SPACING/TILE/DEPTH、`BoardRenderer.ts` 的 TILE_W/TILE_H/TILE_DEPTH、
 * `hud.js` 的 MINI、`minimap.ts` 的 MINI），改一处另外三处不知道，于是同一副棋盘
 * 在「对局 / 回放 / 平面示意 / 小地图」里长得不一样。收进这里之后：
 *
 * - React 侧（`BoardRenderer` / `minimap`）直接 `import`；
 * - 两个 `<script>` 直挂的 vanilla 脚本（`world.js` / `hud.js`）不能 import，
 *   由 `installBoardSkin()` 在加载它们**之前**挂到 `globalThis.RICHMAN_BOARD_SKIN`。
 *
 * 两份 vanilla 里仍各留一份 FALLBACK（file:// 直接打开时没有注入源），
 * 数值必须与本文件逐项一致 —— `board_skin.test.ts` 拿源码比对，漂了就红。
 *
 * ---------------------------- 改了会怎样 ----------------------------
 * `cell.tile` / `cell.spacing` 调的是「格子相对格位的大小」：
 *   - tile 接近 spacing  → 格子几乎相贴，奶油台座被压得看不见
 *   - tile 明显小于 spacing → 格子疏离，台座外露出很宽的奶油边
 * 硬上限在下面的测试里钉着：tile + padGrow 必须小于 spacing，否则邻格台座互相插进去。
 * `cell.depth` 调的是「贴不贴地」：0.08 时只露出 0.055，读成画在地上的一格；
 * 调到 0.2 以上就变积木，俯视下会遮住相邻格的花纹。**选中/悬停一律不靠抬高格子表示**
 * —— 那会把整块举起来压住邻格文字，改由 world.js 的地面光环表达。
 */

/** 对局盘（three.js，世界单位）里一格的几何 */
export interface CellGeometry {
  /** 地图坐标里相邻两格的步长。由地图数据定死（换它等于换地图），只作换算基准 */
  mapStep: number;
  /** 相邻两格的中心距 */
  spacing: number;
  /** 格面边长 */
  tile: number;
  /** 格面圆角 */
  radius: number;
  /** 格厚 */
  depth: number;
  /** 挤出倒角（ExtrudeGeometry 的 bevelSize / bevelThickness）。格面实际顶高 = depth + bevel */
  bevel: number;
  /** 奶油台座比格面宽出的总量（台座边长 = tile + padGrow） */
  padGrow: number;
  /** 台座厚度 */
  padDepth: number;
  /** 台座顶面的 y */
  padTop: number;
  /** 台座圆角 */
  padRadius: number;
  /** 持有者色裙边的高度 */
  rimHeight: number;
}

/** 回放盘（Pixi，像素）里一格的几何：2:1 等距菱形 */
export interface IsoGeometry {
  /** 菱形宽（高恒为宽的一半） */
  tilePx: number;
  /** 挤出的侧面厚度 */
  depthPx: number;
  /** 描边宽度 */
  outlinePx: number;
}

/** 小地图 / 平面示意里一格的几何 */
export interface MiniGeometry {
  /** 一格多少 px */
  cell: number;
  /** 画布内边距 */
  pad: number;
  /** 画布超采样倍数（Retina 用） */
  scale: number;
  /** 相邻格中心的步长（地图坐标单位） */
  spacing: number;
}

export interface BoardSkin {
  cell: CellGeometry;
  iso: IsoGeometry;
  mini: MiniGeometry;
  /** 六段地产色，0xrrggbb —— 喂 three.js 材质 */
  group: Record<PropertyGroup, number>;
  /** 功能格底色，0xrrggbb */
  type: Partial<Record<string, number>>;
  /** 同一批颜色的 `#rrggbb` 形态 —— 喂 canvas / CSS */
  groupCss: Record<PropertyGroup, string>;
  typeCss: Partial<Record<string, string>>;
}

export const CELL_GEOMETRY: CellGeometry = {
  mapStep: 2,
  spacing: 2.0,
  /* 1.86 / 2.0 = 0.93：格与格之间留 0.14 的缝，正好露出一条连续的奶油台座线。
     参考图里这圈白边是「棋盘」与「地面」之间唯一的视觉分隔，没有它格子会和草地糊成一片。 */
  tile: 1.86,
  radius: 0.28,
  /* 「贴近地面」：格子是一片平贴在地上的薄板，不是积木。
     沙面在 y=0.05，格体从 y=0 长到 depth+bevel=0.105 —— 只露出 0.055，
     侧壁几乎看不见，读成「画在地上的一格」而不是「摆在桌上的一块」。 */
  depth: 0.08,
  bevel: 0.025,
  /* 台座顶 0.07 只比沙面高 0.02：一圈很细的奶油唇边。
     再高就会在近景里读成「格子被架起来了」，与「贴地」冲突。 */
  padGrow: 0.12,
  padDepth: 0.12,
  padTop: 0.07,
  padRadius: 0.16,
  /* 裙边同样压薄：它要变成贴地的一圈色环，而不是一圈挡墙。
     0.06 高、中心在 padTop ⇒ 只比台座顶高出 0.03，站在格面（0.105）之下。 */
  rimHeight: 0.06,
};

export const ISO_GEOMETRY: IsoGeometry = {
  /* 64 宽的菱形 = 相邻格在屏幕上的水平位移（32px）的两倍，铺满格位。
     对局盘里格子留了缝、菱形不留 —— 回放盘是纯 2D 俯视，缝会读成「格子变小了」。 */
  tilePx: 64,
  depthPx: 9,
  outlinePx: 1.5,
};

export const MINI_GEOMETRY: MiniGeometry = {
  /* cell 6 是量出来的，不是拍的：144 格那张图铺开约 70 世界单位，乘 (6/spacing)=3
     得到 229px —— 放在 1280×720 的舞台右下角占 18% 宽、32% 高，正好。
     试过提到 9（同一张图 341×320px），单看形状更清楚，但占掉近一半屏高，
     把棋盘挤得更小，得不偿失。小地图的价值在「位置关系」，不在格子大小。
     改这里要同步 `hud.js` 的 FALLBACK_MINI，两份数值漂了守卫会红。 */
  cell: 6,
  pad: 7,
  scale: 2,
  spacing: 2,
};

export const BOARD_SKIN: BoardSkin = {
  cell: CELL_GEOMETRY,
  iso: ISO_GEOMETRY,
  mini: MINI_GEOMETRY,
  group: GROUP_HEX,
  type: TYPE_HEX,
  groupCss: GROUP_CSS,
  typeCss: TYPE_CSS,
};

/**
 * 一块格子该涂什么色（数字形态，喂 Pixi / three 的材质）。
 * 与 `miniColor()` 同一条口径：有集团取集团色，否则按格型，都没有给奶油底。
 * 回放盘、对局盘、小地图、平面示意四处的底色都从这里出。
 */
export function skinColor(cell: BoardCell): number {
  return parseInt(miniColor(cell).slice(1), 16);
}

/** 全局注入的名字。两个 vanilla 脚本从这里读，改这一个常量要同步改它们。 */
export const BOARD_SKIN_KEY = 'RICHMAN_BOARD_SKIN';

/**
 * 把皮肤挂到全局，必须在 `world.js` / `hud.js` 被 `<script>` 执行**之前**调用。
 * 它们在自己的 IIFE 顶层就把值取成常量了，晚挂一步读到的还是 FALLBACK。
 */
export function installBoardSkin(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  target[BOARD_SKIN_KEY] = BOARD_SKIN;
}
