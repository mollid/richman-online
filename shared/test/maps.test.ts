import { describe, expect, it } from 'vitest';
import {
  applyAction,
  landPriceLevel,
  stockAnchor,
  boardFromMap,
  boardLayout,
  companyAtCell,
  createGame,
  graphDistance,
  ORIGINAL_MAPS,
  type GameState,
} from '../src/index.js';
import { GOLDEN_PLAYERS, runGoldenMatch } from './helpers/golden_run.js';
import { nextStepAction } from './helpers/state.js';

/**
 * 原版地图（R5-b）：`tools/decode_map_mkf.py` 从 map.mkf 解出的四张图能不能当真棋盘用。
 *
 * 结构与几何的正确性靠三层证明：与 SVG 拓扑图逐节点对拍（解码器里那次）、
 * 下面这些图不变式、以及拿 bot 把四张图各跑一整局不报错不卡死。
 */

const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function board(mapId: number): GameState['board'] {
  return boardFromMap(mapId);
}

describe('原版地图数据', () => {
  it('四张图都在，格数与 mkf 头里的节点数一致', () => {
    expect(ORIGINAL_MAPS.map((m) => m.nodeCount)).toEqual([103, 144, 110, 118]);
    for (const m of ORIGINAL_MAPS) expect(board(m.mapId)).toHaveLength(m.nodeCount);
  });

  it('每格都带坐标与邻接，邻接是对称的、且不含自己', () => {
    for (const m of ORIGINAL_MAPS) {
      const b = board(m.mapId);
      for (const c of b) {
        expect(typeof c.x).toBe('number');
        expect(typeof c.y).toBe('number');
        expect(c.neighbors!.length).toBeGreaterThan(0);
        expect(c.neighbors).not.toContain(c.id);
        for (const n of c.neighbors!) {
          expect(b[n]!.neighbors).toContain(c.id); // 单向邻接 = 解码错位
        }
      }
    }
  });

  it('整图连通：任何两格之间都走得到（有孤立格就是支路接错了）', () => {
    for (const m of ORIGINAL_MAPS) {
      const b = board(m.mapId);
      for (const target of [1, Math.floor(b.length / 2), b.length - 1]) {
        expect(graphDistance(b, 0, target)).toBeLessThan(b.length);
      }
    }
  });

  it('岔口与死端的形状与解码报告一致（支路确实挂在这几张图上）', () => {
    const deg = (mapId: number) => {
      const hist: Record<number, number> = {};
      for (const c of board(mapId)) hist[c.neighbors!.length] = (hist[c.neighbors!.length] ?? 0) + 1;
      return hist;
    };
    expect(deg(0)).toEqual({ 1: 2, 2: 99, 3: 2 }); // 潮汕：闭环挂两条死端支路
    expect(deg(3)).toEqual({ 2: 118 });            // 美国：纯闭环
  });

  it('商业用地占两格同段（原版「两个普通地块连一起」），空白格不带任何可结算数值', () => {
    const b = board(0);
    const commercial = b.filter((c) => c.type === 'commercial');
    expect(commercial).toHaveLength(8);
    const streets = new Set(commercial.map((c) => c.street));
    expect(streets).toHaveLength(4); // 8 格 = 4 段
    // 空白格（含原版那种有名字、但我们没有对应规则的格，如公園）：不可买、不可收租
    for (const c of b.filter((x) => x.type === 'blank')) {
      expect(c.price).toBeUndefined();
      expect(c.baseRent).toBeUndefined();
    }
  });
});

describe('按地图建局', () => {
  it('mapId 记进状态，公司表跟着这张图走，行情池是这张图那 12 支', () => {
    const g = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY, mapId: 0 });
    expect(g.mapId).toBe(0);
    expect(g.board).toHaveLength(103);
    // 潮汕在 mkf 里只有一家上得了市的公司：汕頭人壽（保险类、占 50·51 相邻两格）。
    // 图上另外两个企业节点是 百貨公司 与 銀行 —— mkf 那一列恒 0，落成 shop / bank 功能格；
    // 但它们在 EXE 股票表里照样有行（潮商百貨 / 汕頭信託），所以进行情池、不进公司表。
    expect(g.companies).toHaveLength(1);
    expect(g.companies[0]).toMatchObject({
      kind: 'insurance',
      name: '汕头人寿',
      // 面值 = 股票表的 par。mkf 企业行那一列（这里是 750）**不是**面值 —— 拿 par 去除
      // mkf 的资本额得到 8000 这类像总股本的数，拿 750 去除只得到 533，见 stocks.json 的 _note
      sharePrice: 40,
      cellId: 50,
      footprint: [50, 51],
    });
    // 行情池 = 股票表那 12 支，按表序；棋盘上那家公司就是同名的第 2 支，id 仍按 kind 走
    expect(g.stockMarket.stocks).toHaveLength(12);
    expect(g.stockMarket.stocks.map((s) => s.id)).toEqual([
      's0-0', 'corp-insurance', 's0-2', 's0-3', 's0-4', 's0-5',
      's0-6', 's0-7', 's0-8', 's0-9', 's0-10', 's0-11',
    ]);
    expect(g.stockMarket.stocks.map((s) => s.name)[0]).toBe('汕头信托');
    expect(g.stockMarket.stocks.map((s) => s.price)).toEqual([100, 40, 25, 180, 80, 60, 60, 27, 310, 66, 171, 280]);
  });

  it('四张图的公司都落在自己那两格上，且同一张图里种类不重复', () => {
    for (const mapId of [0, 1, 2, 3]) {
      const g = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY, mapId });
      expect(g.companies.length).toBeGreaterThan(0);
      // 种类重复会让 `corp-<kind>` 这个行情 id 撞名，建局时就该挡住
      expect(new Set(g.companies.map((c) => c.kind)).size).toBe(g.companies.length);
      // 每张图都是股票表那 12 支（棋盘上的公司占用其中同名的一支，不多开一行）
      expect(g.stockMarket.stocks).toHaveLength(12);
      // 每家公司都得在行情池里有自己那一支，否则「一本股东账」断成两条
      for (const company of g.companies) expect(g.stockMarket.stocks.some((s) => s.id === `corp-${company.kind}`)).toBe(true);
      for (const company of g.companies) {
        expect(company.footprint.length).toBe(2);
        for (const cellId of company.footprint) {
          const cell = g.board[cellId]!;
          expect(cell.type).toBe('company');
          expect(cell.companyKind).toBe(company.kind);
        }
        // 一家公司占的两格必须相邻（原版形态），否则「踩到哪格都算同一家」就不成立
        const a = company.footprint[0]!;
        const b = company.footprint[1]!;
        expect(g.board[a]!.neighbors).toContain(b);
        expect(companyAtCell(g, b)).toBe(company);
      }
    }
  });

  it('不填 mapId 仍是自建 64 格环 + 11 家公司 + 17 支行情', () => {
    const g = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY });
    expect(g.mapId).toBeNull();
    expect(g.board).toHaveLength(64);
    expect(g.companies).toHaveLength(11);
    expect(g.stockMarket.stocks).toHaveLength(17);
  });

  it('出生点撒在这张图的可用格上，且互相隔开', () => {
    const g = applyAction(createGame(GOLDEN_PLAYERS, 42, { startDate: MONDAY, mapId: 2 }), { type: 'START_GAME' });
    const spots = g.players.map((p) => p.position);
    for (const at of spots) {
      expect(at).toBeLessThan(110);
      expect(['property', 'commercial', 'chance', 'shop']).toContain(g.board[at]!.type);
    }
    expect(new Set(spots).size).toBe(spots.length);
  });
});

describe('四张图各跑一整局（bot 对跑）', () => {
  /* 断的是「门控与引擎不分叉」这条不变式 —— 换图最容易破的就是它。
     收束与否不在这里断：原版图没有薪水，144 格那张跑到 600 回合还没人破产，是平衡问题不是正确性问题。 */
  for (const mapId of [0, 1, 2, 3]) {
    it(`地图 ${mapId}：门控与引擎校验同源`, () => {
      const run = runGoldenMatch({ mapId, maxTurns: 600, sampleEvery: 100 });
      expect(run.errors).toBe(0);
      // 确实在玩：有人置了业（没有薪水时，收租是唯一放大路径）
      expect(run.finalState.players.some((p) => p.properties.length > 0)).toBe(true);
    }, 120_000);
  }

  // 四张图都不许出现「拿不到合法动作而中止」：地图 1 曾在此卡死整局，
  // 根因是 `pendingCards` 只记欠哪张卡、不记欠谁（修复见 `PendingCard`）
  for (const mapId of [0, 1, 2, 3]) {
    it(`地图 ${mapId}：没有卡死的窗口`, () => {
      expect(runGoldenMatch({ mapId, maxTurns: 600, sampleEvery: 100 }).stalls).toBe(0);
    }, 120_000);
  }
});

describe('棋盘几何（boardLayout）', () => {
  it('自建图没有自带坐标 ⇒ 返回 null，让渲染层沿用 17×17 方环', () => {
    expect(boardLayout(createGame(GOLDEN_PLAYERS, 1).board)).toBeNull();
  });

  it('原版图：质心落在原点，相邻格正好相距一个格距', () => {
    for (const m of ORIGINAL_MAPS) {
      const b = board(m.mapId);
      const L = boardLayout(b);
      expect(L).not.toBeNull();
      const { cells, radius } = L!;
      expect(cells).toHaveLength(b.length);
      for (const p of cells) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.z)).toBe(true);
      }
      // 质心归零：渲染层把世界原点当画面中心用
      expect(cells.reduce((s, p) => s + p.x, 0) / cells.length).toBeCloseTo(0, 6);
      expect(cells.reduce((s, p) => s + p.z, 0) / cells.length).toBeCloseTo(0, 6);
      // 每条邻接边都按同一个步长定标 ⇒ 台座不会互相穿插，也不会散开
      const lens = b.flatMap((c) => {
        const here = cells[c.id]!;
        return (c.neighbors ?? []).filter((n) => n > c.id).map((n) => {
          const there = cells[n]!;
          return Math.hypot(here.x - there.x, here.z - there.z);
        });
      });
      for (const len of lens) expect(len).toBeGreaterThan(0.5);
      expect(Math.max(...lens)).toBeLessThan(6);
      expect(radius).toBeGreaterThan(10);
    }
  });

  it('缺坐标的图（混进一个没坐标的格）整体退回 null，不做半张图错位', () => {
    const b = board(0);
    b[5] = { ...b[5]!, x: undefined, y: undefined };
    expect(boardLayout(b)).toBeNull();
  });
});

describe('移动路径记进状态（movePath）', () => {
  /** 表现层照它逐格跳，所以它必须是「每一步都真的走在邻接上」的一条路 */
  const assertWalk = (board: GameState['board'], path: number[]) => {
    for (let i = 0; i < path.length; i++) {
      const from = i === 0 ? undefined : path[i - 1];
      if (from !== undefined) expect(board[from]!.neighbors).toContain(path[i]);
    }
  };

  it('原版图上每一手的路径都是「从脚下出发的合法走法」', () => {
    for (const mapId of [0, 1, 2, 3]) {
      let s = applyAction(createGame(GOLDEN_PLAYERS, 900 + mapId, { startDate: MONDAY, mapId }), { type: 'START_GAME' });
      let seen = 0;
      for (let i = 0; i < 120 && s.phase !== 'game_over'; i++) {
        if (s.phase === 'awaiting_roll') {
          const idx = s.currentPlayerIndex;
          const from0 = s.players[idx]!.position;
          s = applyAction(s, { type: 'ROLL_DICE' });
          const path = s.movePath;
          if (!path || path.length === 0) continue;
          assertWalk(s.board, path);
          /* 坐牢 / 住院那几手 `consumeTurnDelay` 直接 return，人没走 ⇒ `movePath` 还是上一手留下的。
             客户端对此免疫（它要求路径末元素正好是落点才照播），这里同样只验真走了的那一手。 */
          if (s.players[idx]!.position === from0) continue;
          seen += 1;
          // 第一步必须从脚下这格的邻居出发（路径不含起点）
          expect(s.board[from0]!.neighbors).toContain(path[0]);
          // 路障会截停、撞神会在那一格 break（地雷与炸弹踩中生效但不拦人，D-49），
          // 所以这里只能断「不超过骰和」
          expect(path.length).toBeLessThanOrEqual(s.dice!.reduce((a, b) => a + b, 0));
          continue;
        }
        // 强制相位（拍卖 / 小游戏 / 舍弃手牌）不是本条的断言对象，但**必须推得过去**：
        // 早先在这里直接 break，于是「谁先撞上强制相位」把整张图的验证掐了 —— 行情池变薄、
        // 局更短之后尤其明显（潮汕那张只验到 6 手就退出了循环）。
        if (s.phase === 'awaiting_discard') {
          const owner = s.players.find((q) => q.id === s.pendingCards[0]?.ownerId);
          const cardId = owner?.cards[0];
          if (!cardId) break;
          s = applyAction(s, { type: 'DISCARD_CARD', cardId });
          continue;
        }
        s = applyAction(s, nextStepAction(s));
      }
      expect(seen).toBeGreaterThan(10); // 一手都没走就没有任何东西被验证过
    }
  });
});

describe('原版图没有薪水', () => {
  it('跑完整局，没有任何一笔「经过起点」进账', () => {
    const g = applyAction(createGame(GOLDEN_PLAYERS, 11, { startDate: MONDAY, mapId: 1 }), { type: 'START_GAME' });
    expect(g.board.some((c) => c.type === 'start')).toBe(false);
    let s: GameState = g;
    for (let i = 0; i < 40; i++) {
      s = applyAction(s, { type: 'ROLL_DICE' });
      if (s.phase === 'awaiting_action') s = applyAction(s, { type: 'FINISH_LANDING' });
    }
    expect(s.log.some((l) => l.text.includes('薪水'))).toBe(false);
  });
});

/**
 * 名字口径：mkf 与 EXE 股票表打架的那一处按股票表走（用户 2026-10-12 拍的）。
 * 原盘 mkf 的字节确实写着「玉井府百貨」，不是解码顺序错 —— 证据与对照字节在
 * `tools/decode_map_mkf.py` 的 `NAME_FIXES` 注释里。
 */
describe('机构名以股票表为准', () => {
  it('中国图上的百货节点叫「王府井百货」，行情池里也是同一支', () => {
    const cn = ORIGINAL_MAPS.find((m) => m.mapId === 1)!;
    expect(JSON.stringify(cn).includes('玉井府')).toBe(false);
    expect(cn.cells.some((c) => c.sidName === '王府井百货')).toBe(true);
    const g = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY, mapId: 1 });
    expect(g.stockMarket.stocks.some((s) => s.name === '王府井百货')).toBe(true);
  });
});

/**
 * 本地股定锚（反汇编实证第三波，`docs/玩法拆解_股票系统.md` §1 + 股票表 dump）：
 * 原版 `股票表+0x04` 只有「本地 / 非本地」两条，本地股的基准每天读这张图的地价，
 * 非本地股的基准就是面值本身。这里钉的是「绑定关系接对了没有」，锚本身怎么算由
 * `stock.test.ts` 那条纯函数用例管。
 */
describe('本地股绑地价，非本地股绑面值', () => {
  it('表里 local=1 的那几支才有 landPriceBase，且开局基准等于这张图的地价水平', () => {
    const jp = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY, mapId: 2 });
    // 日本这图前 6 支是本地股（富士銀行 / 三井生命 / 三越百貨 / 日產建設 / ＳＥＧＡ / 豐田汽車）
    expect(jp.stockMarket.stocks.map((s) => (s.landPriceBase ? 1 : 0).toString()).join('')).toBe('111111000000');
    const sega = jp.stockMarket.stocks.find((s) => s.id === 'corp-computer')!;
    expect(sega.name).toBe('ＳＥＧＡ');
    expect(sega.landPriceBase).toBe(landPriceLevel(jp.board));
    // 基准与开盘相等 ⇒ 开局锚 == 面值，回归力第一天不介入（比值口径的意义就在这里）
    expect(stockAnchor(sega, sega.landPriceBase!)).toBe(sega.anchorPrice);
    const sony = jp.stockMarket.stocks.find((s) => s.name === 'ＳＯＮＹ')!;
    expect(sony.landPriceBase).toBeUndefined();
    // 非本地股：地价翻十倍也拽不动它的锚
    expect(stockAnchor(sony, landPriceLevel(jp.board) * 10)).toBe(sony.anchorPrice);
    // 默认图一张都不绑：那 6 支行业股与 11 家公司股是我们自造的设计，没有本地股这个身份
    const home = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY });
    expect(home.stockMarket.stocks.every((s) => s.landPriceBase === undefined)).toBe(true);
    expect(home.stockMarket.stocks).toHaveLength(17);
  });

  it('每支的波动系数与流通量都取自表，不再一律 1.0 / 按市值定标', () => {
    const jp = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY, mapId: 2 });
    const byName = new Map(jp.stockMarket.stocks.map((s) => [s.name, s]));
    expect(byName.get('三越百货')!.volatility).toBe(2);
    expect(byName.get('富士银行')!.volatility).toBe(0.8);
    expect(byName.get('任天堂')!.volatility).toBe(1);
    expect(byName.get('三越百货')!.floatShares).toBe(10000);   // 本地股不必然 5000，表里这支给的是 10000
    expect(byName.get('ＳＥＧＡ')!.floatShares).toBe(5000);
    // 中國石油那行表里就是 0 张流通（用户 2026-10-12 确认是原值，不是没初始化）—— 代码不替它垫数
    const cn = createGame(GOLDEN_PLAYERS, 7, { startDate: MONDAY, mapId: 1 });
    const oil = cn.stockMarket.stocks.find((s) => s.name === '中国石油')!;
    expect(oil.floatShares).toBe(0);
    expect(oil.remainingShares).toBe(0);
  });

  it('没有流通量的那张票：行情与公司格两条渠道都被引擎拒掉，理由各说各的', () => {
    const g = applyAction(createGame(GOLDEN_PLAYERS, 9, { startDate: MONDAY, mapId: 1 }), { type: 'START_GAME' });
    const oil = g.stockMarket.stocks.find((s) => s.name === '中国石油')!;
    const me = g.players[g.currentPlayerIndex]!;
    me.deposit = 9_999_999;
    me.cash = 9_999_999;
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: oil.id, quantity: 1 })).toThrow('没有流通量，行情池里买不到这张票');
    // 踩到它家门口也一样：认购吃的是同一个流通池
    const company = g.companies.find((c) => c.name === '中国石油')!;
    const atDoor = { ...g, phase: 'awaiting_action' as const, landing: { cellId: company.cellId, venue: null, turn: g.turn } };
    atDoor.players = atDoor.players.map((p) => (p.id === me.id ? { ...p, position: company.cellId, cash: 9_999_999 } : p));
    expect(() => applyAction(atDoor, { type: 'BUY_SHARES', cellId: company.cellId, quantity: 10 })).toThrow(
      '没有流通量，行情与公司格两条渠道都拿不到它',
    );
    // 而同图其他支照常能买 —— 别把这一条写坏成整张图都拒
    const bank = g.stockMarket.stocks.find((s) => s.name === '上海银行')!;
    expect(applyAction(g, { type: 'BUY_STOCK', stockId: bank.id, quantity: 10 }).stockMarket.stocks.find((s) => s.id === bank.id)!.remainingShares)
      .toBe(bank.remainingShares - 10);
  });
});
