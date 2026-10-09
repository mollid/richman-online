import { describe, expect, it } from 'vitest';
import { addPlayer, allAssetSummaries, allStockSummaries, applyAction, availableActions, BOARD_SIZE, gameDate, createGame, priceIndex, forceGameOver, GOD_DURATION_DAYS, GODS, nextRandom, removePlayer, rentOf, ReplayEngine, rollDie, STARTING_ITEMS, upgradeCost } from '../src/index.js';
import type { GameState, PlayerAction, PlayerDef } from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
];

/**
 * 迁移策略一：固定起始日期。
 * 波 1 引入时间日历（例假休市）后，`elapsedDays` 会随回合推进跨到周末，
 * 若用系统当天日期做起点，测试结果会随运行日漂移。统一固定为周一、非 15 号、非月末。
 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  // 迁移（波 2 / CORE-03）：步行默认 1 颗骰子，机车 2 颗、汽车 3 颗。
  // 下列历史断言基于「两骰之和」，故统一给测试玩家配机车（diceCount=2）以保持既有语义。
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

/** 找掷骰和为 target、且回合回绕时【不触发】玩家新闻事件的种子 */
function seedForSumQuietNews(target: number): number {
  for (let seed = 1; seed <= 200000; seed++) {
    const a = rollDie(seed);
    const b = rollDie(a.nextState);
    if (a.value + b.value !== target) continue;
    // 事件抽取是本轮第 9 抽：前 8 抽为 6 支股票波动 + 新闻选股 + 涨跌方向
    let st = b.nextState;
    for (let i = 0; i < 8; i++) st = nextRandom(st).nextState;
    const ev = nextRandom(st);
    if (ev.value >= 0.25) return seed;
  }
  throw new Error('找不到满足条件的种子');
}

/** 找一个第一抽骰子点数落在给定集合内的种子 */
function seedForFirstDie(values: number[]): number {
  for (let s = 1; s <= 200000; s++) {
    const r = rollDie(s);
    if (values.includes(r.value)) return s;
  }
  throw new Error(`找不到第一骰为 ${values} 的种子`);
}

/** 把当前玩家摆到能以 sum 点落到 targetCell 的位置，并固定骰子结果 */
function setupLanding(state: GameState, targetCell: number, sum: number): GameState {
  const s = structuredClone(state);
  s.rngState = seedForSum(sum);
  s.players[s.currentPlayerIndex]!.position = (targetCell - sum + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

/** 推进一个动作（掷骰 / 结束回合 / 小游戏选杯）：落格可能停在 awaiting_action，需能收尾 */
function step(state: GameState): GameState {
  if (state.phase === 'awaiting_roll') return applyAction(state, { type: 'ROLL_DICE' });
  if (state.phase === 'awaiting_pick') return applyAction(state, { type: 'MINIGAME_PICK', hole: 0 });
  return applyAction(state, { type: 'END_TURN' });
}

/** 一直推进到跨过一天（触发日切钩子：神明计时递减/转化） */
function advanceOneDay(state: GameState): GameState {
  const start = state.calendar.elapsedDays;
  let s = state;
  for (let i = 0; i < 16 && s.calendar.elapsedDays === start; i++) s = step(s);
  return s;
}

describe('createGame', () => {
  it('初始状态正确', () => {
    const g = createGame(PLAYERS, 1, { startDate: { ...MONDAY } });
    expect(g.phase).toBe('lobby');
    expect(g.players).toHaveLength(2);
    expect(g.players[0]!.cash).toBe(15000);
    expect(g.players[0]!.position).toBe(0);
    expect(g.board).toHaveLength(BOARD_SIZE);
    expect(BOARD_SIZE).toBe(64);
  });

  it('人数不合法时报错', () => {
    expect(() => createGame([...PLAYERS, ...PLAYERS, ...PLAYERS.slice(0, 1)])).toThrow();
    const one = createGame([PLAYERS[0]!]);
    expect(() => applyAction(one, { type: 'START_GAME' })).toThrow('至少需要 2 名玩家');
  });

  it('支持房间阶段加入/移除玩家', () => {
    let g = createGame([], 9, { startDate: { ...MONDAY } });
    expect(() => applyAction(g, { type: 'START_GAME' })).toThrow('至少需要 2 名玩家'); // 0 人不能开始
    g = addPlayer(g, PLAYERS[0]!);
    g = addPlayer(g, PLAYERS[1]!);
    expect(g.players).toHaveLength(2);
    expect(() => addPlayer(g, PLAYERS[0]!)).toThrow('玩家已存在');
    g = removePlayer(g, 'p1');
    expect(g.players).toHaveLength(1);
    g = addPlayer(g, { id: 'p3', name: '老王', color: 0x66bb6a });
    const started = applyAction(g, { type: 'START_GAME' });
    expect(started.phase).toBe('awaiting_roll');
    expect(() => addPlayer(started, { id: 'p3', name: '老王', color: 0 })).toThrow('游戏已开始');
  });
});

describe('回合流转', () => {
  it('掷骰后按点数移动且不修改原状态', () => {
    const g = newGame(7);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const sum = rolled.dice!.reduce((a, b) => a + b, 0);
    expect(rolled.players[0]!.position).toBe(sum % BOARD_SIZE);
    expect(g.players[0]!.position).toBe(0); // 纯函数：原状态未被修改
  });

  it('经过起点领取薪水', () => {
    const g = newGame(99);
    g.rngState = seedForSum(2);
    // 62 + 2 = 64 → 正好停在起点：越过起点即领薪水（落格为起点，无命运卡等其它结算）
    g.players[0]!.position = 62;
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe(0);
    expect(rolled.players[0]!.cash).toBe(15000 + 2000);
  });

  it('落地无主地产进入决策阶段，可购买', () => {
    // 落到 4 号格（成都路，无主），从 1 号出发不经过起点
    const g = setupLanding(newGame(11), 4, 3);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    const acts = availableActions(rolled);
    expect(acts.canBuy).toBe(true);
    expect(acts.canEnd).toBe(true);

    const bought = applyAction(rolled, { type: 'BUY_LAND' });
    const p = bought.players[0]!;
    expect(p.cash).toBe(15000 - 350);
    expect(p.properties).toEqual([{ cellId: 4, grade: 1 }]);
    expect(bought.phase).toBe('awaiting_roll');
    expect(bought.currentPlayerIndex).toBe(1);
  });

  it('落地他人地产自动支付租金', () => {
    // p1 拥有 6 号南京路 2 级，p2 落上去应付 130*2=260
    const g = newGame(23);
    g.currentPlayerIndex = 1;
    g.rngState = seedForSumQuietNews(3);
    g.players[1]!.position = 3; // 3 + 3 = 6，不经过起点
    g.players[0]!.properties = [{ cellId: 6, grade: 2 }];
    pinIndexOne(g);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.cash).toBe(15000 - 260);
    // ECON-02：租金入收款方「存款」
    expect(rolled.players[0]!.deposit).toBe(260);
    expect(rentOf(130, 2)).toBe(260);
  });

  it('付不起租金则破产，对手获胜', () => {
    const g = setupLanding(newGame(31), 6, 6);
    g.rngState = seedForSumQuietNews(6);
    g.currentPlayerIndex = 1;
    g.players[0]!.properties = [{ cellId: 6, grade: 3 }];
    g.players[1]!.cash = 100;
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.bankrupt).toBe(true);
    expect(rolled.players[1]!.cash).toBe(0);
    expect(rolled.phase).toBe('game_over');
    expect(rolled.winnerId).toBe('p1');
  });

  it('回到自家地产可升级，费用正确', () => {
    // 落到自有的 22 号光谷（从 14 号出发，不经过起点）
    const g = setupLanding(newGame(5), 22, 8);
    g.players[0]!.properties = [{ cellId: 22, grade: 1 }];
    g.players[0]!.cash = 10000;
    pinIndexOne(g);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(upgradeCost(780, 1)).toBe(468);
    const upgraded = applyAction(rolled, { type: 'UPGRADE_LAND' });
    expect(upgraded.players[0]!.properties[0]).toEqual({ cellId: 22, grade: 2 });
    expect(upgraded.players[0]!.cash).toBe(10000 - 468);
  });

  it('满级地产不可升级', () => {
    const g = setupLanding(newGame(5), 1, 5);
    g.players[0]!.properties = [{ cellId: 1, grade: 5 }];
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_roll'); // 满级自动过
    expect(() => applyAction(rolled, { type: 'UPGRADE_LAND' })).toThrow();
  });

  it('落地医院暂停一回合', () => {
    const g = setupLanding(newGame(13), 14, 4);
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.skipTurns).toBe(1);
    expect(landed.currentPlayerIndex).toBe(1);

    // p2 走一步
    const after2 = applyAction(landed, { type: 'ROLL_DICE' });
    expect(after2.currentPlayerIndex).toBe(0);
    // p1 掷骰 → 触发跳过，回到 p2
    const skipped = applyAction(after2, { type: 'ROLL_DICE' });
    expect(skipped.players[0]!.skipTurns).toBe(0);
    expect(skipped.currentPlayerIndex).toBe(1);
    expect(skipped.phase).toBe('awaiting_roll');
  });

  it('落地监狱门外安全不停留，且可保释在押恶人', () => {
    const g = setupLanding(newGame(17), 26, 8);
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    // TILE-10：监狱门外安全，不再落地坐牢
    expect(landed.players[0]!.skipTurns).toBe(0);
    expect(landed.players[0]!.custody).toBeNull();
    expect(landed.phase).toBe('awaiting_action');
    // 在押恶人可保释
    expect(availableActions(landed).bailableVillains).toEqual([
      'thief',
      'protection',
      'robber',
      'rent-thief',
    ]);
  });

  it('缴税扣除 10% 现金', () => {
    const g = setupLanding(newGame(19), 21, 7);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBe(15000 - 1500);
  });

  it('非法动作被拒绝', () => {
    const lobby = createGame(PLAYERS, 3);
    expect(() => applyAction(lobby, { type: 'ROLL_DICE' })).toThrow();
    const g = newGame(29);
    expect(() => applyAction(g, { type: 'BUY_LAND' })).toThrow();
    expect(() => applyAction(g, { type: 'END_TURN' })).toThrow();
  });
});




describe('开局道具（用户规则：机器娃娃/遥控骰子/路障/定时炸弹/地雷/机器工人 各 1）', () => {
  it('开始游戏后每名玩家获赠初始道具', () => {
    const g = newGame(5);
    for (const p of g.players) {
      expect(p.items).toEqual({ ...STARTING_ITEMS });
    }
    expect(g.log.some((l) => l.text.includes('开局道具'))).toBe(true);
  });

  it('大厅内尚未发放，开始游戏后才到账', () => {
    const lobby = createGame(PLAYERS, 5, { startDate: { ...MONDAY } });
    for (const p of lobby.players) expect(p.items).toEqual({});
    const started = applyAction(lobby, { type: 'START_GAME' });
    expect(started.players[0]!.items['robot-doll']).toBe(1);
    expect(started.players[1]!.items['robot-worker']).toBe(1);
  });
});

describe('M2 卡片系统', () => {  it('卡片屋（TILE-13）免费获得一张卡片', () => {
    // 波 8 起机会格改抽命运卡池（TILE-17 原版语义），免费赠卡改由 42 号「卡片屋」承担
    const g = setupLanding(newGame(101), 42, 5);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cards).toHaveLength(1);
    expect(rolled.log.some((e) => e.text.includes('抽到卡片'))).toBe(true);
  });

  it('商店可以点券购买卡片并扣点券（现金不动）', () => {
    const g = setupLanding(newGame(103), 2, 2); // 落到 2 号商店（从 0 号出发，不绕起点）
    g.players[0]!.points = 1000; // 点券需先赚后花（初始 0：宝箱/点券格/小游戏/变卖）
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(availableActions(rolled).canShop).toBe(true);
    const bought = applyAction(rolled, { type: 'BUY_CARD', cardId: 'demolish' });
    expect(bought.players[0]!.cards).toContain('demolish');
    expect(bought.players[0]!.points).toBe(1000 - 15);
    expect(bought.players[0]!.cash).toBe(15000);
  });

  it('商店可点券购买道具（每种上限 9）', () => {
    const g = setupLanding(newGame(104), 2, 2);
    g.players[0]!.points = 1000; // 点券需先赚后花（初始 0）
    g.players[0]!.items = {}; // 清掉开局道具，便于断言购买数量
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const bought = applyAction(rolled, { type: 'BUY_ITEM', itemId: 'roadblock' });
    expect(bought.players[0]!.items['roadblock']).toBe(1);
    expect(bought.players[0]!.points).toBe(1000 - 30);
  });

  it('遥控骰子道具固定第一颗骰子点数', () => {
    // 固定 6 点后，随机第二骰为 2 或 4 时总点数 8/10 会落在地产格（保持决策阶段）
    const g = newGame(seedForFirstDie([2, 4]));
    g.players[0]!.items = { 'remote-dice-item': 1 };
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'remote-dice-item', diceValue: 6 });
    expect(used.pendingFixedDice).toBe(6);
    expect(used.players[0]!.items['remote-dice-item'] ?? 0).toBe(0);
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.dice![0]).toBe(6);
    expect(rolled.phase).toBe('awaiting_action');
    expect(rolled.pendingFixedDice).toBeNull();
  });

  it('均富卡平均分配现金（余数归使用者）', () => {
    const g = newGame(107);
    g.players[0]!.cards = ['even-all'];
    g.players[0]!.cash = 20001;
    g.players[1]!.cash = 10000;
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'even-all' });
    expect(used.players[0]!.cash).toBe(15001); // 均额 15000 + 余数 1
    expect(used.players[1]!.cash).toBe(15000);
  });

  it('拆除卡将目标建筑降一级', () => {
    const g = newGame(109);
    g.players[0]!.cards = ['demolish'];
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'demolish', cellId: 6 });
    expect(used.players[1]!.properties[0]).toEqual({ cellId: 6, grade: 1 });
  });

  it('抢夺卡抢走对手的卡片或道具', () => {
    const g = newGame(111);
    g.players[0]!.cards = ['snatch'];
    g.players[1]!.cards = ['hold'];
    g.players[1]!.items = {}; // 清掉开局道具，确保抢夺落在卡片上
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'snatch', targetPlayerId: 'p2' });
    expect(used.players[0]!.cards).toContain('hold');
    expect(used.players[1]!.cards).not.toContain('hold');
  });

  it('红卡使指定股票涨停（+15% 并锁定 3 天）', () => {
    const g = newGame(113);
    g.players[0]!.cards = ['red-card'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'red-card', stockId: 'tech' });
    const tech = used.stockMarket.stocks.find((s) => s.id === 'tech')!;
    expect(tech.price).toBe(138); // 120 * 1.15
    expect(used.stockHalts).toEqual([{ stockId: 'tech', kind: 'up', daysLeft: 3 }]);
  });
});

describe('M2 神仙系统（GOD-01..12 天数制）', () => {
  it('附身按天计时：当日不递减，跨日才递减', () => {
    const g = setupLanding(newGame(115), 62, 6); // p0 落到公司格（占位安全格）
    g.players[0]!.god = { godId: 'big-wealth', remainingDays: 3 };
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.god).toEqual({ godId: 'big-wealth', remainingDays: 3 });
  });

  it('神庙格召唤随机神明', () => {
    const g = setupLanding(newGame(117), 5, 4); // 落到 5 号神庙
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.god).not.toBeNull();
    expect(GODS.map((x) => x.id)).toContain(rolled.players[0]!.god!.godId);
  });
});

describe('M2 股票系统', () => {
  /** 原版规则：股票只能用存款买 → 买入前先给一笔存款 */
  function fundDeposit(state: GameState, playerIndex = 0, amount = 100000): GameState {
    state.players[playerIndex]!.deposit = amount;
    return state;
  }

  it('随时可买卖股票（不绑定银行格，help[14]）', () => {
    const g = setupLanding(fundDeposit(newGame(119)), 35, 7); // 落到 35 号银行
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(availableActions(rolled).canTradeStock).toBe(true);

    const depositBefore = rolled.players[0]!.deposit;
    const bought = applyAction(rolled, { type: 'BUY_STOCK', stockId: 'tech', quantity: 10 });
    expect(bought.players[0]!.deposit).toBe(depositBefore - 120 * 10);
    expect(bought.players[0]!.cash).toBe(15000); // 现金不动
    expect(bought.players[0]!.stocks['tech']).toBe(10);

    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 10 });
    expect(sold.players[0]!.cash).toBe(15000 + 120 * 10); // 卖股收入进现金
    expect(sold.players[0]!.stocks['tech']).toBeUndefined();
  });

  it('非银行格同样可交易（help[14]「您可以隨時進行買賣」）', () => {
    const g = setupLanding(fundDeposit(newGame(121)), 1, 4); // 落到 1 号地产
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(availableActions(rolled).canTradeStock).toBe(true);
    const bought = applyAction(rolled, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 });
    expect(bought.players[0]!.stocks['tech']).toBe(1);
    // 小游戏/拍卖等非交易阶段不可交易（回合归属由 phase 守护）
    const picking = structuredClone(bought);
    picking.phase = 'awaiting_pick';
    expect(() => applyAction(picking, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('当前不能交易股票');
    expect(availableActions(picking).canTradeStock).toBe(false);
  });

  it('掷骰前（awaiting_roll）即可买入，保证每回合都有交易机会', () => {
    const g = fundDeposit(newGame(123));
    expect(g.phase).toBe('awaiting_roll');
    expect(availableActions(g).canTradeStock).toBe(true);
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 2 });
    expect(bought.players[0]!.stocks['food']).toBe(2);
    // 交易不改变阶段，仍可继续掷骰
    expect(bought.phase).toBe('awaiting_roll');
    const rolled = applyAction(bought, { type: 'ROLL_DICE' });
    expect(rolled.turn).toBe(2);
  });

  it('买入只扣存款，现金分文不动（help[07] 银行自动转扣存款）', () => {
    const g = newGame(125);
    g.players[0]!.cash = 500;
    g.players[0]!.deposit = 5000;
    const tech = g.stockMarket.stocks.find((x) => x.id === 'tech')!; // 120/股
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 12 });
    const p = bought.players[0]!;
    expect(p.stocks.tech).toBe(12);
    expect(p.cash).toBe(500);           // 现金完全不动
    expect(p.deposit).toBe(5000 - tech.price * 12);
    expect(bought.log.some((l) => l.text.includes('以存款'))).toBe(true);
  });

  it('现金再多也不能买股票：存款不足即拒绝', () => {
    const g = newGame(126);
    g.players[0]!.deposit = 0;
    expect(g.players[0]!.cash).toBeGreaterThan(5000);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('存款不足');
  });

  it('存款不足时拒绝买入且不产生半截状态', () => {
    const g = newGame(127);
    g.players[0]!.cash = 99999;
    g.players[0]!.deposit = 100;
    const snapshot = JSON.stringify(g);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'estate', quantity: 5 })).toThrow('存款不足');
    // applyAction 是纯函数：抛错时传入对象不被修改
    expect(JSON.stringify(g)).toBe(snapshot);
    expect(g.players[0]!.stocks.estate).toBeUndefined();
    expect(g.players[0]!.deposit).toBe(100);
  });

  it('例假日休市时不可买卖（TIME-02）', () => {
    const s = newGame(129);
    s.calendar.elapsedDays = 5; // 周一 + 5 天 = 周六
    expect(gameDate(s).isHoliday).toBe(true);
    expect(availableActions(s).canTradeStock).toBe(false);
    expect(() => applyAction(s, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('休市');
    // 周日同样休市
    const sun = newGame(131);
    sun.calendar.elapsedDays = 6;
    expect(gameDate(sun).isHoliday).toBe(true);
    expect(() => applyAction(sun, { type: 'SELL_STOCK', stockId: 'tech', quantity: 1 })).toThrow('休市');
  });

  it('全市场停牌期间不可买卖（EVT-01 事件 26/27）', () => {
    const g = fundDeposit(newGame(133));
    g.stockHaltAllDays = 3;
    expect(availableActions(g).canTradeStock).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('停牌');
  });

  it('连续多回合每回合都能自由买卖（help[14] 核心诉求）', () => {
    let s = fundDeposit(newGame(137), 0, 10_000_000);
    let trades = 0;
    const tradeTurns = new Set<number>();
    const perPlayer = new Map<string, Set<string>>();
    // 走 24 个阶段：轮到谁、只要处于可交易阶段就买 1 张，全程不因落格类型受限
    for (let i = 0; i < 24; i++) {
      if (availableActions(s).canTradeStock) {
        const pid = s.players[s.currentPlayerIndex]!.id;
        // 每位玩家都要有存款才能买（股票只能用存款买）
        s.players[s.currentPlayerIndex]!.deposit += 10000;
        const stock = ['media', 'food', 'tech'][i % 3]!;
        s = applyAction(s, { type: 'BUY_STOCK', stockId: stock, quantity: 1 });
        trades += 1;
        tradeTurns.add(s.turn);
        // 该玩家第一次买这只股票时，下一手总股数正好 1
        const held = perPlayer.get(pid) ?? new Set<string>();
        const firstBuy = !held.has(stock);
        held.add(stock);
        perPlayer.set(pid, held);
        if (firstBuy) {
          expect(s.players[s.players.findIndex((p) => p.id === pid)]!.stocks[stock] ?? 0).toBe(1);
        }
      }
      if (s.phase === 'awaiting_roll') s = applyAction(s, { type: 'ROLL_DICE' });
      else if (s.phase === 'awaiting_action') s = applyAction(s, { type: 'END_TURN' });
      else if (s.phase === 'awaiting_pick') s = applyAction(s, { type: 'MINIGAME_PICK', hole: 0 });
      else if (s.phase === 'awaiting_auction') s = applyAction(s, { type: 'AUCTION_PASS' });
      else if (s.phase === 'awaiting_discard') s = applyAction(s, { type: 'DISCARD_CARD', cardId: s.players[s.currentPlayerIndex]!.cards[0]! });
      else break;
    }
    // 关键：不可交易的阶段只可能是小游戏 / 拍卖 / 强制舍弃手牌这三种**流程中**的阶段，
    // 一旦流程结束回到 awaiting_roll 就能立刻交易 → 说明「每回合都能自由买卖」
    let blockedByFlow = 0;
    for (let i = 0; i < 24; i++) {
      if (!availableActions(s).canTradeStock) {
        // 非交易阶段必须是小游戏/拍卖/舍弃流程之一（game_over 说明对局已结束），不能是普通回合
        expect(['awaiting_pick', 'awaiting_auction', 'awaiting_discard', 'game_over']).toContain(s.phase);
        if (s.phase === 'game_over') break;
        blockedByFlow += 1;
      }
      if (s.phase === 'awaiting_roll') s = applyAction(s, { type: 'ROLL_DICE' });
      else if (s.phase === 'awaiting_action') s = applyAction(s, { type: 'END_TURN' });
      else if (s.phase === 'awaiting_pick') s = applyAction(s, { type: 'MINIGAME_PICK', hole: 0 });
      else if (s.phase === 'awaiting_auction') s = applyAction(s, { type: 'AUCTION_PASS' });
      else if (s.phase === 'awaiting_discard') s = applyAction(s, { type: 'DISCARD_CARD', cardId: s.players[s.currentPlayerIndex]!.cards[0]! });
      else break;
      if (s.phase === 'game_over') break;
    }
    expect(trades).toBeGreaterThan(0);
    // 覆盖多个不同回合 → 不是只在某个特定格型上才行
    expect(tradeTurns.size).toBeGreaterThanOrEqual(3);
    // 至少两位玩家都成功买到过
    expect(perPlayer.size).toBeGreaterThanOrEqual(2);
    // 不交易的原因全部来自强制流程，而非格型限制
    expect(blockedByFlow).toBeLessThan(24);
  });

  it('回合循环后股票波动并产生新闻', () => {
    let g = setupLanding(newGame(123), 5, 4); // p0 落神庙自动过
    g = applyAction(g, { type: 'ROLL_DICE' });
    expect(g.currentPlayerIndex).toBe(1);
    // p1 也走到自动结算格，回合绕回 p0 → round 2
    g.rngState = seedForSum(6);
    g.players[1]!.position = 63; // 63 + 6 = 69 → 越过起点落到 5 号神庙，自动结算
    g = applyAction(g, { type: 'ROLL_DICE' });
    expect(g.currentPlayerIndex).toBe(0);
    expect(g.round).toBe(2);
    expect(g.log.some((e) => e.text.includes('【新闻】'))).toBe(true);
  });
});

describe('M2 资产变卖', () => {
  it('付租金时现金存款不足即破产，**不自动变卖股票**', () => {
    // p1 落到 p0 满级陆家嘴（租金 690），仅有 100 现金 + 10 股科技股(价值1200) + 一处 2 级地产
    // 规则：负债不自动变卖资产，股票只能通过随机事件兑现
    const g = newGame(125);
    g.currentPlayerIndex = 1;
    g.rngState = seedForSum(6);
    g.players[1]!.position = 24; // 24 + 6 = 30
    g.players[0]!.properties = [{ cellId: 30, grade: 3 }];
    g.players[1]!.cash = 100;
    g.players[1]!.stocks = { tech: 10 };
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    pinIndexOne(g);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const p1 = rolled.players[1]!;
    // 现金 100 < 租金 690，存款为 0 → 支付不起 → 破产
    expect(p1.bankrupt).toBe(true);
    // 股票**没有被自动卖掉**（破产清算才清空，与"自动变卖"是两回事）
    expect(rolled.log.some((e) => e.text.includes('无力支付'))).toBe(true);
    expect(rolled.log.some((e) => e.text.includes('变卖 科技股'))).toBe(false);
  });

  it('现金存款恰好够付租金时不破产，股票保持不动', () => {
    const g = newGame(126);
    g.currentPlayerIndex = 1;
    g.rngState = seedForSum(6);
    g.players[1]!.position = 24;
    g.players[0]!.properties = [{ cellId: 30, grade: 3 }];
    g.players[1]!.cash = 1000; // 足够付 690
    g.players[1]!.stocks = { tech: 10 };
    pinIndexOne(g);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const p1 = rolled.players[1]!;
    expect(p1.bankrupt).toBe(false);
    expect(p1.stocks['tech']).toBe(10); // 股票分毫未动
    expect(p1.cash).toBe(1000 - 690);
  });
});



describe('M5 forceGameOver（测试钩子）', () => {
  it('其余玩家破产、指定者获胜，走真实 game_over 流程', () => {
    const g = applyAction(createGame(PLAYERS, 131, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    const finished = forceGameOver(g, 'p2');
    expect(finished.phase).toBe('game_over');
    expect(finished.winnerId).toBe('p2');
    expect(finished.players[0]!.bankrupt).toBe(true);
    expect(finished.players[1]!.bankrupt).toBe(false);
  });
});


describe('M5 确定性回放（ReplayEngine）', () => {
  it('重放动作序列与逐步应用引擎状态完全一致', () => {
    const seed = 2024;
    let state = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    const actions: Array<{ turn: number; action: PlayerAction }> = [
      { turn: state.turn, action: { type: 'START_GAME' } },
    ];
    // 真实动作：掷骰 → 决策或自动流转，再掷一次
    state = applyAction(state, { type: 'ROLL_DICE' });
    actions.push({ turn: state.turn, action: { type: 'ROLL_DICE' } });
    if (state.phase === 'awaiting_action') {
      state = applyAction(state, { type: 'END_TURN' });
      actions.push({ turn: state.turn, action: { type: 'END_TURN' } });
    }
    state = applyAction(state, { type: 'ROLL_DICE' });
    actions.push({ turn: state.turn, action: { type: 'ROLL_DICE' } });

    const engine = new ReplayEngine({
      seed,
      startDate: { ...MONDAY },
      players: PLAYERS.map((p) => ({ player_name: p.name, color: p.color })),
      actions,
    });
    expect(engine.totalSteps).toBe(actions.length - 1);
    const final = engine.finalState;
    expect(final.players.map((p) => [p.position, p.cash, p.properties])).toEqual(
      state.players.map((p) => [p.position, p.cash, p.properties]),
    );
    expect(final.dice).toEqual(state.dice);
    expect(final.rngState).toBe(state.rngState);
    expect(final.phase).toBe(state.phase);
  });

  it('stateAt 支持任意步定位与越界钳制', () => {
    const seed = 7;
    const actions = [
      { turn: 1, action: { type: 'START_GAME' } as PlayerAction },
      { turn: 1, action: { type: 'ROLL_DICE' } as PlayerAction },
    ];
    const engine = new ReplayEngine({ seed, players: PLAYERS.map((p) => ({ player_name: p.name, color: p.color })), actions });
    expect(engine.totalSteps).toBe(1);
    expect(engine.stateAt(-5).phase).toBe('awaiting_roll');
    expect(engine.stateAt(0).turn).toBe(1);
    expect(engine.stateAt(99).turn).toBe(engine.finalState.turn);
  });
});



describe('M6 移动系统（路障/转向/乌龟）', () => {
  it('路障道具：他人经过被截停且路障消失', () => {
    const g = setupLanding(newGame(201), 4, 3); // p0 落到无主成都路 → 决策阶段
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    rolled.players[0]!.items = { roadblock: 1 };
    const used = applyAction(rolled, { type: 'USE_ITEM', itemId: 'roadblock', cellId: 4 });
    expect(used.roadblocks).toEqual([4]);
    // 放置路障不消耗回合，仍需显式结束回合
    const ended = applyAction(used, { type: 'END_TURN' });
    expect(ended.currentPlayerIndex).toBe(1);

    // p2 从 0 出发掷 6 点，途中经过 4 号路障 → 停在 4
    ended.rngState = seedForSum(6);
    ended.players[1]!.position = 0;
    const rolled2 = applyAction(ended, { type: 'ROLL_DICE' });
    expect(rolled2.players[1]!.position).toBe(4);
    expect(rolled2.roadblocks).toEqual([]);
    expect(rolled2.log.some((e) => e.text.includes('撞上路障'))).toBe(true);
  });

  it('转向卡：方向反转后向反方向移动', () => {
    const g = newGame(203);
    g.players[0]!.cards = ['turnaround'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'turnaround' });
    expect(used.players[0]!.direction).toBe(-1);
    used.rngState = seedForSum(3);
    used.players[0]!.position = 10;
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe(7); // 10 - 3
  });

  it('乌龟卡：所有人 3 天内一次只走一步', () => {
    const g = newGame(205);
    g.players[0]!.cards = ['turtle'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'turtle' });
    expect(used.players[0]!.turtleTurns).toBe(3);
    expect(used.players[1]!.turtleTurns).toBe(3);

    // 切到 p2 掷骰：总和 7 → 实际只走 1 步，落到 11 号机会格
    used.rngState = seedForSum(7);
    used.currentPlayerIndex = 1;
    used.players[1]!.position = 10;
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.position).toBe(11);
  });
});

describe('M6 新卡片', () => {
  it('查封卡：整条街 5 天内免收过路费', () => {
    const g = setupLanding(newGame(209), 6, 3); // p0 即将落到 p1 的 6 号南京路（2 级，租金 260）
    g.players[0]!.cards = ['seal-rent'];
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    // 掷骰前使用查封卡，锁定 6 号所在路段
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'seal-rent', cellId: 6 });
    expect(used.rentEffects).toHaveLength(1);
    expect(used.rentEffects[0]!.cells).toContain(6);
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBe(15000); // 租金被查封免除
    expect(rolled.log.some((e) => e.text.includes('查封'))).toBe(true);
  });

  it('送神卡：送走附身神明', () => {
    const g = newGame(211);
    g.players[0]!.cards = ['send-god'];
    g.players[0]!.god = { godId: 'small-poverty', remainingDays: 3 };
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'send-god' });
    expect(used.players[0]!.god).toBeNull();
  });
});

describe('M6 神明对偶转化（GOD-02..11）', () => {
  it('大福神期满对偶转化为小福神', () => {
    const g = setupLanding(newGame(213), 62, 6); // p0 落到公司格（占位安全格）
    g.players[0]!.god = { godId: 'big-fortune', remainingDays: 1 };
    const after0 = applyAction(g, { type: 'ROLL_DICE' });
    // p0 自己的回合尚未跨天，计时不变
    expect(after0.players[0]!.god).toEqual({ godId: 'big-fortune', remainingDays: 1 });
    // 推到跨日 → 日切 → 期满转化为小福神（重置为 7 天）
    const after1 = advanceOneDay(after0);
    expect(after1.players[0]!.god?.godId).toBe('small-fortune');
    expect(after1.players[0]!.god?.remainingDays).toBe(GOD_DURATION_DAYS);
  });
});


/** 找第 n 个"两骰之和为 target"的种子 */
function nthSeedForSum(target: number, n: number): number {
  let found = 0;
  for (let seed = 1; seed <= 500000; seed++) {
    const a = rollDie(seed);
    const b = rollDie(a.nextState);
    if (a.value + b.value === target) {
      found += 1;
      if (found === n) return seed;
    }
  }
  throw new Error('找不到种子');
}

/** 落地游戏厅，扫描不同骰子种子直到随机到三仙归洞 */
function landingShells(seedBase: number): GameState {
  for (let k = 1; k < 40; k++) {
    const g = newGame(seedBase);
    g.rngState = nthSeedForSum(5, k);
    g.players[g.currentPlayerIndex]!.position = 12; // 12 + 5 = 17
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    if (rolled.minigame?.kind === 'shells') return rolled;
  }
  throw new Error('找不到三仙归洞种子');
}

describe('M7 小游戏：三仙归洞', () => {
  it('落地游戏厅进入猜杯阶段', () => {
    const rolled = landingShells(301);
    expect(rolled.phase).toBe('awaiting_pick');
    expect(rolled.minigame?.kind).toBe('shells');
    expect(rolled.minigame?.round).toBe(0);
    expect(availableActions(rolled).canPick).toBe(true);
  });

  it('三轮猜杯按确定性 RNG 结算奖励并回到正常流程', () => {
    const rolled = landingShells(303);
    const before = rolled.players[0]!.cash;

    // 与引擎同步推演球的位置
    let cur = rolled;
    const hits: boolean[] = [];
    for (let round = 0; round < 3; round++) {
      // 引擎用确定性 RNG 定球：同步观察命中记录
      cur = applyAction(cur, { type: 'MINIGAME_PICK', hole: 0 });
      hits.push(hitsOf(cur));
    }
    function hitsOf(s: GameState): boolean {
      return (s.log.at(-1)?.text ?? '').includes('猜中');
    }
    const hitsCount = hits.filter(Boolean).length;
    const payoutTable = [-200, 100, 500, 1200];
    const payout = payoutTable[hitsCount]!;
    expect(cur.minigame).toBeNull();
    expect(cur.phase).toBe('awaiting_roll');
    expect(cur.currentPlayerIndex).toBe(1);
    if (payout >= 0) {
      expect(cur.players[0]!.cash).toBe(before + payout);
    } else {
      expect(cur.players[0]!.cash).toBe(before + payout);
    }
  });

  it('非法杯号被拒绝', () => {
    const rolled = landingShells(305);
    expect(() => applyAction(rolled, { type: 'MINIGAME_PICK', hole: 5 as 0 | 1 | 2 })).toThrow('杯号必须是 0-2');
  });

  it('非猜杯阶段不能猜', () => {
    const g = newGame(307);
    expect(() => applyAction(g, { type: 'MINIGAME_PICK', hole: 0 })).toThrow('当前没有进行中的小游戏');
  });
});


describe('M8 新闻事件扩充', () => {
  it('多轮循环内会触发玩家新闻（确定性种子扫描）', () => {
    // 扫描种子：找到 12 轮内出现玩家事件的种子，保证断言确定性
    let chosen: GameState | null = null;
    for (let seed = 1; seed <= 300 && !chosen; seed++) {
      let g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
      // 双方自动掷骰推进 12 轮（落地游戏厅/决策时结束回合）
      for (let i = 0; i < 120 && g.round <= 12 && g.phase !== 'game_over'; i++) {
        if (g.phase === 'awaiting_action') {
          g = applyAction(g, { type: 'END_TURN' });
        } else if (g.phase === 'awaiting_pick') {
          g = applyAction(g, { type: 'MINIGAME_PICK', hole: 0 });
        } else if (g.phase === 'awaiting_roll') {
          g = applyAction(g, { type: 'ROLL_DICE' });
        } else break;
      }
      if (g.log.some((e) => e.text.startsWith('【新闻】') && !e.text.includes('股'))) {
        chosen = g;
      }
    }
    expect(chosen).not.toBeNull();
    const newsTexts = chosen!.log.filter((e) => e.text.startsWith('【新闻】')).map((e) => e.text);
    expect(newsTexts.some((t) => t.includes('所得税') || t.includes('有奖竞猜') || t.includes('蓝屏') || t.includes('加息'))).toBe(true);
  });
});



describe('M10 小游戏：记忆翻牌', () => {
  it('落地游戏厅可随机到记忆翻牌（8 张牌 4 对）', () => {
    let found: GameState | null = null;
    for (let k = 1; k < 80 && !found; k++) {
      const g = newGame(401);
      g.rngState = nthSeedForSum(5, k);
      g.players[g.currentPlayerIndex]!.position = 12; // 12 + 5 = 17 游戏厅
      const rolled = applyAction(g, { type: 'ROLL_DICE' });
      if (rolled.minigame?.kind === 'memory') found = rolled;
    }
    expect(found).not.toBeNull();
    const mg = found!.minigame!;
    expect(mg.symbols).toHaveLength(8);
    expect(mg.symbols.slice().sort()).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(mg.flips).toBe(0);
  });

  it('翻牌配对与不配对逻辑正确（确定性种子直推）', () => {
    // 用受控状态直接构造：symbols 已知
    const g = applyAction(createGame(PLAYERS, 421, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    g.players[0]!.position = 17;
    g.phase = 'awaiting_pick';
    g.minigame = {
      kind: 'memory',
      round: 0,
      hits: [],
      symbols: [0, 0, 1, 1, 2, 2, 3, 3],
      revealed: [],
      matched: Array(8).fill(false),
      flips: 0,
    };
    // 翻 0、1 → 配对
    let cur = applyAction(g, { type: 'MINIGAME_PICK', hole: 0 });
    cur = applyAction(cur, { type: 'MINIGAME_PICK', hole: 1 });
    expect(cur.minigame!.matched[0]).toBe(true);
    expect(cur.minigame!.matched[1]).toBe(true);
    expect(cur.minigame!.revealed).toEqual([]);
    // 翻 2、4 → 不配对（1 vs 2）
    cur = applyAction(cur, { type: 'MINIGAME_PICK', hole: 2 });
    cur = applyAction(cur, { type: 'MINIGAME_PICK', hole: 4 });
    expect(cur.minigame!.revealed).toEqual([]);
    expect(cur.minigame!.matched[2]).toBe(false);
    expect(cur.minigame!.flips).toBe(4); // 每次翻牌计 1 次
  });

  it('全部配对立即结算，奖励 = 对数×500 − 翻牌×100', () => {
    const g = applyAction(createGame(PLAYERS, 423, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    g.players[0]!.position = 17;
    g.phase = 'awaiting_pick';
    g.minigame = {
      kind: 'memory',
      round: 0,
      hits: [],
      symbols: [0, 0, 1, 1, 2, 2, 3, 3],
      revealed: [],
      matched: Array(8).fill(false),
      flips: 0,
    };
    const before = g.players[0]!.cash;
    let cur = g;
    // 完美配对顺序：4 对，8 次翻牌
    const pairs: Array<[number, number]> = [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ];
    for (const [a, b] of pairs) {
      cur = applyAction(cur, { type: 'MINIGAME_PICK', hole: a as 0 | 1 | 2 });
      cur = applyAction(cur, { type: 'MINIGAME_PICK', hole: b as 0 | 1 | 2 });
    }
    expect(cur.minigame).toBeNull();
    expect(cur.phase).toBe('awaiting_roll');
    const payout = 4 * 500 - 8 * 100; // 1200
    expect(cur.players[0]!.cash).toBe(before + payout);
  });

  it('翻牌次数用尽（8 次）强制结算', () => {
    const g = applyAction(createGame(PLAYERS, 425, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    g.players[0]!.position = 17;
    g.phase = 'awaiting_pick';
    g.minigame = {
      kind: 'memory',
      round: 0,
      hits: [],
      // 故意让 0/7、1/6、2/5、3/4 都不成对：symbols 两两错开
      symbols: [0, 1, 2, 3, 1, 0, 3, 2],
      revealed: [],
      matched: Array(8).fill(false),
      flips: 6, // 只剩 2 次机会
    };
    // 翻 0(0) 和 4(1) → 不配对 → flips=8 → 强制结算
    let cur = applyAction(g, { type: 'MINIGAME_PICK', hole: 0 });
    cur = applyAction(cur, { type: 'MINIGAME_PICK', hole: 4 });
    expect(cur.minigame).toBeNull();
    expect(cur.phase).toBe('awaiting_roll');
  });
});


describe('空房间健壮性（回归：联机大厅最后一人离开后崩溃）', () => {
  it('移除最后一位玩家后 availableActions 不抛错', () => {
    let g = createGame([PLAYERS[0]!], 5, { startDate: { ...MONDAY } });
    g = removePlayer(g, PLAYERS[0]!.id);
    expect(g.players).toHaveLength(0);
    expect(g.currentPlayerIndex).toBe(0);
    // 关键：曾因currentPlayer 越界抛「当前玩家不存在」而导致联机失败
    const acts = availableActions(g);
    expect(acts.canRoll).toBe(false);
    expect(acts.canBuy).toBe(false);
    expect(acts.canTradeStock).toBe(false);
    expect(acts.bailableVillains).toEqual([]);
    expect(acts.dischargeablePatients).toEqual([]);
    expect(acts.tradableAssets).toEqual([]);
    expect(acts.tradeCash).toBe(0);
  });

  it('非首位玩家离开后 currentPlayerIndex 正确前移', () => {
    const three = [...PLAYERS, { id: 'p3', name: '老王', color: 0x66bb6a }];
    let g = createGame(three, 7, { startDate: { ...MONDAY } });
    g.currentPlayerIndex = 2;
    g = removePlayer(g, 'p1'); // 移除 idx 0
    expect(g.players.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(g.currentPlayerIndex).toBe(1); // 2 -> 1
    expect(g.players[g.currentPlayerIndex]!.id).toBe('p3');
  });

  it('移除末位玩家后 currentPlayerIndex 夹到有效范围', () => {
    const three = [...PLAYERS, { id: 'p3', name: '老王', color: 0x66bb6a }];
    let g = createGame(three, 9, { startDate: { ...MONDAY } });
    g.currentPlayerIndex = 2;
    g = removePlayer(g, 'p3'); // 移除 idx 2（末位）
    expect(g.currentPlayerIndex).toBe(1);
    expect(g.players[g.currentPlayerIndex]).toBeDefined();
  });

  it('多人依次离开直至空房间，始终不抛错', () => {
    let g = createGame(PLAYERS, 11, { startDate: { ...MONDAY } });
    for (const def of [...PLAYERS]) {
      g = removePlayer(g, def.id);
      expect(() => availableActions(g)).not.toThrow();
    }
    expect(g.players).toHaveLength(0);
  });

  it('空房间的 GameState 可被客户端正常读取（面板不崩）', () => {
    let g = createGame(PLAYERS, 13, { startDate: { ...MONDAY } });
    for (const def of [...PLAYERS]) g = removePlayer(g, def.id);
    // gameDate / priceIndex 等只读函数在空房间下也应安全
    expect(() => gameDate(g)).not.toThrow();
    expect(() => priceIndex(g)).not.toThrow();
    expect(allAssetSummaries(g)).toEqual([]);
    expect(allStockSummaries(g)).toEqual([]);
  });
});
