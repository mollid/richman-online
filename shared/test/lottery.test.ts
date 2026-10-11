import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  createGame,
  drawWinningNumber,
  isValidLotteryNumber,
  LOTTERY_MAX_NUMBER,
  LOTTERY_MIN_NUMBER,
  LOTTERY_NUMBER_COUNT,
  LOTTERY_TICKET_COST,
  rollDie,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';

/**
 * 波 6 乐透测试（TILE-19 / ECON-08）：
 * - 乐透行自选号码投注：单注 ¥1000（不随物价指数缩放），号码区间 0–99；
 * - 每月 15 号开奖：中奖者均分奖池，无人中奖则奖金累积至下期；
 * - 运气/事件罚金（缴税等无收款方支出）汇入奖池；
 * - 开奖号码由 rngState **只读派生**，不扰动确定性回放的抽数序列。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;
/**
 * 2026-02-14（周六）：再走一天即 02-15（周日）。15 号照常开奖，而周日休市使
 * `tickStockMarket` 提前返回、随机新闻不介入，因此奖池/现金断言可精确到个位。
 */
const QUIET_DAY_BEFORE_DRAW = { year: 2026, month: 2, day: 14 } as const;
/** 2026-02-13（周五）：再走一天即 02-14（周六休市，非 15 号）——不开奖且无随机新闻干扰 */
const QUIET_DAY = { year: 2026, month: 2, day: 13 } as const;

function newGame(seed = 42, startDate: { year: number; month: number; day: number } = { ...MONDAY }): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate }), { type: 'START_GAME' });
  for (const p of g.players) p.diceCount = 2;
  return g;
}

function seedForSum(target: number): number {
  for (let s = 1; s <= 200000; s++) {
    const a = rollDie(s);
    const b = rollDie(a.nextState);
    if (a.value + b.value === target) return s;
  }
  throw new Error(`找不到和为 ${target} 的种子`);
}

/** 把当前玩家摆到能以 sum 点落到 targetCell 的位置，并固定骰子结果 */
function landOn(state: GameState, targetCell: number, sum = 6): GameState {
  const s = structuredClone(state);
  s.rngState = seedForSum(sum);
  s.players[s.currentPlayerIndex]!.position = (targetCell - sum + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

/** 让回合绕回以触发日切（末日玩家结束回合 → 下一轮回到首位玩家） */
function nextDay(state: GameState): GameState {
  const g = structuredClone(state);
  g.currentPlayerIndex = g.players.length - 1;
  g.phase = 'awaiting_action';
  g.bankAccess = null;
  return applyAction(g, { type: 'FINISH_LANDING' });
}

describe('乐透号码与单注价（TILE-19 / ECON-08）', () => {
  it('号码区间 0–99 共 100 个，单注 ¥1000', () => {
    expect(LOTTERY_MIN_NUMBER).toBe(0);
    expect(LOTTERY_MAX_NUMBER).toBe(99);
    expect(LOTTERY_NUMBER_COUNT).toBe(100);
    expect(LOTTERY_TICKET_COST).toBe(1000);
    expect(isValidLotteryNumber(0)).toBe(true);
    expect(isValidLotteryNumber(99)).toBe(true);
    expect(isValidLotteryNumber(-1)).toBe(false);
    expect(isValidLotteryNumber(100)).toBe(false);
    expect(isValidLotteryNumber(3.5)).toBe(false);
  });

  it('开奖号码为只读派生：不推进 rngState', () => {
    const g = newGame(1301);
    const before = g.rngState;
    const n1 = drawWinningNumber(before);
    const n2 = drawWinningNumber(before);
    expect(n1).toBe(n2); // 同一种子必然同号
    expect(n1).toBeGreaterThanOrEqual(LOTTERY_MIN_NUMBER);
    expect(n1).toBeLessThanOrEqual(LOTTERY_MAX_NUMBER);
    expect(g.rngState).toBe(before); // 未被修改
  });
});

describe('乐透投注（TILE-19）', () => {
  it('站立乐透行可自选号码投注，款项计入奖池', () => {
    const g = pinIndexOne(newGame(1302));
    const rolled = applyAction(landOn(g, 54), { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(availableActions(rolled).canBuyLottery).toBe(true);
    expect(availableActions(rolled).lotteryTicketCost).toBe(1000);

    const bet = applyAction(rolled, { type: 'BUY_LOTTERY_TICKET', number: 42 });
    expect(bet.players[0]!.cash).toBe(15000 - 1000);
    expect(bet.lotteryPool).toBe(1000);
    expect(bet.lotteryTickets).toEqual([{ playerId: 'p1', number: 42 }]);
    // R4：买一张就是本格的终结动作 —— 没有「再干点别的」这一段，回合自动交给下一位
    expect(bet.phase).toBe('awaiting_roll');
    expect(bet.landing).toBeNull();
    expect(bet.currentPlayerIndex).toBe(1);
  });

  it('不在乐透行不能投注，现金不足亦被拒', () => {
    const base = pinIndexOne(newGame(1303));
    const g = structuredClone(base);
    g.players[0]!.position = 2; // 商店格
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'BUY_LOTTERY_TICKET', number: 1 })).toThrow('不在乐透行，不能投注');

    const poor = structuredClone(base);
    poor.players[0]!.position = 54;
    poor.phase = 'awaiting_action';
    poor.players[0]!.cash = 999;
    expect(() => applyAction(poor, { type: 'BUY_LOTTERY_TICKET', number: 1 })).toThrow('现金不足');
  });

  it('号码越界或非整数被拒（ECON-08）', () => {
    const g = pinIndexOne(newGame(1304));
    const rolled = applyAction(landOn(g, 54), { type: 'ROLL_DICE' });
    expect(() => applyAction(rolled, { type: 'BUY_LOTTERY_TICKET', number: 100 })).toThrow('号码必须是 0-99 的整数');
    expect(() => applyAction(rolled, { type: 'BUY_LOTTERY_TICKET', number: -1 })).toThrow('号码必须是 0-99 的整数');
    expect(() => applyAction(rolled, { type: 'BUY_LOTTERY_TICKET', number: 1.5 })).toThrow('号码必须是 0-99 的整数');
  });
});

describe('每月 15 号开奖（ECON-08）', () => {
  it('中奖者独得奖池，票据清空', () => {
    const base = pinIndexOne(newGame(1305, { ...QUIET_DAY_BEFORE_DRAW }));
    const winning = drawWinningNumber(base.rngState);
    base.lotteryTickets = [{ playerId: 'p1', number: winning }];
    base.lotteryPool = 5000;

    const next = nextDay(base);
    expect(next.players[0]!.cash).toBe(15000 + 5000);
    expect(next.lotteryPool).toBe(0);
    expect(next.lotteryTickets).toEqual([]);
    expect(next.log.some((e) => e.text.includes('【乐透开奖】') && e.text.includes('中奖！'))).toBe(true);
  });

  it('多人同时中奖均分奖池', () => {
    const base = pinIndexOne(newGame(1306, { ...QUIET_DAY_BEFORE_DRAW }));
    const winning = drawWinningNumber(base.rngState);
    base.lotteryTickets = [
      { playerId: 'p1', number: winning },
      { playerId: 'p2', number: winning },
    ];
    base.lotteryPool = 5001;

    const next = nextDay(base);
    expect(next.players[0]!.cash).toBe(15000 + 2500);
    expect(next.players[1]!.cash).toBe(15000 + 2500);
    expect(next.lotteryPool).toBe(1); // 零头滚动至下期
    expect(next.lotteryTickets).toEqual([]);
  });

  it('无人中奖则奖金累积至下期，票据清空', () => {
    const base = pinIndexOne(newGame(1307, { ...QUIET_DAY_BEFORE_DRAW }));
    const losing = (drawWinningNumber(base.rngState) + 1) % LOTTERY_NUMBER_COUNT;
    base.lotteryTickets = [{ playerId: 'p1', number: losing }];
    base.lotteryPool = 5000;

    const next = nextDay(base);
    expect(next.players[0]!.cash).toBe(15000);
    expect(next.lotteryPool).toBe(5000);
    expect(next.lotteryTickets).toEqual([]);
    expect(next.log.some((e) => e.text.includes('无人中奖'))).toBe(true);
  });

  it('非 15 号不开奖，票据与奖池原样保留', () => {
    const base = pinIndexOne(newGame(1308, { ...QUIET_DAY }));
    base.lotteryTickets = [{ playerId: 'p1', number: 7 }];
    base.lotteryPool = 3000;

    const next = nextDay(base);
    expect(next.lotteryPool).toBe(3000);
    expect(next.lotteryTickets).toEqual([{ playerId: 'p1', number: 7 }]);
    expect(next.log.some((e) => e.text.includes('【乐透开奖】'))).toBe(false);
  });

  it('无票据时不开奖（不产生空开奖日志）', () => {
    const base = pinIndexOne(newGame(1309, { ...QUIET_DAY_BEFORE_DRAW }));
    const next = nextDay(base);
    expect(next.lotteryPool).toBe(0);
    expect(next.log.some((e) => e.text.includes('【乐透开奖】'))).toBe(false);
  });
});

describe('罚金汇入奖池（ECON-08）', () => {
  it('缴税等无收款方支出计入奖池', () => {
    const g = pinIndexOne(newGame(1310));
    const rolled = applyAction(landOn(g, 21), { type: 'ROLL_DICE' });
    const tax = 15000 - rolled.players[0]!.cash;
    expect(tax).toBe(1500); // 现金的 10%
    expect(rolled.lotteryPool).toBe(tax);
  });

  it('租金（有收款方）不汇入奖池', () => {
    const base = pinIndexOne(newGame(1311));
    // 8 号淮海路：从 2 号格走 6 步抵达，不经过起点（不会混入薪水）
    base.players[1]!.properties = [{ cellId: 8, grade: 1 }];
    const rolled = applyAction(landOn(base, 8), { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBeLessThan(15000); // 付了租金
    expect(rolled.lotteryPool).toBe(0);
  });
});