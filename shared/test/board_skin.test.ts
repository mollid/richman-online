import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BOARD_SKIN,
  CELL_GEOMETRY,
  GROUP_CSS,
  GROUP_HEX,
  installBoardSkin,
  ISO_GEOMETRY,
  MINI_GEOMETRY,
  skinColor,
  TYPE_CSS,
  TYPE_HEX,
} from '../src/index.js';
import type { BoardCell } from '../src/index.js';

/**
 * 格子外观的同源守卫。
 *
 * 问题背景：同一个格子在四个地方各画了一遍（3D 对局 / Pixi 回放 / 平面示意 / 小地图），
 * 尺寸与配色各存一份拷贝。回放盘甚至用的是另一套 Material 色板 ——
 * 同一副棋盘，回放里是青柠橙，对局里是马卡龙绿。
 *
 * 收进 `shared/src/boardSkin.ts` 之后，React 侧直接 import；
 * 两个 `<script>` 直挂的 vanilla 脚本（world.js / hud.js）由 `installBoardSkin()`
 * 在加载前把皮肤挂到全局，各自只留一份「file:// 直接打开」用的 FALLBACK。
 *
 * 这里守三件事：
 * 1. 几何本身自洽（台座不能比格距还宽，否则邻格互相穿模）；
 * 2. 两份 FALLBACK 与 shared 逐项一致（否则不注入的场景就悄悄跑偏）；
 * 3. 三个消费方都真的在读皮肤，而不是又在本地写死一份。
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const WORLD = read('../../client/public/ac-hud/world.js');
const HUD = read('../../client/public/ac-hud/hud.js');
const RENDERER = read('../../client/src/game/BoardRenderer.ts');
const MINI = read('../../client/src/ui/hud/minimap.ts');

/** 取 `const NAME = { ... }` 里花括号包着的那段（括号配对扫描，正则扛不住嵌套） */
function objectBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = {`);
  if (at < 0) throw new Error(`找不到 ${name} —— 改名或删了就要同步改这条守卫`);
  const start = src.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  throw new Error(`${name} 的花括号没闭合`);
}

function parsePairs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  /* 值可能是十六进制数字（0x…）、CSS 字符串（'#…'）或普通数字。
     源码里 CRLF / LF 混杂，这里的正则一律不跨行，所以不受影响。 */
  const re = /(['"]?)([A-Za-z0-9_-]+)\1\s*:\s*['"]?(0x[0-9a-fA-F]+|#[0-9a-fA-F]{6}|-?\d+(?:\.\d+)?)['"]?/g;
  for (const m of body.matchAll(re)) {
    if (m[2] && m[3]) out[m[2]] = m[3];
  }
  return out;
}

const nums = (src: string, name: string) =>
  Object.fromEntries(Object.entries(parsePairs(objectBody(src, name))).map(([k, v]) => [k, Number(v)]));

describe('格子几何自洽', () => {
  it('格面、台座都必须装得进格位，否则邻格互相穿模', () => {
    const g = CELL_GEOMETRY;
    expect(g.tile).toBeLessThan(g.spacing);
    // 台座边长 = tile + padGrow，它是离邻格最近的那个盒
    expect(g.tile + g.padGrow).toBeLessThan(g.spacing);
    // 裙边与台座同宽，所以同一条上限；厚度只是视觉
    expect(g.rimHeight).toBeGreaterThan(0);
  });

  it('圆角不超过半边长，否则 extrude 的圆角矩形会自交', () => {
    expect(CELL_GEOMETRY.radius).toBeGreaterThan(0);
    expect(CELL_GEOMETRY.radius).toBeLessThan(CELL_GEOMETRY.tile / 2);
    expect(CELL_GEOMETRY.padRadius).toBeLessThanOrEqual(CELL_GEOMETRY.padGrow + CELL_GEOMETRY.radius);
  });

  it('台座顶面要低于格面，又高于沙面', () => {
    // 沙面在 y=0.05；台座顶 0.07 只露 0.02 —— 一圈很细的奶油唇边
    expect(CELL_GEOMETRY.padTop).toBeGreaterThan(0.05);
    // 格面实际顶高 = depth + bevel（ExtrudeGeometry 的倒角会顶出去）
    expect(CELL_GEOMETRY.padTop).toBeLessThan(CELL_GEOMETRY.depth + CELL_GEOMETRY.bevel);
  });

  it('格子是「贴地」的：格体露在沙面之上不超过 0.1', () => {
    /* 沙面 y=0.05，格体从 y=0 长到 depth+bevel。露头太高就变积木，
       俯视会遮住邻格花纹，选中时抬起来更会压住邻格文字。 */
    const above = CELL_GEOMETRY.depth + CELL_GEOMETRY.bevel - 0.05;
    expect(above).toBeGreaterThan(0); // 还得露一点，否则格子被沙面吃掉
    expect(above).toBeLessThanOrEqual(0.1);
    expect(CELL_GEOMETRY.bevel).toBeLessThan(CELL_GEOMETRY.depth);
  });

  it('地图步长与格距分开：改 spacing 才是「把棋盘铺开」，mapStep 是地图数据定死的', () => {
    expect(CELL_GEOMETRY.mapStep).toBe(2);
    expect(CELL_GEOMETRY.spacing / CELL_GEOMETRY.mapStep).toBeGreaterThan(0);
  });

  it('三个渲染器的尺寸都是正数，且回放盘菱形是 2:1', () => {
    expect(ISO_GEOMETRY.tilePx).toBeGreaterThan(0);
    expect(ISO_GEOMETRY.depthPx).toBeGreaterThan(0);
    expect(MINI_GEOMETRY.cell).toBeGreaterThan(0);
    expect(MINI_GEOMETRY.scale).toBeGreaterThanOrEqual(1);
    // TILE_H = TILE_W / 2 是等距 2:1 的约定，BoardRenderer 里直接这么除的
    expect(ISO_GEOMETRY.tilePx % 2).toBe(0);
  });
});

describe('皮肤就是那几张表的唯一出口', () => {
  it('颜色以数字与字符串两种形态给出，指向同一批值', () => {
    expect(BOARD_SKIN.group).toBe(GROUP_HEX);
    expect(BOARD_SKIN.type).toBe(TYPE_HEX);
    expect(BOARD_SKIN.groupCss).toBe(GROUP_CSS);
    expect(BOARD_SKIN.typeCss).toBe(TYPE_CSS);
  });

  it('skinColor 与 miniColor 同口径：有集团取集团色，否则按格型', () => {
    const land: BoardCell = { id: 1, type: 'property', name: '彩虹码头', group: 'coastal' };
    expect(skinColor(land)).toBe(GROUP_HEX.coastal);
    // 商业用地也算「有集团」
    expect(skinColor({ id: 2, type: 'commercial', name: '旺角', group: 'commercial' })).toBe(GROUP_HEX.commercial);
    // 功能格没有集团，按格型
    expect(skinColor({ id: 3, type: 'start', name: '起点' })).toBe(TYPE_HEX.start);
    // 两头都没有 → 奶油底
    expect(skinColor({ id: 4, type: 'blank', name: '' })).toBe(0xfffbef);
  });

  it('installBoardSkin 把皮肤挂到全局（vanilla 脚本唯一的读法）', () => {
    const g: Record<string, unknown> = {};
    installBoardSkin(g);
    expect(g.RICHMAN_BOARD_SKIN).toBe(BOARD_SKIN);
  });
});

describe('两份 vanilla FALLBACK 必须与 shared 逐项一致', () => {
  it('world.js 的格子几何', () => {
    expect(nums(WORLD, 'FALLBACK_CELL')).toEqual(CELL_GEOMETRY);
  });

  it('hud.js 的小地图尺寸', () => {
    expect(nums(HUD, 'FALLBACK_MINI')).toEqual(MINI_GEOMETRY);
  });

  it('hud.js 的集团色', () => {
    expect(parsePairs(objectBody(HUD, 'FALLBACK_GROUP'))).toEqual(GROUP_CSS);
  });

  it('hud.js 的功能格色（只比 shared 认得的那些，hud 可以有多余的）', () => {
    const hud = parsePairs(objectBody(HUD, 'FALLBACK_TYPE_MINI'));
    for (const [type, css] of Object.entries(TYPE_CSS)) {
      expect(hud[type], `格型 ${type} 的颜色两边不一致`).toBe(css);
    }
  });
});

describe('三个消费方都读皮肤，不再各自写死', () => {
  it('world.js：尺寸与配色都优先取注入的那份', () => {
    expect(WORLD).toContain('globalThis.RICHMAN_BOARD_SKIN');
    expect(WORLD).toMatch(/const TILE = GEOM\.tile/);
    expect(WORLD).toMatch(/const DEPTH = GEOM\.depth/);
    // 格面圆角、倒角、台座、裙边的数字全部来自 GEOM，源码里不该再出现那几个字面量
    expect(WORLD).toMatch(/extrude\(TILE, TILE, GEOM\.radius, DEPTH, true, GEOM\.bevel\)/);
    expect(WORLD).toMatch(/GEOM\.padRadius/);
    expect(WORLD).toMatch(/GEOM\.rimHeight/);
    // 裙边高度必须跟着皮肤走：写死会把色环留在半空
    expect(WORLD).toMatch(/plinth\.position\.set\(x, GEOM\.padTop, z\)/);
  });

  it('选中 / 悬停不许再抬高格子，只能套贴地裙边', () => {
    /* 早前是 `m.position.y = 0.12 + 呼吸` 把选中的格子举起来 —— 贴地之后这个动作
       会让格子飞出地面压住邻格文字。悬停还有个 `scale.set(1.06, 1.5, 1.06)`，
       纵向拉 1.5 倍会把格面鼓成立体墩子、把贴面文字顶歪。两条都不许回来。 */
    expect(WORLD).not.toMatch(/position\.y = 0\.12/);
    expect(WORLD).not.toMatch(/scale\.set\(1\.06, 1\.5, 1\.06\)/);
    /* 效果语言是「裙边」不是「光环」：一条沿台座顶面贴地的厚边。悬空环压在格面上
       会遮住名字和价签，用户已经明确否掉，别再造回去。 */
    expect(WORLD).toContain('buildSkirts');
    expect(WORLD).toMatch(/placeSkirt\(selSkirt, id\)/);
    expect(WORLD).toMatch(/placeSkirt\(hoverSkirt/);
    expect(WORLD, '选格角标也要贴地，不许换回悬空环').not.toMatch(
      /pickOverlay = new THREE\.InstancedMesh\(\s*new THREE\.RingGeometry/,
    );
    expect(WORLD).toMatch(/new THREE\.BoxGeometry\(TILE \+ GEOM\.padGrow, GEOM\.rimHeight/);
    /* 裙边高度必须贴台座顶，浮在格面之上就又变回环了 */
    expect(WORLD).toMatch(/skirt\.position\.set\(p\.x, GEOM\.padTop \+/);
    /* 反过来也不许加高：顶面一过格面就把整格吞掉（试过 1.9 倍，名字与价签全被盖住） */
    expect(WORLD, '裙边不许加高过格面').not.toMatch(/rimHeight \*\s*[0-9]/);
  });

  it('草地顶面跟着皮肤走：写死高度会把内陆格子整块埋进草里', () => {
    /* 草地是岛心那块大绿片，顶面由几何实测算出（约 0.63）。带坐标的原版图里，
       路径会穿过内陆，所以必须把草地沉到格面以下，否则内陆的格子全被埋掉。
       早前写死沉到 0.12 —— 那是按「格面 0.45」定的；格子压扁到 0.105 之后，
       0.12 反而比格面还高，近景往岛心看只剩草地和树，一个格子都看不见（主子截图）。
       现在目标高度从皮肤推：刚低于奶油台座顶（padTop）、高于沙面。 */
    expect(WORLD).toMatch(/const grassTop = GEOM\.padTop - /);
    expect(WORLD, '不许再写死草地沉降高度').not.toMatch(/sink = groundY - 0\.12/);
    // 抬到台座顶之上的话，从俯视角看连奶油边都没有了
    const [, sinkExpr] = WORLD.match(/const grassTop = (.*);/) ?? [];
    expect(sinkExpr, '草地目标高度必须落在台座顶之下').toContain('GEOM.padTop');
  });

  it('岛心装置与装饰都已清空，只剩地形 + 棋盘（按地图重画前的地基）', () => {
    /* 清过两轮：
     * 1. 岛内装饰（树/灌木/草丛/民居/池塘/礁石）—— 那套坐标按「64 格环」排，换到自带坐标的
     *    原版图只会长在格子上，靠「离格心 ≥1.1 倍格距」的过滤去躲，躲出来的东西和地图无关。
     * 2. 岛心装置（广场圆台 + 外环、十字小径、木告示牌）—— 同理，位置是写死的。
     * 现在岛上只剩地形与棋盘，等按地图数据重排。
     * 这条守卫的意义：别哪天又把写死坐标的表粘回来。 */
    for (const dead of [
      /plantTree\(/, /houseSpots/, /tuftList/, /plantPond\(/, /clearOfCells\(/,
      /const plaza/, /signBoard/, /signTexture/, /pathGeo/,
    ]) {
      expect(WORLD, `清掉的旧布点不该回来：${dead}`).not.toMatch(dead);
    }
    // 地形要留着：它跟着棋盘半径走，不是写死的布点
    expect(WORLD).toContain('const sea');
    expect(WORLD).toContain('const shoal');
    expect(WORLD).toContain('const foam');
    expect(WORLD).toContain('const grass');
    expect(WORLD).toContain('const base');
  });

  it('海面必须盖满「拉得最远」时的视野（否则露出画布底色 = 穿模）', () => {
    /* 海面原来是 96×IK（半边长 ~68），只够近景。滚轮能拉到 130×IK，仰角 38° 时屏幕上沿
       对应相机前方 280 单位的地面 —— 海面在 68 处就断，断口外露出画布背后的舞台底色，
       整块面板像「海被切掉了」。按最远角反算需要半边长 ≥190。 */
    const span = WORLD.match(/const SEA_SPAN = 96 \* IK \* ([\d.]+)/);
    expect(span, '海面尺寸要按 IK 放大').not.toBeNull();
    expect(Number(span![1]), '至少 3 块贴图宽才盖得住最远机位').toBeGreaterThanOrEqual(3);
    // 远裁剪必须跟着放大，否则海面自己在远处被切出一条直边 —— 比露底更像穿模
    const far = WORLD.match(/new THREE\.PerspectiveCamera\(32, 1, 0\.5, (\d+)\)/);
    expect(far, '透视相机参数被改过').not.toBeNull();
    expect(Number(far![1]), '远裁剪要够远').toBeGreaterThanOrEqual(500);
    expect(WORLD, '海面纹理密度要跟着放大，否则水纹被拉成一团').toMatch(/seaMap\.repeat\.set\(/);
    expect(WORLD, '旧的 96×IK 海面不许回来').not.toMatch(/PlaneGeometry\(96 \* IK, 96 \* IK\)/);
  });

  it('hud.js：小地图尺寸与配色取自皮肤', () => {
    expect(HUD).toContain('globalThis.RICHMAN_BOARD_SKIN');
    expect(HUD).toMatch(/const MINI = \(SKIN && SKIN\.mini\) \|\| FALLBACK_MINI/);
    expect(HUD).toMatch(/const GROUP = \(SKIN && SKIN\.groupCss\) \|\| FALLBACK_GROUP/);
    expect(HUD).toMatch(/const TYPE_MINI = \(SKIN && SKIN\.typeCss\) \|\| FALLBACK_TYPE_MINI/);
    // 图例色块也跟集团色走，不再另抄一份
    expect(HUD).toContain('Object.keys(GROUP).map');
  });

  it('回放盘：尺寸与配色都读 shared，本地的 Material 色板已经删掉', () => {
    expect(RENDERER).toContain('BOARD_SKIN.iso.tilePx');
    expect(RENDERER).toContain('BOARD_SKIN.iso.depthPx');
    expect(RENDERER).toContain('BOARD_SKIN.cell.mapStep');
    expect(RENDERER, '第三套集团色板应当已删').not.toContain('GROUP_COLORS');
    expect(RENDERER, '第三套功能格色板应当已删').not.toContain('TYPE_COLORS');
    expect(RENDERER).toMatch(/function cellColor\(cell: BoardCell\): number \{\r?\n\s*return skinColor\(cell\);/);
  });

  it('小地图尺寸只认 shared 那一份', () => {
    expect(MINI).toContain('export const MINI = BOARD_SKIN.mini');
  });
});
