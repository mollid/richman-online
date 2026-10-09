import { describe, expect, it } from 'vitest';
import {
  addMonths,
  addPlayer,
  applyAction,
  availableActions,
  createGame,
  daysInMonth,
  elapsedDays,
  fromSerial,
  gameDate,
  MAX_LOAN,
  nextRandom,
  POINTS_START,
  priceIndex,
  ReplayEngine,
  rollDie,
  scaled,
  STARTING_CASH,
  toSerial,
  totalAssets,
  weekdayOf,
} from '../src/index.js';
import type { DateSerial, GameState, PlayerAction, PlayerDef } from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
];

/** 周一、非 15 号、非月末：保证日切钩子不会在用例中途被动触发 */
const MONDAY: DateSerial = { year: 2026, month: 1, day: 5 };
/** 周六：例假休市 */
const SATURDAY: DateSerial = { year: 2026, month: 1, day: 10 };

function newGame(seed = 42, startDate: DateSerial = MONDAY): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...startDate } }), { type: 'START_GAME' });
  // 迁移（波 2 / CORE-03）：步行默认 1 颗骰子；历史断言基于两骰之和，故统一配机车（diceCount=2）。
  for (const p of g.players) p.diceCount = 2;
  return g;
}

/** 找一个能让两骰之和等于 target 的确定性种子 */
function seedForSum(target: number): number {
  for (let s = 1; s <= 200000; s++) {
    const a = rollDie(s);
    const b = rollDie(a.nextState);
    if (a.value + b.value === target) return s;
  }
  throw new Error(`找不到和为 ${target} 的种子`);
}

/**
 * 找掷骰和为 target、且回合回绕（日切）时【不触发】玩家新闻事件的种子。
 * 日切抽数固定为「6 支股票波动 + 新闻选股 + 涨跌方向」共 8 抽，第 9 抽是事件门槛。
 */
function seedForSumQuietNews(target: number): number {
  for (let seed = 1; seed <= 200000; seed++) {
    const a = rollDie(seed);
    const b = rollDie(a.nextState);
    if (a.value + b.value !== target) continue;
    let st = b.nextState;
    for (let i = 0; i < 8; i++) st = nextRandom(st).nextState;
    if (nextRandom(st).value >= 0.25) return seed;
  }
  throw new Error('找不到满足条件的种子');
}

/** 把当前玩家摆到 35 号银行格（不经过起点） */
function landOnBank(startDate: DateSerial = MONDAY): GameState {
  const s = newGame(9001, startDate);
  s.rngState = seedForSum(7);
  s.players[s.currentPlayerIndex]!.position = 28; // 28 + 7 = 35
  return applyAction(s, { type: 'ROLL_DICE' });
}

/**
 * 双方各掷一次 3 点 → 推进正好一天。
 * 落格取 41 号「点券站」（38 + 3）：只加点券、不动现金/存款；
 * 种子取「日切不触发玩家新闻事件」的样本，避免随机新闻扰动金额断言。
 */
function advanceOneDay(state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 2; i++) {
    s.rngState = seedForSumQuietNews(3);
    s.players[s.currentPlayerIndex]!.position = 38;
    s = applyAction(s, { type: 'ROLL_DICE' });
  }
  return s;
}

describe('ECON-01 三货币初始值与冻结分母', () => {
  it('现金/存款/点券/贷款字段初始化正确', () => {
    const g = createGame(PLAYERS, 42, { startDate: { ...MONDAY } });
    expect(g.players[0]).toMatchObject({ cash: STARTING_CASH, deposit: 0, points: POINTS_START, loan: null });
    expect(g.players[1]).toMatchObject({ cash: STARTING_CASH, deposit: 0, points: POINTS_START, loan: null });
    expect(g.calendar).toEqual({ start: MONDAY, elapsedDays: 0 });
    expect(g.bankAccess).toBeNull();
    expect(g.lotteryPool).toBe(0);
  });

  it('startGame 冻结物价指数分母，开局指数恒为 1', () => {
    const g = newGame();
    expect(g.initialCashPerPlayer).toBe(STARTING_CASH);
    expect(g.initialPlayerCount).toBe(2);
    expect(priceIndex(g)).toBe(1);
  });

  it('房间阶段加入的玩家同样获得三货币初始值', () => {
    let lobby = createGame([], 7, { startDate: { ...MONDAY } });
    lobby = addPlayer(lobby, PLAYERS[0]!);
    lobby = addPlayer(lobby, PLAYERS[1]!);
    const started = applyAction(lobby, { type: 'START_GAME' });
    expect(started.players[1]).toMatchObject({ cash: STARTING_CASH, deposit: 0, points: POINTS_START, loan: null });
    expect(started.initialPlayerCount).toBe(2);
  });
});

describe('TIME-01 日期派生与 elapsedDays 守护', () => {
  it('elapsedDays === round - 1（波 1 恒等式）', () => {
    let s = newGame(313);
    for (let i = 0; i < 90 && s.phase !== 'game_over'; i++) {
      // 记忆翻牌需翻开未消除且未翻开的牌，固定洞位会报错；其余小游戏洞位 0 即可
      const mg = s.minigame;
      const hole =
        mg && mg.kind === 'memory'
          ? Math.max(0, mg.matched.findIndex((m, idx) => !m && !mg.revealed.includes(idx)))
          : 0;
      const action: PlayerAction =
        s.phase === 'awaiting_roll'
          ? { type: 'ROLL_DICE' }
          : s.phase === 'awaiting_action'
            ? { type: 'END_TURN' }
            : { type: 'MINIGAME_PICK', hole };
      s = applyAction(s, action);
      if (s.phase === 'game_over') break;
      expect(elapsedDays(s)).toBe(s.round - 1);
      expect(s.calendar.elapsedDays).toBe(s.round - 1);
    }
    expect(s.round).toBeGreaterThan(5);
  });

  it('跨月 / 闰年 / 真实公历星期', () => {
    // 序列号往返
    for (const d of [
      { year: 1970, month: 1, day: 1 },
      { year: 2024, month: 2, day: 29 },
      { year: 2026, month: 12, day: 31 },
      { year: 1980, month: 1, day: 1 },
    ]) {
      expect(fromSerial(toSerial(d))).toEqual(d);
    }
    expect(toSerial({ year: 1970, month: 1, day: 1 })).toBe(0);
    expect(daysInMonth(2024, 2)).toBe(29); // 闰年
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2026, 1)).toBe(31);
    // 日号溢出收敛到当月最后一天
    expect(addMonths({ year: 2024, month: 1, day: 31 }, 1)).toEqual({ year: 2024, month: 2, day: 29 });
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(addMonths({ year: 2026, month: 11, day: 10 }, 3)).toEqual({ year: 2027, month: 2, day: 10 });
    // 星期（0=周日）
    expect(weekdayOf({ year: 2026, month: 1, day: 5 })).toBe(1); // 周一
    expect(weekdayOf({ year: 2026, month: 1, day: 10 })).toBe(6); // 周六
    expect(weekdayOf({ year: 2026, month: 1, day: 11 })).toBe(0); // 周日
  });

  it('gameDate 由「起始日期 + 流逝天数」派生，跨月正确', () => {
    const s = newGame(11, { year: 2026, month: 1, day: 30 });
    s.calendar.elapsedDays = 3;
    const d = gameDate(s);
    expect(d.iso).toBe('2026-02-02');
    expect(d.month).toBe(2);
    expect(d.day).toBe(2);
    expect(d.weekdayLabel).toBe('周一');
    expect(d.isHoliday).toBe(false);
    expect(d.dayIndex).toBe(3);
  });
});

describe('ECON-09 / TIME-02 例假休市', () => {
  it('周六停机：股市不波动、银行关闭、可用动作位为假', () => {
    const rolled = landOnBank(SATURDAY);
    expect(rolled.phase).toBe('awaiting_action');
    expect(gameDate(rolled).isHoliday).toBe(true);
    expect(gameDate(rolled).weekdayLabel).toBe('周六');

    const acts = availableActions(rolled);
    expect(acts.isHoliday).toBe(true);
    expect(acts.canTradeStock).toBe(false);
    expect(acts.canDeposit).toBe(false);
    expect(acts.canWithdraw).toBe(false);
    expect(acts.canLoan).toBe(false);
    expect(acts.canRepayLoan).toBe(false);
    expect(acts.canEnd).toBe(true); // END_TURN 永远可用，不会卡死

    expect(() => applyAction(rolled, { type: 'DEPOSIT', amount: 100 })).toThrow('例假日银行休市');

    // 日切到周日（仍为例假）→ 股价完全不变，并给出休市提示
    const prices = rolled.stockMarket.stocks.map((s) => s.price);
    let s = applyAction(rolled, { type: 'END_TURN' });
    expect(s.calendar.elapsedDays).toBe(0);
    s.rngState = seedForSum(3);
    s.players[1]!.position = 0; // 0 + 3 = 3 号机会格 → 自动结算并绕回 p0 → 日切
    s = applyAction(s, { type: 'ROLL_DICE' });
    expect(s.calendar.elapsedDays).toBe(1);
    expect(gameDate(s).weekdayLabel).toBe('周日');
    expect(s.log.some((e) => e.text.includes('【休市】'))).toBe(true);
    expect(s.stockMarket.stocks.map((st) => st.price)).toEqual(prices);
  });
});

describe('TIME-03 / TIME-04 日切钩子', () => {
  it('每月 15 号为分红日（波 1 占位日志）', () => {
    const s0 = newGame(151, { year: 2026, month: 1, day: 14 });
    expect(gameDate(s0).isDividendDay).toBe(false);
    const s = advanceOneDay(s0);
    expect(s.calendar.elapsedDays).toBe(1);
    expect(gameDate(s).day).toBe(15);
    expect(gameDate(s).isDividendDay).toBe(true);
    expect(s.log.some((e) => e.text.includes('【分红日】'))).toBe(true);
  });

  it('月末存款结息 10%，有贷款者当月不计息', () => {
    const s0 = newGame(161, { year: 2026, month: 1, day: 30 });
    s0.players[0]!.deposit = 1000;
    s0.players[1]!.deposit = 1000;
    s0.players[1]!.loan = { principal: 1000, takenAtDayIndex: 0, dueDayIndex: 100 };
    const s = advanceOneDay(s0);
    expect(gameDate(s).isMonthEnd).toBe(true);
    expect(s.players[0]!.deposit).toBe(1100);
    expect(s.players[1]!.deposit).toBe(1000);
    expect(s.log.some((e) => e.text.includes('因贷款在身'))).toBe(true);
  });
});

describe('ECON-04 / ECON-05 银行存取与贷款', () => {
  it('存款 / 取款边界校验与往返守恒', () => {
    const bank = landOnBank();
    expect(bank.phase).toBe('awaiting_action');
    const acts = availableActions(bank);
    expect(acts.canDeposit).toBe(true);
    expect(acts.canWithdraw).toBe(false); // 存款为 0
    expect(acts.canLoan).toBe(true);
    expect(acts.canRepayLoan).toBe(false);

    expect(() => applyAction(bank, { type: 'DEPOSIT', amount: 0 })).toThrow('金额必须为正整数');
    expect(() => applyAction(bank, { type: 'DEPOSIT', amount: -5 })).toThrow('金额必须为正整数');
    expect(() => applyAction(bank, { type: 'DEPOSIT', amount: 1.5 })).toThrow('金额必须为正整数');
    expect(() => applyAction(bank, { type: 'DEPOSIT', amount: STARTING_CASH + 1 })).toThrow('现金不足');

    const deposited = applyAction(bank, { type: 'DEPOSIT', amount: 4000 });
    expect(deposited.players[0]!.cash).toBe(STARTING_CASH - 4000);
    expect(deposited.players[0]!.deposit).toBe(4000);
    expect(availableActions(deposited).canWithdraw).toBe(true);

    expect(() => applyAction(deposited, { type: 'WITHDRAW', amount: 4001 })).toThrow('存款不足');
    const withdrawn = applyAction(deposited, { type: 'WITHDRAW', amount: 4000 });
    expect(withdrawn.players[0]!.cash).toBe(STARTING_CASH);
    expect(withdrawn.players[0]!.deposit).toBe(0);
  });

  it('非银行格不能存取/贷款', () => {
    const g = newGame(33);
    expect(() => applyAction(g, { type: 'DEPOSIT', amount: 100 })).toThrow('当前不能进行银行操作');
    expect(() => applyAction(g, { type: 'TAKE_LOAN', amount: 100 })).toThrow('当前不能进行银行操作');
    expect(() => applyAction(g, { type: 'REPAY_LOAN', amount: 100 })).toThrow('当前不能进行银行操作');
  });

  it('贷款全流程：上限 / 到期日 / 部分还 / 全额还 / 重复贷款被拒', () => {
    const bank = landOnBank(MONDAY);
    const today = gameDate(bank);
    const expectedDue =
      toSerial(addMonths({ year: today.year, month: today.month, day: today.day }, 3)) - toSerial(bank.calendar.start);

    expect(() => applyAction(bank, { type: 'TAKE_LOAN', amount: MAX_LOAN + 1 })).toThrow(`单笔贷款上限 ¥${MAX_LOAN}`);
    expect(() => applyAction(bank, { type: 'TAKE_LOAN', amount: 0 })).toThrow('金额必须为正整数');

    const borrowed = applyAction(bank, { type: 'TAKE_LOAN', amount: 5000 });
    expect(borrowed.players[0]!.cash).toBe(STARTING_CASH + 5000);
    expect(borrowed.players[0]!.loan).toEqual({ principal: 5000, takenAtDayIndex: 0, dueDayIndex: expectedDue });
    expect(availableActions(borrowed).canLoan).toBe(false);
    expect(availableActions(borrowed).canRepayLoan).toBe(true);
    expect(() => applyAction(borrowed, { type: 'TAKE_LOAN', amount: 100 })).toThrow('已有未还清的贷款');

    const poor = structuredClone(borrowed);
    poor.players[0]!.cash = 100;
    expect(() => applyAction(poor, { type: 'REPAY_LOAN', amount: 5000 })).toThrow('现金不足');

    const partial = applyAction(borrowed, { type: 'REPAY_LOAN', amount: 2000 });
    expect(partial.players[0]!.cash).toBe(STARTING_CASH + 3000);
    expect(partial.players[0]!.loan!.principal).toBe(3000);

    const cleared = applyAction(partial, { type: 'REPAY_LOAN', amount: 3000 });
    expect(cleared.players[0]!.loan).toBeNull();
    expect(cleared.players[0]!.cash).toBe(STARTING_CASH);
    expect(() => applyAction(cleared, { type: 'REPAY_LOAN', amount: 100 })).toThrow('当前没有贷款');
  });

  it('贷款到期强制全额归还', () => {
    const s0 = newGame(173);
    s0.players[0]!.loan = { principal: 1000, takenAtDayIndex: 0, dueDayIndex: 1 };
    const s = advanceOneDay(s0);
    expect(s.calendar.elapsedDays).toBe(1);
    expect(s.players[0]!.loan).toBeNull();
    expect(s.players[0]!.cash).toBe(STARTING_CASH - 1000);
    expect(s.log.some((e) => e.text.includes('【贷款到期】'))).toBe(true);
  });
});

describe('ECON-02 / ECON-03 三货币支付管道', () => {
  it('现金不足时自动动用存款，租金入收款方存款', () => {
    // 起始日为周六：回合绕回后落在周日（例假休市），避免随机新闻干扰断言
    const g = newGame(181, SATURDAY);
    g.currentPlayerIndex = 1;
    g.rngState = seedForSum(6);
    g.players[1]!.position = 24; // 24 + 6 = 30 陆家嘴
    g.players[0]!.properties = [{ cellId: 30, grade: 3 }];
    g.players[1]!.cash = 200;
    g.players[1]!.deposit = 2000;
    pinIndexOne(g);

    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const rent = 230 * 3; // 690
    expect(rolled.players[1]!.bankrupt).toBe(false);
    expect(rolled.players[1]!.cash).toBe(0);
    expect(rolled.players[1]!.deposit).toBe(2000 - (rent - 200));
    expect(rolled.players[0]!.cash).toBe(STARTING_CASH); // 收款方入存款
    expect(rolled.players[0]!.deposit).toBe(rent);
  });

  it('现金与存款耗尽即破产（不自动变卖资产）并清空三货币', () => {
    const g = newGame(183, SATURDAY);
    g.currentPlayerIndex = 1;
    g.rngState = seedForSum(6);
    g.players[1]!.position = 24;
    g.players[0]!.properties = [{ cellId: 30, grade: 3 }];
    g.players[1]!.cash = 100;
    g.players[1]!.deposit = 100;
    g.players[1]!.properties = [{ cellId: 6, grade: 1 }];
    g.players[1]!.stocks = { tech: 10 }; // 有股票也不会被自动变卖
    pinIndexOne(g);

    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const paidOut = 200; // 现金100 + 存款100 = 200 < 690，不再变卖地产回收
    expect(rolled.players[1]!.bankrupt).toBe(true);
    expect(rolled.players[1]!.cash).toBe(0);
    expect(rolled.players[1]!.deposit).toBe(0);
    expect(rolled.players[1]!.points).toBe(0);
    expect(rolled.players[1]!.loan).toBeNull();
    expect(rolled.players[0]!.deposit).toBe(paidOut); // 收款方只按实付入账
    // 地产未被自动变卖（破产清算才清空）
    expect(rolled.log.some((e) => e.text.includes('出售'))).toBe(false);
    expect(rolled.winnerId).toBe('p1');
    expect(rolled.phase).toBe('game_over');
  });
});

describe('ECON-06 物价指数', () => {
  it('初始指数为 1，注入资产后按比例上升并驱动 scaled', () => {
    const s = newGame(191);
    expect(priceIndex(s)).toBe(1);
    expect(scaled(s, 1000)).toBe(1000);

    const rich = structuredClone(s);
    rich.players[0]!.cash += 15000; // 总资产 45000 / 30000
    expect(priceIndex(rich)).toBeCloseTo(1.5, 6);
    expect(scaled(rich, 1000)).toBe(1500);
    expect(scaled(rich, 690)).toBe(1035);
  });

  it('clamp 上下限，破产玩家不计入分子', () => {
    const s = newGame(193);

    const huge = structuredClone(s);
    huge.initialCashPerPlayer = 1;
    huge.initialPlayerCount = 1;
    huge.players[0]!.cash = 200000;
    expect(priceIndex(huge)).toBe(107374);

    const tiny = structuredClone(s);
    tiny.initialCashPerPlayer = 1_000_000_000;
    tiny.initialPlayerCount = 2;
    expect(priceIndex(tiny)).toBe(0.01);

    const half = structuredClone(s);
    half.players[1]!.bankrupt = true;
    half.players[1]!.cash = 0;
    expect(priceIndex(half)).toBeCloseTo(0.5, 6);
  });

  it('totalAssets 计入存款/股票/不动产并扣减贷款本金', () => {
    const s = newGame(195);
    const p = s.players[0]!;
    p.deposit = 500;
    p.stocks = { tech: 10 }; // 120 × 10 = 1200
    p.properties = [{ cellId: 4, grade: 1 }]; // 基础价 350
    p.loan = { principal: 800, takenAtDayIndex: 0, dueDayIndex: 90 };
    expect(totalAssets(s, p)).toBe(STARTING_CASH + 500 + 1200 + 350 - 800);
  });
});

describe('TIME-06 确定性：同 seed + startDate + actions 完整复现', () => {
  /** 小游戏进行中：记忆翻牌需挑一张尚未翻开/未消除的牌，其余小游戏固定猜 0 号 */
  function nextPick(s: GameState): number {
    const mg = s.minigame;
    if (!mg || mg.kind !== 'memory') return 0;
    const idx = mg.symbols.findIndex((_, i) => !mg.matched[i] && !mg.revealed.includes(i));
    return idx < 0 ? 0 : idx;
  }

  function drive(seed: number): { state: GameState; actions: PlayerAction[] } {
    let s = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    const actions: PlayerAction[] = [{ type: 'START_GAME' }];
    for (let i = 0; i < 40 && s.phase !== 'game_over'; i++) {
      const action: PlayerAction =
        s.phase === 'awaiting_roll'
          ? { type: 'ROLL_DICE' }
          : s.phase === 'awaiting_action'
            ? { type: 'END_TURN' }
            : { type: 'MINIGAME_PICK', hole: nextPick(s) };
      s = applyAction(s, action);
      actions.push(action);
    }
    return { state: s, actions };
  }

  const fingerprint = (s: GameState) =>
    JSON.stringify({
      round: s.round,
      turn: s.turn,
      phase: s.phase,
      rngState: s.rngState,
      calendar: s.calendar,
      // 神明现身本身也是一条必须复现的轨迹：它写 boardGods / 对偶冷却，也吃 RNG 抽数
      boardGods: s.boardGods,
      godPairBanUntil: s.godPairBanUntil,
      players: s.players.map((p) => [p.position, p.cash, p.deposit, p.points, p.loan, p.properties]),
    });

  it('两次独立推进结果完全一致', () => {
    const a = drive(555);
    const b = drive(555);
    expect(fingerprint(a.state)).toBe(fingerprint(b.state));
  });

  it('ReplayEngine 用同一 seed/startDate/动作序列复现出相同局面', () => {
    const a = drive(777);
    const record = {
      seed: 777,
      startDate: { ...MONDAY },
      players: PLAYERS.map((p) => ({ player_name: p.name, color: p.color })),
      actions: a.actions.map((action, i) => ({ turn: i, action })),
    };
    // 录像只需要三样东西：seed、起始日期、动作序列。神明现身（W2）这类会吃 RNG 抽数的
    // 随机源不必另存标记 —— 重放走的就是当前引擎、当前规则，抽数次序自然一致。
    const engine = new ReplayEngine(record);
    expect(fingerprint(engine.finalState)).toBe(fingerprint(a.state));
  });
});