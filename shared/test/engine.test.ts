import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, availableActions, createGame, removePlayer, rentOf, rollDie, upgradeCost } from '../src/index.js';
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



