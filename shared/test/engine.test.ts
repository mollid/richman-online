import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, availableActions, createGame, forceGameOver, nextRandom, removePlayer, rentOf, ReplayEngine, rollDie, upgradeCost } from '../src/index.js';
import type { GameState, PlayerAction, PlayerDef } from '../src/index.js';

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
    g.rngState = seedForSumQuietNews(3);
    g.players[1]!.position = 3; // 3 + 3 = 6，不经过起点
    g.players[0]!.properties = [{ cellId: 6, grade: 2 }];
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.cash).toBe(15000 - 260);
    expect(rolled.players[0]!.cash).toBe(15000 + 260);
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


describe('M5 确定性回放（ReplayEngine）', () => {
  it('重放动作序列与逐步应用引擎状态完全一致', () => {
    const seed = 2024;
    let state = applyAction(createGame(PLAYERS, seed), { type: 'START_GAME' });
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

    const engine = new ReplayEngine({ seed, players: PLAYERS.map((p) => ({ player_name: p.name, color: p.color })), actions });
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
  it('路障卡：他人经过被截停且路障消失', () => {
    const g = setupLanding(newGame(201), 4, 3); // p0 落到无主成都路 → 决策阶段
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    rolled.players[0]!.cards = ['roadblock'];
    const used = applyAction(rolled, { type: 'USE_CARD', cardId: 'roadblock' });
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

  it('乌龟卡：目标掷骰步数减半', () => {
    const g = newGame(205);
    g.players[0]!.cards = ['turtle'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'turtle', targetPlayerId: 'p2' });
    expect(used.players[1]!.slowTurns).toBe(2);

    // 切到 p2 掷骰：总和 7 → 实际移动 ceil(7/2)=4
    used.rngState = seedForSum(7);
    used.currentPlayerIndex = 1;
    used.players[1]!.position = 10;
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.position).toBe(14);
    expect(rolled.players[1]!.slowTurns).toBe(1);
  });
});

describe('M6 新卡片', () => {
  it('免租卡：落地他人地产时一次租金全免', () => {
    const g = setupLanding(newGame(209), 6, 3); // p0 即将落到 p1 的 6 号南京路（2 级，租金 260）
    g.players[0]!.cards = ['rent-free'];
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    // 先在掷骰前使用免租卡（phase=any，awaiting_roll 可用）
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'rent-free' });
    expect(used.players[0]!.freeRentTurns).toBe(1);
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBe(15000); // 租金 260 被免除
    expect(rolled.players[0]!.freeRentTurns).toBe(0);
    expect(rolled.log.some((e) => e.text.includes('免租卡生效'))).toBe(true);
  });

  it('天使卡：解除停留并送走穷神', () => {
    const g = newGame(211);
    g.players[0]!.cards = ['angel'];
    g.players[0]!.skipTurns = 3;
    g.players[0]!.god = { godId: 'poverty', remainingTurns: 3 };
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'angel' });
    expect(used.players[0]!.skipTurns).toBe(0);
    expect(used.players[0]!.god).toBeNull();
  });
});

describe('M6 福神', () => {
  it('福神每回合发放 200-600 随机红包', () => {
    const g = newGame(213);
    g.players[0]!.god = { godId: 'fortune', remainingTurns: 2 };
    const before = g.players[0]!.cash;
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    const gain = rolled.players[0]!.cash - before - 0;
    expect(gain).toBeGreaterThanOrEqual(200);
    expect(gain).toBeLessThanOrEqual(600);
    expect(rolled.players[0]!.god).toEqual({ godId: 'fortune', remainingTurns: 1 });
  });
});


describe('M7 小游戏：三仙归洞', () => {
  it('落地游戏厅进入猜杯阶段', () => {
    const g = setupLanding(newGame(301), 17, 5); // 17 号游戏厅
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_pick');
    expect(rolled.minigame).toEqual({ round: 0, hits: [] });
    expect(availableActions(rolled).canPick).toBe(true);
  });

  it('三轮猜杯按确定性 RNG 结算奖励并回到正常流程', () => {
    const g = setupLanding(newGame(303), 17, 5);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
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
    const g = setupLanding(newGame(305), 17, 5);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(() => applyAction(rolled, { type: 'MINIGAME_PICK', hole: 5 as 0 | 1 | 2 })).toThrow();
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
      let g = applyAction(createGame(PLAYERS, seed), { type: 'START_GAME' });
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

