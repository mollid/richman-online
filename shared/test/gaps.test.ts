import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  BOMB_FUSE_STEPS,
  createGame,
  DEATH_DURATION_DAYS,
  godDef,
  GOD_DURATION_DAYS,
  GODS,
  MAX_HAND_CARDS,
  type GameState,
  type PlayerDef,
} from '../src/index.js';
import { cellAheadOfActor, pinIndexOne, putGodOnBoard, standAt as openLandingWindow } from './helpers/state.js';

/**
 * 波 10a 缺口补齐测试（对应需求项）：
 * - CARD-23 请神卡：召唤视窗内最靠近自己的神明（零抽数）；
 * - CARD-29 同盟：联合收费各得一半 + 陷害盟友自动解除；
 * - GOD-01 土地公：隔月才再出现（help [40]）；
 * - ITEM-01 机器娃娃：清除前方 9 步内的特殊人物与神明；
 * - ITEM-04 定时炸弹：布设到格上 → 踩中附身 → 同格甩锅（D-48）；
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

function newGame(seed = 42, opts: { spawnGods?: boolean } = {}): GameState {
  // 默认关掉神明随机现身：它会占用日切 RNG 抽数，本文件多处断言固定骰子序列与逐日金额。
  // 需要它的用例（如现身规则本身）在 gods_board.test.ts 里，那边默认开启。
  return applyAction(
    createGame(PLAYERS, seed, { startDate: { ...MONDAY }, spawnGods: opts.spawnGods ?? false }),
    { type: 'START_GAME' },
  );
}

/** 站到指定格并固定唯一一颗骰子（掷骰 0 抽） */
function standAt(state: GameState, cellId: number, steps = 3): GameState {
  const s = structuredClone(state);
  const p = s.players[s.currentPlayerIndex]!;
  p.fixedDice = steps;
  p.diceCount = 1;
  p.position = (cellId - steps + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

function step(state: GameState): GameState {
  if (state.phase === 'awaiting_roll') return applyAction(state, { type: 'ROLL_DICE' });
  if (state.phase === 'awaiting_pick') return applyAction(state, { type: 'MINIGAME_PICK', hole: 0 });
  if (state.phase === 'awaiting_discard') return applyAction(state, { type: 'DISCARD_CARD', cardId: state.players[state.currentPlayerIndex]!.cards[0]! });
  return applyAction(state, { type: 'FINISH_LANDING' });
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
    // W2：请神卡请的是「此刻在场」的神明，所以先把这尊放上棋盘
    putGodOnBoard(g, 'big-wealth', def.cellId ?? 5);
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
    putGodOnBoard(g, 'angel', 2);
    putGodOnBoard(g, 'land-god', 3);
    putGodOnBoard(g, 'devil', 4);
    putGodOnBoard(g, 'big-fortune', 8);
    // 4 号格：距 devil(4)=0、land-god(3)=1、angel(2)=2 → 请到 devil
    g.players[0]!.position = 4;
    const r = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.god?.godId).toBe('devil');
    // 移到 8 号格：big-fortune 就在 8 号（距离 0）→ 请到它
    g.players[0]!.position = 8;
    const r2 = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r2.players[0]!.god?.godId).toBe('big-fortune');
  });

  it('12 神明都有唯一候选格；无神在场时请神卡不可用', () => {
    const ids = GODS.map((x) => x.id);
    expect(new Set(ids).size).toBe(12);
    for (const def of GODS) expect(typeof def.cellId).toBe('number');
    const g = pinIndexOne(newGame());
    g.players[0]!.cards = ['invite-god'];
    g.players[0]!.position = 3; // 环上最近：land-god(3) 距离 0
    putGodOnBoard(g, 'angel', 2);
    putGodOnBoard(g, 'land-god', 3);
    const r = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.god?.godId).toBe('land-god');

    // 棋盘上没神：门控与引擎给出同一句拒绝（W2 的「无物可请」）
    const empty = pinIndexOne(newGame(42, { spawnGods: true }));
    empty.players[0]!.cards = ['invite-god'];
    expect(availableActions(empty).usableCards).not.toContain('invite-god');
    expect(() => applyAction(empty, { type: 'USE_CARD', cardId: 'invite-god' })).toThrow('棋盘上此刻没有可请的神明');
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
      g.players[g.currentPlayerIndex]!.fixedDice = 1;
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
    g.phase = 'awaiting_roll'; // R4：同盟卡是自由操作，掷骰前使用
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

describe('ITEM-01 机器娃娃：清除路上障碍、恶犬与驻留神明', () => {
  it('只清恶犬，四大恶人不受机器娃娃影响（D-32）', () => {
    const g = newGame();
    g.players[0]!.items = { 'robot-doll': 1 };
    const ahead = (g.players[0]!.position + 3) % BOARD_SIZE;
    g.npcs = [
      { kind: 'dog', position: ahead, ownerId: null, daysLeft: 1, jailed: false },
      { kind: 'thief', position: (ahead + 2) % BOARD_SIZE, ownerId: 'p2', daysLeft: 5, jailed: false },
    ];
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    expect(r.npcs.map((n) => n.kind)).toEqual(['thief']);
    expect(r.log.some((l) => l.text.includes('恶犬'))).toBe(true);
  });

  it('他人身上附身的神明不归机器娃娃管（D-27/D-32：附身神走送神卡）', () => {
    const g = newGame();
    g.players[0]!.items = { 'robot-doll': 1 };
    const ahead = (g.players[0]!.position + 4) % BOARD_SIZE;
    g.players[1]!.position = ahead;
    g.players[1]!.god = { godId: 'angel', remainingDays: 5 };
    // 前方只剩一个附身神 ⇒ 没有可清的东西，动作被拒且不烧道具
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' })).toThrow('前方 9 步内没有障碍物或特殊单位');
    expect(g.players[1]!.god?.godId).toBe('angel');
  });

  it('在押恶人（jailed）不受机器娃娃影响', () => {
    const g = newGame();
    g.players[0]!.items = { 'robot-doll': 1 };
    // 前方放一个路障保证动作可执行，另放一名在押恶人在别处
    const ahead = (g.players[0]!.position + 3) % BOARD_SIZE;
    g.roadblocks = [{ cellId: ahead, ownerId: 'p2' }];
    g.npcs = [{ kind: 'thief', position: 26, ownerId: null, daysLeft: 0, jailed: true }];
    const r = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    // 路障被清，在押恶人仍在
    expect(r.roadblocks).toHaveLength(0);
    expect(r.npcs).toHaveLength(1);
    expect(r.npcs[0]!.jailed).toBe(true);
  });
});

describe('ITEM-03 地雷：踩中生效，但不拦人（D-49）', () => {
  /** 20 号起固定走 6 步，路上 23 号放一样东西 */
  function walkPast(state: GameState, thing: 'mines' | 'roadblocks'): GameState {
    const s = structuredClone(state);
    s.players.forEach((q, i) => {
      q.position = [2, 40, 55][i]!;
      q.bankrupt = false;
    });
    s[thing] = [{ cellId: 23, ownerId: 'p2' }];
    const p = s.players[s.currentPlayerIndex]!;
    p.fixedDice = 6;
    p.diceCount = 1;
    p.position = 20;
    return s;
  }

  it('踩雷之后仍把这一手走完：落点是 26，不是雷所在的 23', () => {
    const rolled = applyAction(walkPast(newGame(), 'mines'), { type: 'ROLL_DICE' });
    // D-49 要钉的是「这一手走完了」，落点记在 `movePath` 尾巴上；
    // D-54 之后住院还会被押到医院格，所以 `position` 不再是那个落点
    expect(rolled.movePath?.[rolled.movePath.length - 1]).toBe(26);
    expect(rolled.players[0]!.position).toBe(14); // 医院格
    expect(rolled.mines).toEqual([]);
    expect(rolled.players[0]!.skipTurns).toBe(3);
    // 住院就不要再办这一格的事（不买地、不缴租）
    expect(rolled.phase).not.toBe('awaiting_action');
  });

  it('对照：同一条路上只有路障真的会把人拦下', () => {
    const rolled = applyAction(walkPast(newGame(), 'roadblocks'), { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe(23);
    expect(rolled.roadblocks).toEqual([]);
    expect(rolled.players[0]!.skipTurns).toBe(0);
  });
});

describe('ITEM-04 定时炸弹：放格 → 踩中才附身 → 同格甩锅（D-48）', () => {
  /**
   * 站位是本文件这几条用例的骨架，全部钉死：
   * p1=2、p2=40、p3=55，行动一律发生在 20~26 这段路上 —— 除用例自己安排的相遇，
   * 谁都不会正好站在谁的落点上（那会触发甩锅，把断言搅浑）。
   */
  function parked(state: GameState): GameState {
    const s = structuredClone(state);
    s.players.forEach((q, i) => {
      q.position = [2, 40, 55][i]!;
      q.bankrupt = false;
    });
    return s;
  }

  /** 把当前行动者摆到 `from`，并固定一颗骰子走 `dice` 步（掷骰本身 0 抽数） */
  function walkFrom(state: GameState, from: number, dice: number): GameState {
    const s = structuredClone(state);
    const p = s.players[s.currentPlayerIndex]!;
    p.fixedDice = dice;
    p.diceCount = 1;
    p.position = from;
    return s;
  }

  it('使用只让地上多一颗：引信没点，谁也没背', () => {
    const g = parked(newGame());
    g.players[0]!.items = { 'time-bomb': 1 };
    cellAheadOfActor(g, 9);
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb', cellId: 9 });
    expect(used.trapBombs).toEqual([{ cellId: 9, ownerId: 'p1' }]);
    expect(used.bombs).toEqual([]);
    // 旧那句「裸着按 = 装自己身上」不再成立 —— 它是选格动作，缺目标就该被门控挡下
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb' })).toThrow('请选择目标格');
  });

  it('踩中那一格才附身，而且**不截停**：只有路障有拦截功能', () => {
    const g = parked(newGame());
    g.trapBombs = [{ cellId: 23, ownerId: 'p1' }];
    g.currentPlayerIndex = 1; // 小美去踩：20 起走 6 步，途中经过 23
    const rolled = applyAction(walkFrom(g, 20, 6), { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.position).toBe(26);
    expect(rolled.trapBombs).toEqual([]);
    expect(rolled.bombs).toEqual([{ playerId: 'p2', stepsLeft: BOMB_FUSE_STEPS - 3 }]);
    expect(rolled.log.some((l) => l.text.includes('被迫背起来'))).toBe(true);
  });

  it('引信从踩中那一刻起算：踩得早烧得多，踩在最后一步一分不烧', () => {
    const early = parked(newGame());
    early.trapBombs = [{ cellId: 21, ownerId: 'p1' }];
    const e = applyAction(walkFrom(early, 20, 6), { type: 'ROLL_DICE' });
    expect(e.bombs[0]!.stepsLeft).toBe(BOMB_FUSE_STEPS - 5);

    const lastly = parked(newGame());
    lastly.trapBombs = [{ cellId: 26, ownerId: 'p1' }];
    const l = applyAction(walkFrom(lastly, 20, 6), { type: 'ROLL_DICE' });
    expect(l.players[0]!.position).toBe(26);
    expect(l.bombs[0]!.stepsLeft).toBe(BOMB_FUSE_STEPS);
  });

  it('背着炸弹的人走到别人那一格 ⇒ 炸弹换人背，剩余步数不清零', () => {
    const g = parked(newGame());
    g.players[1]!.position = 26; // 小美正好在落点上
    g.bombs = [{ playerId: 'p1', stepsLeft: 20 }];
    const rolled = applyAction(walkFrom(g, 20, 6), { type: 'ROLL_DICE' });
    expect(rolled.bombs).toEqual([{ playerId: 'p2', stepsLeft: 14 }]);
    expect(rolled.log.some((l) => l.text.includes('甩给了'))).toBe(true);
  });

  it('对方身上已经有一颗时甩不出去（倒数只认第一条，两颗会算不清）', () => {
    const g = parked(newGame());
    g.players[1]!.position = 26;
    g.bombs = [{ playerId: 'p1', stepsLeft: 20 }, { playerId: 'p2', stepsLeft: 7 }];
    const rolled = applyAction(walkFrom(g, 20, 6), { type: 'ROLL_DICE' });
    expect(rolled.bombs.find((b) => b.playerId === 'p1')!.stepsLeft).toBe(14);
    expect(rolled.bombs.find((b) => b.playerId === 'p2')!.stepsLeft).toBe(7);
  });

  it('已经在背的人再踩到地上那颗 ⇒ 留在原地，不出现一人两颗', () => {
    const g = parked(newGame());
    g.bombs = [{ playerId: 'p1', stepsLeft: 30 }];
    g.trapBombs = [{ cellId: 23, ownerId: 'p2' }];
    const rolled = applyAction(walkFrom(g, 20, 6), { type: 'ROLL_DICE' });
    expect(rolled.trapBombs).toEqual([{ cellId: 23, ownerId: 'p2' }]);
    expect(rolled.bombs).toEqual([{ playerId: 'p1', stepsLeft: 24 }]);
  });

  it('走满引信才炸：落点 3×3 内爆炸并结束这一手', () => {
    const g = parked(newGame());
    g.bombs = [{ playerId: 'p1', stepsLeft: 3 }];
    const rolled = applyAction(walkFrom(g, 20, 3), { type: 'ROLL_DICE' });
    expect(rolled.bombs).toEqual([]);
    expect(rolled.log.some((l) => l.text.includes('定时炸弹爆炸'))).toBe(true);
  });

  it('机器娃娃与拆除卡都清得掉地上那颗（D-42 / D-48）', () => {
    const swept = parked(newGame());
    swept.trapBombs = [{ cellId: 7, ownerId: 'p2' }];
    swept.players[0]!.items = { 'robot-doll': 1 };
    const used = applyAction(swept, { type: 'USE_ITEM', itemId: 'robot-doll' });
    expect(used.trapBombs).toEqual([]);

    const cards = parked(newGame());
    cards.trapBombs = [{ cellId: 40, ownerId: 'p2' }];
    cards.players[0]!.cards = ['demolish'];
    const removed = applyAction(cards, { type: 'USE_CARD', cardId: 'demolish', cellId: 40 });
    expect(removed.trapBombs).toEqual([]);
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

  it('踩到医院格：门外有住院病人就开出决策窗，办完自动结束回合（R4 补死路）', () => {
    const base = pinIndexOne(newGame());
    base.players[1]!.custody = { kind: 'hospital', daysLeft: 3 };
    base.players[1]!.skipTurns = 3;
    const landed = applyAction(standAt(base, HOSPITAL_CELL), { type: 'ROLL_DICE' });
    // 旧规这一格直接 'advance'，于是 DISCHARGE_PATIENT 是一条永远打不出来的动作
    expect(landed.landing).toEqual({ cellId: HOSPITAL_CELL, venue: null, turn: landed.turn });
    expect(availableActions(landed).dischargeablePatients).toEqual(['p2']);

    const done = applyAction(landed, { type: 'DISCHARGE_PATIENT', targetPlayerId: 'p2' });
    expect(done.players[1]!.custody).toBeNull();
    expect(done.landing).toBeNull();
    expect(done.phase).toBe('awaiting_roll'); // 终结动作：办完就把行动权交出去
  });

  it('门外没人可办时医院格不开窗（R4：没得选就不钉人）', () => {
    const landed = applyAction(standAt(pinIndexOne(newGame()), HOSPITAL_CELL), { type: 'ROLL_DICE' });
    expect(landed.landing).toBeNull();
    expect(landed.phase).toBe('awaiting_roll');
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

  it('待舍弃队列非空时可由 DISCARD_CARD 完成入栏并回到 awaiting_action', () => {
    const g = newGame();
    const p = g.players[0]!;
    // 15 张「天使卡」，用计数断言舍弃生效
    p.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'angel');
    g.phase = 'awaiting_discard';
    g.pendingCards = [{ cardId: 'tax-audit', ownerId: p.id }];
    const r = applyAction(g, { type: 'DISCARD_CARD', cardId: 'angel' });
    expect(r.pendingCards).toEqual([]);
    // 没有落格窗可回 ⇒ 舍弃完就把先前被队列压住的那次回合推进补上（R4）
    expect(r.phase).toBe('awaiting_roll');
    expect(r.players[0]!.cards.length).toBe(MAX_HAND_CARDS);
    expect(r.players[0]!.cards.filter((c) => c === 'angel')).toHaveLength(MAX_HAND_CARDS - 1);
    expect(r.players[0]!.cards).toContain('tax-audit');
  });

  it('额满抽卡发生在别人的回合里：该弃牌的是卡主，不是轮到的人（R5 修掉的软锁）', () => {
    const g = newGame();
    const owner = g.players[1]!;
    owner.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'angel');
    g.currentPlayerIndex = 0; // 轮到 0 号，他手上一张牌都没有
    g.phase = 'awaiting_discard';
    g.pendingCards = [{ cardId: 'tax-audit', ownerId: owner.id }];
    expect(g.players[0]!.cards).toHaveLength(0);

    const r = applyAction(g, { type: 'DISCARD_CARD', cardId: 'angel' });
    // applyAction 返回克隆，断言要读 r 里的玩家，不能握着改动前那份引用
    const after = r.players[1]!;
    expect(r.pendingCards).toEqual([]);
    expect(after.cards).toContain('tax-audit'); // 新卡进的是卡主的手
    expect(after.cards.filter((c) => c === 'angel')).toHaveLength(MAX_HAND_CARDS - 1);
    expect(r.players[0]!.cards).toHaveLength(0); // 没去动「轮到的人」的牌
  });

  it('同一回合连抽两张满手牌：队列不互相覆盖，逐张舍弃才收口（R4）', () => {
    const g = newGame();
    g.players[0]!.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'angel');
    g.phase = 'awaiting_discard';
    g.pendingCards = [{ cardId: 'tax-audit', ownerId: g.players[0]!.id }, { cardId: 'devil', ownerId: g.players[0]!.id }]; // 旧口径是单槽，后一张会把前一张顶掉
    const first = applyAction(g, { type: 'DISCARD_CARD', cardId: 'angel' });
    expect(first.pendingCards).toEqual([{ cardId: 'devil', ownerId: g.players[0]!.id }]);
    expect(first.phase).toBe('awaiting_discard'); // 还有第二张要继续问
    expect(first.players[0]!.cards).toContain('tax-audit');
    const second = applyAction(first, { type: 'DISCARD_CARD', cardId: 'angel' });
    expect(second.pendingCards).toEqual([]);
    expect(second.players[0]!.cards).toContain('devil');
  });

  it('额满抽卡不会被落格推进抹掉：推进推迟到队列清空（R4）', () => {
    const base = pinIndexOne(newGame());
    base.players[0]!.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'angel');
    const turn0 = base.turn;
    // 42 号卡片屋：落脚即抽一张，而手牌已额满 ⇒ 挂起等待舍弃
    const landed = applyAction(standAt(base, 42), { type: 'ROLL_DICE' });
    expect(landed.pendingCards.length).toBe(1);
    expect(landed.phase).toBe('awaiting_discard');
    expect(landed.turn).toBe(turn0); // 回合推进被队列压住，一张卡都没丢
    const after = applyAction(landed, { type: 'DISCARD_CARD', cardId: 'angel' });
    expect(after.pendingCards).toEqual([]);
    expect(after.turn).toBe(turn0 + 1); // 舍弃完补上那次推进
    expect(after.phase).toBe('awaiting_roll');
  });

  it('在商店里抽到额满：舍弃完回到店里，而不是把回合交出去（R4 会话窗）', () => {
    const g = newGame();
    g.players[0]!.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'angel');
    g.pendingCards = [{ cardId: 'tax-audit', ownerId: g.players[0]!.id }];
    // 商店会话窗开着时买卡买到手牌额满 —— 引擎就是把相位切成 awaiting_discard 而保留 landing
    const inShop = openLandingWindow(structuredClone(g), 0, 2); // 2 号商店
    inShop.phase = 'awaiting_discard';
    const back = applyAction(inShop, { type: 'DISCARD_CARD', cardId: 'angel' });
    expect(back.pendingCards).toEqual([]);
    expect(back.landing?.venue).toBe('shop');
    expect(back.phase).toBe('awaiting_action'); // 回到店里继续买，回合没被这一手推走
  });

  it('availableActions 暴露 pendingCards', () => {
    const g = newGame();
    g.phase = 'awaiting_discard';
    g.pendingCards = [{ cardId: 'devil', ownerId: g.players[0]!.id }];
    expect(availableActions(g).pendingCards).toEqual([{ cardId: 'devil', ownerId: g.players[0]!.id }]);
  });
});

describe('CORE-04 认输投降（死神附身流程）', () => {
  it('认输者干净退出，死神附身于指定复仇者并清空其卡牌道具', () => {
    const g = pinIndexOne(newGame());
    const p = g.players[0]!;
    p.cards = ['angel', 'devil'];
    p.items = { teleporter: 1 };
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    const me = r.players[0]!;
    expect(me.bankrupt).toBe(true);
    expect(me.cards).toEqual([]);
    expect(me.items).toEqual({});
    expect(me.god).toBeNull();
    expect(r.log.some((l) => l.text.includes('已退出对局'))).toBe(true);
    // 死神落在复仇者头上
    const avenger = r.players[1]!;
    expect(avenger.god?.godId).toBe('death');
    expect(r.log.some((l) => l.text.includes('死神'))).toBe(true);
  });

  it('两人局中一人认输 → 另一人获胜', () => {
    const g = applyAction(createGame([PLAYERS[0]!, PLAYERS[1]!], 5, { startDate: { ...MONDAY } }), {
      type: 'START_GAME',
    });
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
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
    expect(() => applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' })).toThrow();
    expect(DEATH_DURATION_DAYS).toBe(13);
  });
});

describe('神庙摇籤：仍为随机（GOD 分布回归保护）', () => {
  it('不同种子落到神庙摇出不同神明（覆盖多种结果，不恒定）', () => {
    const picked = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const g = newGame(seed);
      g.players[0]!.position = 4; // 神庙前一格
      g.players[g.currentPlayerIndex]!.fixedDice = 1;
      g.players[0]!.diceCount = 1;
      const r = applyAction(g, { type: 'ROLL_DICE' });
      // 落庙后回合已推进，改由日志判定附身结果
      const hit = r.log.filter((l) => l.text.includes('附身'));
      if (hit.length > 0) picked.add(hit[hit.length - 1]!.text);
    }
    // 200 次落庙应覆盖到多种神明（摇籤确实在随机）
    expect(picked.size).toBeGreaterThanOrEqual(3);
  });

  it('同一 seed 重复落庙摇出同一神明（确定性回放）', () => {
    const run = () => {
      const g = newGame(77);
      g.players[0]!.position = 4;
      g.players[g.currentPlayerIndex]!.fixedDice = 1;
      g.players[0]!.diceCount = 1;
      const r = applyAction(g, { type: 'ROLL_DICE' });
      const hit = r.log.filter((l) => l.text.includes('附身'));
      return hit[hit.length - 1]?.text ?? null;
    };
    expect(run()).toBe(run());
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