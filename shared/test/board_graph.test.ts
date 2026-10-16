import { describe, expect, it } from 'vitest';
import {
  applyAction,
  boardNeighbors,
  createGame,
  graphDistance,
  pathAhead,
  ringCells,
  rollDie,
  stepAlong,
  type GameState,
} from '../src/index.js';

/**
 * R5-a：棋盘从「64 格定长环」改成「按地图的图」。
 *
 * 环只是图的一个特例（`BoardCell.neighbors` 不写就按 `(id ± 1) % 长度` 推），
 * 所以这里测的是**新增的那一半**：岔路口随机拐、死端原路返回、空白格不开窗、
 * 没有起点格的图不领薪水。环上行为逐位不变由 `golden.test.ts` 那份基线守着。
 */

const PLAYERS = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
];

/**
 * 六格闭环挂一条死端支路：2 号是岔口（去 3 也去 6），6 号是死端。
 * 邻接表按「[来的方向, 去的方向…]」排，所以 heading=1 恒等于沿环顺时针。
 */
function branchBoard(): GameState['board'] {
  const spec: Array<[number, number[], string]> = [
    [0, [5, 1], '起点'],
    [1, [0, 2], '空地'],
    [2, [1, 3, 6], '岔口'],
    [3, [2, 4], '空地'],
    [4, [3, 5], '空地'],
    [5, [4, 0], '空地'],
    [6, [2], '死端'],
  ];
  return spec.map(([id, neighbors, name]) => ({ id, type: 'property' as const, name, price: 100, baseRent: 10, neighbors }));
}

function onBranchBoard(seed: number): GameState {
  const g = applyAction(createGame(PLAYERS, seed), { type: 'START_GAME' });
  g.board = branchBoard();
  return g;
}

/** 把骰子点数钉死：这几条测的是「走到哪」，不该被点数扰动 */
function seedForDie(target: number): number {
  const found = dieSeeds(target, 1);
  if (found.length === 0) throw new Error(`找不到点数为 ${target} 的种子`);
  return found[0]!;
}

/**
 * 前 n 个「第一颗骰子点数为 target」的种子。
 *
 * 测岔口选向时必须用它：`seedForDie` 那一份 rngState 是同一个值，岔口那一抽的结果因此恒定，
 * 看上去就像「随机拐永远拐向同一条路」。点数相同、下一抽却随种子而变，才是这里要的对照。
 */
function dieSeeds(target: number, n: number): number[] {
  const out: number[] = [];
  for (let s = 1; s <= 500_000 && out.length < n; s++) {
    if (rollDie(s).value === target) out.push(s);
  }
  return out;
}

describe('图的邻接与前进', () => {
  it('没写 neighbors 就按环推（自建图因此零改动）', () => {
    const ring = createGame(PLAYERS, 1).board;
    expect(boardNeighbors(ring, 0)).toEqual([63, 1]);
    expect(boardNeighbors(ring, 63)).toEqual([62, 0]);
    expect(boardNeighbors(branchBoard(), 2)).toEqual([1, 3, 6]);
  });

  it('岔路口随机拐：换种子会拐进不同支路，两条都到得了', () => {
    const seen = new Set<number>();
    for (const dieSeed of dieSeeds(1, 60)) {
      const g = onBranchBoard(1);
      const me = g.players[0]!;
      me.position = 1;
      me.heading = 1;
      g.rngState = dieSeed;
      // 走到 2 号岔口时定下「下一步去 3 还是去 6」：heading 1 = 沿环继续，2 = 拐进支路
      const arrived = applyAction(g, { type: 'ROLL_DICE', diceCount: 1 });
      expect(arrived.players[0]!.position).toBe(2);
      seen.add(arrived.players[0]!.heading);
    }
    expect([...seen].sort()).toEqual([1, 2]);
  });

  it('只有岔口抽 RNG：走到普通格与走到岔口，抽数差一次（环上因此零额外消耗）', () => {
    const plain = onBranchBoard(5);
    plain.players[0]!.position = 0;
    plain.players[0]!.heading = 1;
    plain.rngState = seedForDie(1);
    const atPlain = applyAction(plain, { type: 'ROLL_DICE', diceCount: 1 }); // 0 → 1，前路只有一条

    const junction = onBranchBoard(5);
    junction.players[0]!.position = 1;
    junction.players[0]!.heading = 1;
    junction.rngState = seedForDie(1);
    const atJunction = applyAction(junction, { type: 'ROLL_DICE', diceCount: 1 }); // 1 → 2，岔口

    expect(atJunction.rngState).not.toBe(atPlain.rngState);
  });

  it('死端原路返回：走进 6 号之后，下一步只能回到 2', () => {
    const b = branchBoard();
    const ways = boardNeighbors(b, 2);
    const into = stepAlong(b, 2, ways.indexOf(6), () => {
      throw new Error('走进死端时没有第二条路，不该抽数');
    });
    expect(into.next).toBe(6);
    // 从死端回到 2 号岔口时，前路又有 1 和 3 两条 ⇒ 这里该抽数
    const back = stepAlong(b, 6, into.heading, (o) => o[0]!);
    expect(back.next).toBe(2);
  });

  it('前瞻 pathAhead 在岔口取定序、不消耗抽数', () => {
    // 2 号岔口排除来路后剩 [3, 6]：前瞻取第一条 3，因此整条路径是确定的
    expect(pathAhead(branchBoard(), 1, 1, 4)).toEqual([2, 3, 4, 5]);
    expect(pathAhead(branchBoard(), 1, 1, 3)[1]).toBe(3);
  });

  it('图上最短步数是环上 min(n,d) 的推广（支路要绕）', () => {
    const b = branchBoard();
    expect(graphDistance(b, 0, 3)).toBe(3);
    expect(graphDistance(b, 0, 6)).toBe(3); // 0→1→2→6
    expect(graphDistance(b, 4, 6)).toBe(3); // 4→3→2→6
  });
});

describe('没有起点格的图', () => {
  it('绕回 0 号格不领薪水（原版地图没有起点 ⇒ 薪水这条收入不存在）', () => {
    const g = onBranchBoard(7);
    const board = g.board.map((c) => (c.id === 0 ? { ...c, type: 'blank' as const, name: '空地' } : c));
    g.board = board;
    const me = g.players[0]!;
    me.position = 5;
    me.heading = 1;
    g.rngState = seedForDie(1);
    const before = me.cash;
    const rolled = applyAction(g, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.position).toBe(0);
    expect(rolled.players[0]!.cash).toBe(before);
    expect(rolled.log.some((l) => l.text.includes('薪水'))).toBe(false);
  });
});

describe('空白格（原版地图的无信息节点）', () => {
  it('落上去什么都不发生：不开窗、回合直接推进', () => {
    const g = onBranchBoard(3);
    g.board = g.board.map((c) => (c.id === 1 ? { ...c, type: 'blank' as const, name: '空白格' } : c));
    const me = g.players[0]!;
    me.position = 0;
    me.heading = 1;
    g.rngState = seedForDie(1);
    const rolled = applyAction(g, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.position).toBe(1);
    expect(rolled.landing).toBeNull();
    expect(rolled.phase).toBe('awaiting_roll');
    expect(rolled.currentPlayerIndex).toBe(1);
    expect(rolled.log.some((l) => l.text.includes('这一格什么都没有'))).toBe(true);
  });
});

/**
 * 方环几何兜底。它只在 `boardLayout` 返回 null 时上屏，所以正常路径的测试永远碰不到它 ——
 * 而它偏偏是自建图小地图的唯一几何来源。这类「只有出事时才跑的代码」必须单独钉。
 */
describe('ringCells 方环兜底几何', () => {
  /** 造一张 N 格的环（坐标全缺 ⇒ boardLayout 会退回 null，正是兜底要接手的场景） */
  const ringOf = (n: number) => ringCells(Array.from({ length: n }, (_, id) => ({ id, type: 'blank', name: `${id}` }) as never));

  it('64 格正好是 17×17 的外圈，四角落位如设计', () => {
    const r = ringOf(64);
    expect(r).toHaveLength(64);
    expect(r[0]).toMatchObject({ cellId: 0, col: 1, row: 1, edge: 'top' });
    expect(r[15]).toMatchObject({ cellId: 15, col: 16, row: 1, edge: 'top' });
    expect(r[16]).toMatchObject({ cellId: 16, col: 17, row: 1, edge: 'right' });   // 右上角
    expect(r[32]).toMatchObject({ cellId: 32, col: 17, row: 17, edge: 'bottom' }); // 右下角
    expect(r[48]).toMatchObject({ cellId: 48, col: 1, row: 17, edge: 'left' });    // 左下角
    expect(r[63]).toMatchObject({ cellId: 63, col: 1, row: 2, edge: 'left' });     // 回到左上角前一格
  });

  it('格数一多边长就跟着涨 —— 写死 17 会让 100+ 格往负坐标里排', () => {
    for (const n of [64, 103, 110, 118, 144]) {
      const r = ringOf(n);
      const L = Math.ceil(n / 4) + 1;
      const cols = r.map((x) => x.col);
      const rows = r.map((x) => x.row);
      expect(Math.max(...cols, ...rows)).toBe(L);
      // 关键断言：一个都不许排到 0 或负数
      expect(Math.min(...cols, ...rows)).toBe(1);
    }
  });

  it('一圈走下来每格占一个互不重叠的位，且顺时针连续', () => {
    for (const n of [40, 64, 144]) {
      const r = ringOf(n);
      expect(new Set(r.map((x) => `${x.col}:${x.row}`)).size).toBe(n);
      for (const [i, x] of r.entries()) {
        if (i === 0) continue;
        const prev = r[i - 1]!;
        // 相邻两项在环上必须紧邻（同边步进 1，或正好跨过一个角）
        const dist = Math.abs(x.col - prev.col) + Math.abs(x.row - prev.row);
        expect(dist).toBe(1);
      }
    }
  });
});
