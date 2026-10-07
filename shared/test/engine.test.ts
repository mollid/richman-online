import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, availableActions, createGame, forceGameOver, removePlayer, rentOf, rollDie, upgradeCost } from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
];

function newGame(seed = 42): GameState {
  return applyAction(createGame(PLAYERS, seed), { type: 'START_GAME' });
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
  s.players[s.currentPlayerIndex]!.position = (targetCell - sum + 40) % 40;
  return s;
}

describe('createGame', () => {
  it('初始状态正确', () => {
    const g = createGame(PLAYERS, 1);
    expect(g.phase).toBe('lobby');
    expect(g.players).toHaveLength(2);
    expect(g.players[0]!.cash).toBe(15000);
    expect(g.players[0]!.position).toBe(0);
    expect(g.board).toHaveLength(40);
  });

  it('人数不合法时报错', () => {
    expect(() => createGame([...PLAYERS, ...PLAYERS, ...PLAYERS.slice(0, 1)])).toThrow();
    const one = createGame([PLAYERS[0]!]);
    expect(() => applyAction(one, { type: 'START_GAME' })).toThrow('至少需要 2 名玩家');
  });

  it('支持房间阶段加入/移除玩家', () => {
    let g = createGame([], 9);
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
    const [d1, d2] = rolled.dice!;
    expect(rolled.players[0]!.position).toBe((d1 + d2) % 40);
    expect(g.players[0]!.position).toBe(0); // 纯函数：原状态未被修改
  });

  it('经过起点领取薪水', () => {
    const s = seedForSum(5);
    const g = newGame(99);
    g.rngState = s;
    g.players[0]!.position = 38; // 38 + 5 = 43 → 越过起点落到 3（机会格）
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBeGreaterThanOrEqual(15000 + 2000 - 1000);
    expect(rolled.players[0]!.cash).toBeLessThanOrEqual(15000 + 2000 + 1000);
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
    g.rngState = seedForSum(3);
    g.players[1]!.position = 3; // 3 + 3 = 6，不经过起点
    g.players[0]!.properties = [{ cellId: 6, grade: 2 }];
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.cash).toBe(15000 - 260);
    expect(rolled.players[0]!.cash).toBe(15000 + 260);
    expect(rentOf(130, 2)).toBe(260);
  });

  it('付不起租金则破产，对手获胜', () => {
    const g = setupLanding(newGame(31), 6, 6);
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
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(upgradeCost(780, 1)).toBe(468);
    const upgraded = applyAction(rolled, { type: 'UPGRADE_LAND' });
    expect(upgraded.players[0]!.properties[0]).toEqual({ cellId: 22, grade: 2 });
    expect(upgraded.players[0]!.cash).toBe(10000 - 468);
  });

  it('满级地产不可升级', () => {
    const g = setupLanding(newGame(5), 1, 5);
    g.players[0]!.properties = [{ cellId: 1, grade: 3 }];
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

  it('落地监狱暂停两回合', () => {
    const g = setupLanding(newGame(17), 26, 8);
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.skipTurns).toBe(2);
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




describe('M2 卡片系统', () => {
  it('机会格抽到卡片', () => {
    const g = setupLanding(newGame(101), 3, 5); // 落到 3 号机会格
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cards).toHaveLength(1);
    expect(rolled.log.some((e) => e.text.includes('抽到卡片'))).toBe(true);
  });

  it('商店可购买卡片并扣款', () => {
    const g = setupLanding(newGame(103), 2, 2); // 落到 2 号商店（从 0 号出发，不绕起点）
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(availableActions(rolled).canShop).toBe(true);
    const bought = applyAction(rolled, { type: 'BUY_CARD', cardId: 'demolish' });
    expect(bought.players[0]!.cards).toContain('demolish');
    expect(bought.players[0]!.cash).toBe(15000 - 1200);
  });

  it('遥控骰子固定第一颗骰子点数', () => {
    // 固定 6 点后，随机第二骰为 2 或 4 时总点数 8/10 会落在地产格（保持决策阶段）
    const g = newGame(seedForFirstDie([2, 4]));
    g.players[0]!.cards = ['remote-dice'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'remote-dice', diceValue: 6 });
    expect(used.pendingFixedDice).toBe(6);
    expect(used.players[0]!.cards).toHaveLength(0);
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.dice![0]).toBe(6);
    expect(rolled.phase).toBe('awaiting_action');
    expect(rolled.pendingFixedDice).toBeNull();
  });

  it('均富卡平均分配现金', () => {
    const g = newGame(107);
    g.players[0]!.cards = ['equalize'];
    g.players[0]!.cash = 20000;
    g.players[1]!.cash = 10000;
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'equalize' });
    expect(used.players[0]!.cash).toBe(15000);
    expect(used.players[1]!.cash).toBe(15000);
  });

  it('拆屋卡降级目标最高地产', () => {
    const g = newGame(109);
    g.players[0]!.cards = ['demolish'];
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'demolish', targetPlayerId: 'p2' });
    expect(used.players[1]!.properties[0]).toEqual({ cellId: 6, grade: 1 });
  });

  it('强占卡夺取脚下地产', () => {
    const g = setupLanding(newGame(111), 6, 3); // 落到 6 号南京路（无主 → 决策阶段）
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    rolled.players[0]!.cards = ['seize'];
    rolled.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    const used = applyAction(rolled, { type: 'USE_CARD', cardId: 'seize' });
    expect(used.players[0]!.properties).toEqual([{ cellId: 6, grade: 2 }]);
    expect(used.players[1]!.properties).toHaveLength(0);
  });

  it('红卡使指定股票上涨 25%', () => {
    const g = newGame(113);
    g.players[0]!.cards = ['red-card'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'red-card', stockId: 'tech' });
    const tech = used.stockMarket.stocks.find((s) => s.id === 'tech')!;
    expect(tech.price).toBe(150); // 120 * 1.25
  });
});

describe('M2 神仙系统', () => {
  it('财神附身每回合发放金钱并递减时长', () => {
    const g = newGame(115);
    g.players[0]!.god = { godId: 'wealth', remainingTurns: 2 };
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBeGreaterThanOrEqual(15000 + 800);
    expect(rolled.players[0]!.god).toEqual({ godId: 'wealth', remainingTurns: 1 });
  });

  it('神庙格召唤随机神仙', () => {
    const g = setupLanding(newGame(117), 5, 4); // 落到 5 号神庙
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.god).not.toBeNull();
    expect(['wealth', 'poverty', 'land']).toContain(rolled.players[0]!.god!.godId);
  });
});

describe('M2 股票系统', () => {
  it('银行格可买卖股票', () => {
    const g = setupLanding(newGame(119), 35, 7); // 落到 35 号银行
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(availableActions(rolled).canTradeStock).toBe(true);

    const bought = applyAction(rolled, { type: 'BUY_STOCK', stockId: 'tech', quantity: 10 });
    expect(bought.players[0]!.cash).toBe(15000 - 120 * 10);
    expect(bought.players[0]!.stocks['tech']).toBe(10);

    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 10 });
    expect(sold.players[0]!.cash).toBe(15000);
    expect(sold.players[0]!.stocks['tech']).toBeUndefined();
  });

  it('不在银行不能交易股票', () => {
    const g = setupLanding(newGame(121), 1, 4); // 落到 1 号地产
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(() => applyAction(rolled, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('不在银行');
  });

  it('回合循环后股票波动并产生新闻', () => {
    let g = setupLanding(newGame(123), 5, 4); // p0 落神庙自动过
    g = applyAction(g, { type: 'ROLL_DICE' });
    expect(g.currentPlayerIndex).toBe(1);
    // p1 也走到自动结算格，回合绕回 p0 → round 2
    g.rngState = seedForSum(6);
    g.players[1]!.position = 39; // 39 + 6 = 45 → 落到 5 号神庙，自动结算
    g = applyAction(g, { type: 'ROLL_DICE' });
    expect(g.currentPlayerIndex).toBe(0);
    expect(g.round).toBe(2);
    expect(g.log.some((e) => e.text.includes('【新闻】'))).toBe(true);
  });
});

describe('M2 资产变卖', () => {
  it('付租金时优先变卖股票而非直接破产', () => {
    // p1 落到 p0 满级陆家嘴（租金 690），仅有 100 现金 + 10 股科技股(价值1200) + 一处 2 级地产
    const g = newGame(125);
    g.currentPlayerIndex = 1;
    g.rngState = seedForSum(6);
    g.players[1]!.position = 24; // 24 + 6 = 30
    g.players[0]!.properties = [{ cellId: 30, grade: 3 }];
    g.players[1]!.cash = 100;
    g.players[1]!.stocks = { tech: 10 };
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const p1 = rolled.players[1]!;
    expect(p1.bankrupt).toBe(false);
    expect(p1.stocks['tech']).toBeUndefined();
    expect(p1.cash).toBe(100 + 1200 - 690); // 卖股后支付租金
    expect(p1.properties[0]!.grade).toBe(2); // 地产未被降级
  });

  it('资产耗尽仍不足则破产', () => {
    const g = newGame(127);
    g.currentPlayerIndex = 1;
    g.rngState = seedForSum(6);
    g.players[1]!.position = 24;
    g.players[0]!.properties = [{ cellId: 30, grade: 3 }];
    g.players[1]!.cash = 100;
    g.players[1]!.properties = [{ cellId: 6, grade: 1 }]; // 变卖仅回收 250
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.bankrupt).toBe(true);
    expect(rolled.winnerId).toBe('p1');
    expect(rolled.log.some((e) => e.text.includes('变卖全部资产'))).toBe(true);
  });
});



describe('M5 forceGameOver（测试钩子）', () => {
  it('其余玩家破产、指定者获胜，走真实 game_over 流程', () => {
    const g = applyAction(createGame(PLAYERS, 131), { type: 'START_GAME' });
    const finished = forceGameOver(g, 'p2');
    expect(finished.phase).toBe('game_over');
    expect(finished.winnerId).toBe('p2');
    expect(finished.players[0]!.bankrupt).toBe(true);
    expect(finished.players[1]!.bankrupt).toBe(false);
  });
});

