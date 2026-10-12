import { describe, expect, it } from 'vitest';

import {
  applyAction,
  createGame,
  currentMonthIndex,
  POINTS_START,
  TREASURE_POINTS,
  type GameState,
  type PlayerDef,
} from '../src/index.js';
import { nextStepAction } from './helpers/state.js';

/**
 * TILE-31 宝箱（R5 起是驻留实体，不再是 56 号格那种固定格型）：
 * - 开局投第一只，此后**换月**才重投；同月内不挪位置，被拿走也不会当月又冒出来；
 * - 投放走只读派生随机（零抽数），既不压在有人站着的格上，也不压在起点；
 * - **踩中**它驻留的那格才拿点券 —— 路过不算（与恶犬同口径，用户规则）。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 1 月 5 日（周一）：离换月还有二十多天，月末计息 / 15 号开奖那些钩子与本文件无关 */
const MID_JANUARY = { year: 2026, month: 1, day: 5 } as const;

/**
 * `spawnGods: false` 关掉神明现身：它会在日切抽数，且玩家经过即附身截停，
 * 本文件要的是「路上只有宝箱」的局面（同 npc.test.ts 隔离随机源的口径）。
 */
function newGame(seed = 7, mapId: number | null = null): GameState {
  return applyAction(
    createGame(PLAYERS, seed, { startDate: { ...MID_JANUARY }, spawnGods: false, mapId }),
    { type: 'START_GAME' },
  );
}

/** 推进一个动作并能收尾（强制相位一律交给公共夹具挑那一手：翻牌要挑没翻过的杯） */
function step(state: GameState): GameState {
  if (state.phase === 'awaiting_roll') return applyAction(state, { type: 'ROLL_DICE' });
  return applyAction(state, nextStepAction(state));
}

/** 推到跨过一天（日切钩子因此跑一遍） */
function advanceOneDay(state: GameState): GameState {
  const start = state.calendar.elapsedDays;
  let s = state;
  for (let i = 0; i < 60 && s.calendar.elapsedDays === start; i++) s = step(s);
  return s;
}

/**
 * 把宝箱摆在当前玩家**前方 `chestSteps` 步**那格，再用固定骰子走 `steps` 步。
 * 默认图是定长环，所以「前方 n 步」就是 `position + n`；固定骰子不消耗抽数。
 */
function walkOntoChest(state: GameState, chestSteps: number, steps: number): GameState {
  const s = structuredClone(state);
  const p = s.players[s.currentPlayerIndex]!;
  s.treasureCellId = (p.position + chestSteps) % s.board.length;
  p.diceCount = 1;
  s.pendingFixedDice = steps;
  return s;
}

describe('TILE-31 宝箱（每月换驻留的实体）', () => {
  it('开局投第一只：不消耗抽数，也不压在任何人脚下', () => {
    const raw = createGame(PLAYERS, 7, { startDate: { ...MID_JANUARY }, spawnGods: false });
    // 还在大厅，场上不该有宝箱
    expect(raw.treasureCellId).toBeNull();

    const g = applyAction(raw, { type: 'START_GAME' });
    const cellId = g.treasureCellId;
    expect(cellId).not.toBeNull();
    expect(cellId!).toBeGreaterThanOrEqual(0);
    expect(cellId!).toBeLessThan(g.board.length);
    expect(g.treasureMonth).toBe(currentMonthIndex(g));
    expect(g.board[cellId!]!.type).not.toBe('start'); // 起点是「经过即领薪水」的仪式格，不压宝箱
    expect(g.players.some((p) => p.position === cellId)).toBe(false);
    // 零抽数：投放只读派生，一整局 START_GAME 都没动过抽数指针
    expect(g.rngState).toBe(raw.rngState);
  });

  it('走到宝箱那一格：拿 TREASURE_POINTS，播报一条，实体消失', () => {
    const g = newGame(11);
    const rolled = applyAction(walkOntoChest(g, 3, 3), { type: 'ROLL_DICE' });
    expect(rolled.treasureCellId).toBeNull();
    expect(rolled.players[0]!.points).toBe(POINTS_START + TREASURE_POINTS);
    expect(rolled.log.some((e) => e.text.includes('打开宝箱'))).toBe(true);
  });

  it('只是途经它那一格不算拿到：宝箱还在，点券一分不给', () => {
    const g = newGame(12);
    const before = g.players[0]!.position;
    const rolled = applyAction(walkOntoChest(g, 2, 5), { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe((before + 5) % g.board.length);
    expect(rolled.treasureCellId).toBe((before + 2) % g.board.length); // 还在原地等人来踩
    expect(rolled.players[0]!.points).toBe(POINTS_START);
    expect(rolled.log.some((e) => e.text.includes('打开宝箱'))).toBe(false);
  });

  it('本月被拿走就不再回来；撑到换月才重投', () => {
    const month = newGame(14).treasureMonth;
    let s = applyAction(walkOntoChest(newGame(14), 3, 3), { type: 'ROLL_DICE' });
    expect(s.treasureCellId).toBeNull();

    // 同一个月内跨几天：钩子按 `treasureMonth` 短路，不该又冒出一只
    for (let i = 0; i < 3; i++) s = advanceOneDay(s);
    expect(currentMonthIndex(s)).toBe(month);
    expect(s.treasureCellId).toBeNull();

    // 换月：重投（拿「冒出来」的播报判定，避免与「当步就被别人捡走」的次序纠缠）
    for (let guard = 0; guard < 600 && currentMonthIndex(s) === month; guard++) s = advanceOneDay(s);
    expect(currentMonthIndex(s)).not.toBe(month);
    expect(s.treasureMonth).toBe(currentMonthIndex(s));
    expect(s.log.some((e) => e.text.includes('冒出一只宝箱'))).toBe(true);
  });

  it('同一个月内不重投：还在场上的宝箱位置不动，月序号记录也不动', () => {
    const g = newGame(15);
    const first = g.treasureCellId!;
    const month = g.treasureMonth;
    let s = g;
    for (let i = 0; i < 6 && currentMonthIndex(s) === month; i++) {
      s = advanceOneDay(s);
      expect(s.treasureMonth).toBe(month);
      // 为 null 只有一种来路：被人拿走了（拾取路径不碰月序号）
      if (s.treasureCellId !== null) expect(s.treasureCellId).toBe(first);
    }
  });

  it('四张原版图都投得出宝箱（候选格按各自图长算）', () => {
    for (const mapId of [0, 1, 2, 3]) {
      const g = newGame(17, mapId);
      const cellId = g.treasureCellId;
      expect(cellId).not.toBeNull();
      expect(cellId!).toBeGreaterThanOrEqual(0);
      expect(cellId!).toBeLessThan(g.board.length);
      expect(g.players.some((p) => p.position === cellId)).toBe(false);
    }
  });

  it('起点那一格永远不摆宝箱（12 个种子 × 五种图）', () => {
    for (const mapId of [null, 0, 1, 2, 3]) {
      for (let seed = 1; seed <= 12; seed++) {
        const g = newGame(seed * 17, mapId);
        expect(g.board[g.treasureCellId!]!.type).not.toBe('start');
      }
    }
  });

  it('默认棋盘的 56 号格退回空地：棋盘上不再有宝箱格', () => {
    const g = createGame(PLAYERS, 3, { startDate: { ...MID_JANUARY } });
    expect(g.board[56]!.type).toBe('blank');
    expect(g.board.some((c) => c.name === '宝箱')).toBe(false);
  });
});
