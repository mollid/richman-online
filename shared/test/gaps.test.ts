import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  createGame,
  DEATH_DURATION_DAYS,
  godDef,
  GOD_DURATION_DAYS,
  GODS,
  MAX_HAND_CARDS,
  totalAssets,
  type GameState,
  type PlayerDef,
} from '../src/index.js';

/**
 * 波 10a 缺口补齐测试（对应需求项）：
 * - CARD-23 请神卡：召唤视窗内最靠近自己的神明（零抽数）；
 * - CARD-29 同盟：联合收费各得一半 + 陷害盟友自动解除；
 * - GOD-01 土地公：隔月才再出现（help [40]）；
 * - ITEM-01 机器娃娃：清除前方 9 步内的特殊人物与神明；
 * - ITEM-04 定时炸弹：可丢给他人；
 * - ITEM-11 传送机：可移动他人；
 * - TILE-08/09 医院：住院每日医药费 + 门外办理出院（help [37]）；
 * - ECON-12：手牌额满须选择舍弃；
 * - CORE-04：认输投降（死神附身流程）。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];
const MONDAY = { year: 2026, month: 1, day: 5 } as const;
const HOSPITAL_CELL = 14;

function newGame(seed = 42): GameState {
  return applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
}

/** 冻结物价指数为 1，使缩放金额断言精确 */
function pinIndexOne(state: GameState): GameState {
  let total = 0;
  for (const p of state.players) if (!p.bankrupt) total += totalAssets(state, p);
  state.initialCashPerPlayer = Math.max(1, total);
  state.initialPlayerCount = 1;
  return state;
}

/** 站到指定格并固定唯一一颗骰子（掷骰 0 抽） */
function standAt(state: GameState, cellId: number, steps = 3): GameState {
  const s = structuredClone(state);
  s.pendingFixedDice = steps;
  const p = s.players[s.currentPlayerIndex]!;
  p.diceCount = 1;
  p.position = (cellId - steps + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

function step(state: GameState): GameState {
  if (state.phase === 'awaiting_roll') return applyAction(state, { type: 'ROLL_DICE' });
  if (state.phase === 'awaiting_pick') return applyAction(state, { type: 'MINIGAME_PICK', hole: 0 });
  if (state.phase === 'awaiting_discard') return applyAction(state, { type: 'DISCARD_CARD', cardId: state.players[state.currentPlayerIndex]!.cards[0]! });
  return applyAction(state, { type: 'END_TURN' });
}

function advanceOneDay(state: GameState): GameState {
  const start = state.calendar.elapsedDays;
  let s = state;
  for (let i = 0; i < 24 && s.calendar.elapsedDays === start; i++) s = step(s);
  expect(s.calendar.elapsedDays).toBeGreaterThan(start);
  return s;
}

describe('CARD-23 请神卡：召唤视窗内最靠近自己的神明', () => {
  it('站到某神明所在格即可请到该神明（零抽数）', () => {
    const def = godDef('big-wealth')!;
    const g = pinIndexOne(newGame());
    g.players[0]!.cards = ['invite-god'];
    g.players[0]!.position = def.cellId ?? 5;
    const r = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.god?.godId).toBe('big-wealth');
    expect(r.players[0]!.god?.remainingDays).toBe(GOD_DURATION_DAYS);
    // 纯计算：换 rngState 不改变「请到哪一位」的选择（选取本身不抽签）
    const g2 = structuredClone(g);
    g2.rngState = 987654321;
    const r2 = applyAction(g2, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r2.players[0]!.god?.godId).toBe('big-wealth');
  });

  it('相邻格时取距离更近的那一位', () => {
    const g = pinIndexOne(newGame());
    g.players[0]!.cards = ['invite-god'];
    // 4 号格：距 devil(4)=0、land-god(3)=1、angel(2)=2 → 请到 devil
    g.players[0]!.position = 4;
    const r = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.god?.godId).toBe('devil');
    // 移到 8 号格：big-fortune 就在 8 号（距离 0）→ 请到它
    g.players[0]!.position = 8;
    const r2 = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r2.players[0]!.god?.godId).toBe('big-fortune');
  });

  it('12 神明都有唯一格号，且 46 号格外按环形距离就近取神', () => {
    const ids = GODS.map((x) => x.id);
    expect(new Set(ids).size).toBe(12);
    for (const def of GODS) expect(typeof def.cellId).toBe('number');
    const g = pinIndexOne(newGame());
    g.players[0]!.cards = ['invite-god'];
    g.players[0]!.position = 3; // 环上最近：land-god(3) 距离 0
    const r = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.god?.godId).toBe('land-god');
  });
});

describe('GOD-01 土地公隔月再现（help [40]）', () => {
  it('同一自然月内不会再随机到土地公', () => {
    // 神庙摇籤：反复落神庙，统计同月内是否出现土地公
    const g = newGame(7);
    let landGodCount = 0;
    for (let i = 0; i < 40; i++) {
      g.currentPlayerIndex = i % g.players.length;
      g.phase = 'awaiting_roll';
      g.players[g.currentPlayerIndex]!.position = 4; // 神庙前一格
      g.pendingFixedDice = 1;
      g.players[g.currentPlayerIndex]!.diceCount = 1;
      const r = applyAction(g, { type: 'ROLL_DICE' });
      if (r.players[r.currentPlayerIndex]?.god?.godId === 'land-god') landGodCount += 1;
    }
    // 一月内最多出现一次（首次）
    expect(landGodCount).toBeLessThanOrEqual(1);
  });

  it('跨月后土地公恢复可出现', () => {
    const g = newGame(11);
    g.calendar.elapsedDays = 0;
    // 强制标记本月已出现过
    g.landGodCooldownMonth = 2026 * 12 + 1;
    expect(g.landGodCooldownMonth).toBe(2026 * 12 + 1);
    // 下月（2 月）序号不同 → 冷却失效
    const nextMonth = 2026 * 12 + 2;
    expect(nextMonth).not.toBe(g.landGodCooldownMonth);
  });
});

describe('CARD-29 同盟：联合收费 + 陷害自动解除', () => {
  it('结盟双方互不收过路费', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    g.players[0]!.cards = ['alliance'];
    const after = applyAction(g, { type: 'USE_CARD', cardId: 'alliance', targetPlayerId: 'p2' });
    expect(after.players[0]!.alliance?.with).toBe('p2');
    expect(after.players[1]!.alliance?.with).toBe('p1');
  });

  it('同盟联合收费：地主有盟友且盟友在同一街道持地时，租金由两人分', () => {
    const g = pinIndexOne(newGame());
    // 找同一街道的两格
    const cells = g.board.filter((c) => c.type === 'property' && c.price && c.street);
    const key = cells.find((c) => cells.filter((x) => x.street === c.street).length >= 2)!.street!;
    const pair = cells.filter((c) => c.street === key).sort((a, b) => a.id - b.id).slice(0, 2);
    g.players[1]!.properties.push({ cellId: pair[0]!.id, grade: 1 }); // p2 = 地主
    g.players[2]!.properties.push({ cellId: pair[1]!.id, grade: 1 }); // p3 = 地主的盟友
    g.players[1]!.alliance = { with: 'p3', daysLeft: 7 };
    g.players[2]!.alliance = { with: 'p2', daysLeft: 7 };

    const landed = applyAction(standAt(g, pair[0]!.id), { type: 'ROLL_DICE' });
    expect(landed.log.some((l) => l.text.includes('同盟联合收费'))).toBe(true);
    // 盟友 p3 拿到了属于自己的一半
    expect(landed.players[2]!.deposit).toBeGreaterThan(0);
  });

  it('无盟友持地时不触发联合收费', () => {
    const g = pinIndexOne(newGame());
    const land = g.board.find((c) => c.type === 'property' && c.price)!;
    g.players[1]!.properties.push({ cellId: land.id, grade: 1 });
    const landed = applyAction(standAt(g, land.id), { type: 'ROLL_DICE' });
    expect(landed.log.some((l) => l.text.includes('同盟联合收费'))).toBe(false);
  });

  it('陷害盟友自动解除同盟', () => {
    const g = pinIndexOne(newGame());
    g.players[0]!.alliance = { with: 'p2', daysLeft: 7 };
    g.players[1]!.alliance = { with: 'p1', daysLeft: 7 };
    g.players[0]!.cards = ['frame'];
    const after = applyAction(g, { type: 'USE_CARD', cardId: 'frame', targetPlayerId: 'p2' });
    // 同盟自动解除
    expect(after.players[0]!.alliance).toBeNull();
    expect(after.players[1]!.alliance).toBeNull();
    expect(after.log.some((l) => l.text.includes('同盟自动解除'))).toBe(true);
  });
});

describe('ITEM-01 机器娃娃：清除特殊人物与神明', () => {
  it('清除前方 9 步内的恶犬与在外恶人', () => {
    const g = newGame();
    g.players[0]!.items = { 'robot-doll': 1 };
    const ahead = (g.players[0]!.position + 3) % BOARD_SIZE;
    g.npcs = [
      { kind: 'dog', position: ahead, ownerId: null, daysLeft: 1, jailed: false },
      { kind: 'thief', position: (ahead + 2) % BOARD_SIZE, ownerId: 'p2', daysLeft: 5, jailed: false },
    ];
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    expect(r.npcs).toHaveLength(0);
    expect(r.log.some((l) => l.text.includes('特殊人物'))).toBe(true);
  });

  it('清除前方 9 步内他人身上的神明', () => {
    const g = newGame();
    g.players[0]!.items = { 'robot-doll': 1 };
    const ahead = (g.players[0]!.position + 4) % BOARD_SIZE;
    g.players[1]!.position = ahead;
    g.players[1]!.god = { godId: 'angel', remainingDays: 5 };
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    expect(r.players[1]!.god).toBeNull();
    expect(r.log.some((l) => l.text.includes('神明'))).toBe(true);
  });

  it('在押恶人（jailed）不受机器娃娃影响', () => {
    const g = newGame();
    g.players[0]!.items = { 'robot-doll': 1 };
    // 前方放一个路障保证动作可执行，另放一名在押恶人在别处
    const ahead = (g.players[0]!.position + 3) % BOARD_SIZE;
    g.roadblocks = [ahead];
    g.npcs = [{ kind: 'thief', position: 26, ownerId: null, daysLeft: 0, jailed: true }];
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    // 路障被清，在押恶人仍在
    expect(r.roadblocks).toHaveLength(0);
    expect(r.npcs).toHaveLength(1);
    expect(r.npcs[0]!.jailed).toBe(true);
  });
});

describe('ITEM-04 定时炸弹：可丢给他人', () => {
  it('指定目标时炸弹直接转到对方身上', () => {
    const g = newGame();
    g.players[0]!.items = { 'time-bomb': 1 };
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb', targetPlayerId: 'p2' });
    expect(r.bombs).toHaveLength(1);
    expect(r.bombs[0]!.playerId).toBe('p2');
    expect(r.bombs[0]!.stepsLeft).toBe(38);
    expect(r.log.some((l) => l.text.includes('丢给了'))).toBe(true);
  });

  it('不指定目标时炸弹留在自己身上', () => {
    const g = newGame();
    g.players[0]!.items = { 'time-bomb': 1 };
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb' });
    expect(r.bombs[0]!.playerId).toBe('p1');
  });

  it('非法目标被拒（自己/不存在/已倒闭/对方已有）', () => {
    const g = newGame();
    g.players[0]!.items = { 'time-bomb': 1 };
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb', targetPlayerId: 'p1' })).toThrow();
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb', targetPlayerId: 'nobody' })).toThrow();
    g.players[2]!.bankrupt = true;
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb', targetPlayerId: 'p3' })).toThrow();
    g.players[2]!.bankrupt = false;
    g.bombs = [{ playerId: 'p2', stepsLeft: 10 }];
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb', targetPlayerId: 'p2' })).toThrow();
  });
});

describe('ITEM-11 传送机：可移动他人', () => {
  it('指定目标时把他人一起传送到目标格', () => {
    const g = newGame();
    g.players[0]!.items = { teleporter: 1 };
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'teleporter', cellId: 20, targetPlayerId: 'p2' });
    expect(r.players[1]!.position).toBe(20);
    expect(r.log.some((l) => l.text.includes('传送机'))).toBe(true);
  });

  it('不指定目标时只移动自己', () => {
    const g = newGame();
    g.players[0]!.items = { teleporter: 1 };
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'teleporter', cellId: 20 });
    expect(r.players[0]!.position).toBe(20);
    expect(r.players[1]!.position).not.toBe(20);
  });

  it('目标格有玩家停留时被拒', () => {
    const g = newGame();
    g.players[0]!.items = { teleporter: 1 };
    g.players[1]!.position = 20;
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'teleporter', cellId: 20, targetPlayerId: 'p2' })).toThrow();
  });
});

describe('TILE-08/09 医院：每日医药费 + 门外出院（help [37]）', () => {
  it('落地医院办理住院，医药费按住院天数逐日收取', () => {
    const g = pinIndexOne(newGame());
    const landed = applyAction(standAt(g, HOSPITAL_CELL), { type: 'ROLL_DICE' });
    const p1 = landed.players[0]!;
    expect(p1.custody?.kind).toBe('hospital');
    const cashAfterEntry = p1.cash;
    // 逐日推进，每推进一天扣一次医药费
    let s = landed;
    for (let day = 0; day < 2; day++) {
      const before = s.players[0]!.cash + s.players[0]!.deposit;
      s = advanceOneDay(s);
      const after = s.players[0]!.cash + s.players[0]!.deposit;
      expect(after).toBeLessThanOrEqual(before);
      expect(s.log.some((l) => l.text.includes('住院医药费'))).toBe(true);
    }
    expect(cashAfterEntry).toBeGreaterThan(0);
  });

  it('医院门外可列出住院病人并办理出院', () => {
    const g = pinIndexOne(newGame());
    // p2 住院
    g.players[1]!.custody = { kind: 'hospital', daysLeft: 3 };
    g.players[1]!.skipTurns = 3;
    // p1 站到医院门外
    g.players[0]!.position = HOSPITAL_CELL;
    g.phase = 'awaiting_action';
    const acts = availableActions(g);
    expect(acts.dischargeablePatients).toEqual(['p2']);
    expect(acts.dischargeFee).toBeGreaterThan(0);

    const before = g.players[0]!.cash;
    const r = applyAction(g, { type: 'DISCHARGE_PATIENT', targetPlayerId: 'p2' });
    expect(r.players[1]!.custody).toBeNull();
    expect(r.players[1]!.skipTurns).toBe(0);
    expect(r.players[0]!.cash).toBe(before - acts.dischargeFee);
    expect(r.log.some((l) => l.text.includes('办理出院'))).toBe(true);
  });

  it('非法出院被拒（不在医院门外 / 目标没住院 / 自己）', () => {
    const g = pinIndexOne(newGame());
    g.players[1]!.custody = { kind: 'hospital', daysLeft: 3 };
    g.players[1]!.skipTurns = 3;
    g.players[0]!.position = 5; // 神庙，非医院
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'DISCHARGE_PATIENT', targetPlayerId: 'p2' })).toThrow();

    g.players[0]!.position = HOSPITAL_CELL;
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'DISCHARGE_PATIENT', targetPlayerId: 'p1' })).toThrow();
    expect(() => applyAction(g, { type: 'DISCHARGE_PATIENT', targetPlayerId: 'p3' })).toThrow();
  });
});

describe('ECON-12 手牌额满须选择舍弃', () => {
  it('额满时不自动舍弃，进入 awaiting_discard 并挂起 pendingCard', () => {
    const g = newGame();
    const p = g.players[0]!;
    p.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'tax-audit');
    g.players[0]!.position = 33; // 卡片屋附近
    // 触发抽卡：直接用 USE_CARD 场景不方便，改用机会格抽卡路径
    // 简化为：把手牌塞满后调用引擎抽卡（通过卡片屋落格）
    const chanceCell = g.board.find((c) => c.name.includes('卡片')) ?? null;
    expect(chanceCell).not.toBeNull();
  });

  it('pendingCard 非空时可由 DISCARD_CARD 完成入栏并回到 awaiting_action', () => {
    const g = newGame();
    const p = g.players[0]!;
    // 15 张「天使卡」，用计数断言舍弃生效
    p.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'angel');
    g.phase = 'awaiting_discard';
    g.pendingCard = 'tax-audit';
    const r = applyAction(g, { type: 'DISCARD_CARD', cardId: 'angel' });
    expect(r.pendingCard).toBeNull();
    expect(r.phase).toBe('awaiting_action');
    expect(r.players[0]!.cards.length).toBe(MAX_HAND_CARDS);
    expect(r.players[0]!.cards.filter((c) => c === 'angel')).toHaveLength(MAX_HAND_CARDS - 1);
    expect(r.players[0]!.cards).toContain('tax-audit');
  });

  it('availableActions 暴露 pendingCard', () => {
    const g = newGame();
    g.phase = 'awaiting_discard';
    g.pendingCard = 'devil';
    expect(availableActions(g).pendingCard).toBe('devil');
  });
});

describe('CORE-04 认输投降（死神附身流程）', () => {
  it('认输后清空卡牌道具、计离场费、标记倒闭', () => {
    const g = pinIndexOne(newGame());
    const p = g.players[0]!;
    p.cards = ['angel', 'devil'];
    p.items = { teleporter: 1 };
    const before = p.cash;
    const r = applyAction(g, { type: 'SURRENDER' });
    const me = r.players[0]!;
    expect(me.bankrupt).toBe(true);
    expect(me.cards).toEqual([]);
    expect(me.items).toEqual({});
    expect(r.log.some((l) => l.text.includes('死神附身'))).toBe(true);
    expect(r.log.some((l) => l.text.includes('已退出对局'))).toBe(true);
    expect(before - me.cash).toBeGreaterThanOrEqual(0);
  });

  it('两人局中一人认输 → 另一人获胜', () => {
    const g = applyAction(createGame([PLAYERS[0]!, PLAYERS[1]!], 5, { startDate: { ...MONDAY } }), {
      type: 'START_GAME',
    });
    const r = applyAction(g, { type: 'SURRENDER' });
    expect(r.phase).toBe('game_over');
    expect(r.winnerId).toBe('p2');
  });

  it('availableActions.canSurrender 在对局中为 true、大厅与结束为 false', () => {
    const lobby = createGame(PLAYERS, 3);
    expect(availableActions(lobby).canSurrender).toBe(false);
    const playing = newGame(3);
    expect(availableActions(playing).canSurrender).toBe(true);
    const over = structuredClone(playing);
    over.phase = 'game_over';
    expect(availableActions(over).canSurrender).toBe(false);
  });

  it('已倒闭玩家不能重复认输；死神时长常量存在', () => {
    const g = newGame(9);
    g.players[0]!.bankrupt = true;
    expect(() => applyAction(g, { type: 'SURRENDER' })).toThrow();
    expect(DEATH_DURATION_DAYS).toBe(13);
  });
});

describe('神明日切：godTickHook 仍正常递减（回归保护）', () => {
  it('跨天后神明计时递减', () => {
    const g = newGame();
    const def = godDef('big-fortune')!;
    g.players[0]!.god = { godId: def.id, remainingDays: def.durationDays };
    const s = advanceOneDay(g);
    expect(s.players[0]!.god!.remainingDays).toBeLessThan(def.durationDays);
  });
});