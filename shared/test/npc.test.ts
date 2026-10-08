import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BAIL_FEE,
  BOARD_SIZE,
  CURSES,
  createGame,
  CURSE_ORDER,
  MAGIC_CONDITIONS,
  nextRandom,
  totalAssets,
  VILLAIN_DAYS,
  VILLAIN_KINDS,
  VILLAINS,
} from '../src/index.js';
import type { GameState, NpcUnit, PlayerDef } from '../src/index.js';

/**
 * 波 8b 特殊单位测试（NPC-01..06，对标文档 §8.2 / help [34][38]）：
 * - NPC-01..04 四大恶人初始在押、保释流程、每日移动与四种行窃、刑满回监；
 * - 只读派生随机（零抽数）不扰动确定性回放；
 * - TILE-11 魔法屋（NPC-06 女巫）：施法条件与候选受罚者、五种诅咒结算、非法输入被拒。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;
const JAIL_CELL = 26;
const MAGIC_CELL = 48;

function newGame(seed = 42): GameState {
  return applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
}

/**
 * 把当前玩家摆到能以 steps 点落到 targetCell 的位置。
 * 用 `pendingFixedDice` 固定唯一一颗骰子 → 掷骰消耗 0 抽，
 * `rngState` 完全由调用方指定，便于精确控制落格后的随机分支。
 */
function setupLanding(state: GameState, targetCell: number, steps: number, rngState = state.rngState): GameState {
  const s = structuredClone(state);
  s.rngState = rngState;
  s.pendingFixedDice = steps;
  const p = s.players[s.currentPlayerIndex]!;
  p.diceCount = 1;
  p.position = (targetCell - steps + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

/** 找种子使「魔法屋落格后」抽到的施法条件与诅咒分别为指定下标 */
function seedForMagic(conditionIndex: number, curseIndex: number): number {
  for (let seed = 1; seed <= 2_000_000; seed++) {
    const a = nextRandom(seed);
    if (Math.floor(a.value * MAGIC_CONDITIONS.length) !== conditionIndex) continue;
    const b = nextRandom(a.nextState);
    if (Math.floor(b.value * CURSE_ORDER.length) === curseIndex) return seed;
  }
  throw new Error(`找不到条件 ${conditionIndex} + 诅咒 ${curseIndex} 的种子`);
}

function npcOf(state: GameState, kind: string): NpcUnit {
  const n = state.npcs.find((x) => x.kind === kind);
  if (!n) throw new Error(`找不到恶人 ${kind}`);
  return n;
}

/** 把某名恶人置于「已保释在外」状态 */
function bailForTest(state: GameState, kind: string, ownerId = 'p1'): GameState {
  const s = structuredClone(state);
  const npc = npcOf(s, kind);
  npc.jailed = false;
  npc.ownerId = ownerId;
  npc.daysLeft = VILLAIN_DAYS;
  npc.position = 0;
  return s;
}

/** 推进一个动作并能收尾 */
function step(state: GameState): GameState {
  if (state.phase === 'awaiting_roll') return applyAction(state, { type: 'ROLL_DICE' });
  if (state.phase === 'awaiting_pick') return applyAction(state, { type: 'MINIGAME_PICK', hole: 0 });
  return applyAction(state, { type: 'END_TURN' });
}

/** 推进到跨过一天（触发日切钩子） */
function advanceOneDay(state: GameState): GameState {
  const start = state.calendar.elapsedDays;
  let s = state;
  for (let i = 0; i < 24 && s.calendar.elapsedDays === start; i++) s = step(s);
  expect(s.calendar.elapsedDays, '未能推进到下一天').toBeGreaterThan(start);
  return s;
}

describe('NPC-01..04 四大恶人（数据与保释）', () => {
  it('四大恶人数据完备且顺序固定', () => {
    expect(VILLAIN_KINDS).toEqual(['thief', 'protection', 'robber', 'rent-thief']);
    for (const kind of VILLAIN_KINDS) {
      expect(VILLAINS[kind].name).toBeTruthy();
      expect(VILLAINS[kind].desc).toBeTruthy();
    }
  });

  it('createGame 时四恶人全部在押于监狱格、无主', () => {
    const g = newGame(3);
    const villains = g.npcs.filter((n) => n.kind !== 'dog');
    expect(villains).toHaveLength(4);
    for (const v of villains) {
      expect(v.jailed).toBe(true);
      expect(v.ownerId).toBeNull();
      expect(v.daysLeft).toBe(0);
      expect(v.position).toBe(JAIL_CELL);
    }
  });

  it('监狱门外可保释：扣保释金、刑期 7 天、主人为保释人', () => {
    const g = setupLanding(newGame(11), JAIL_CELL, 3);
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.position).toBe(JAIL_CELL);
    expect(landed.phase).toBe('awaiting_action');
    const acts = availableActions(landed);
    expect(acts.bailableVillains).toEqual([...VILLAIN_KINDS]);
    expect(acts.bailFee).toBe(BAIL_FEE);

    const cashBefore = landed.players[0]!.cash;
    const bailed = applyAction(landed, { type: 'BAIL_PRISONER', npcKind: 'thief' });
    expect(bailed.players[0]!.cash).toBe(cashBefore - BAIL_FEE);
    const thief = npcOf(bailed, 'thief');
    expect(thief.jailed).toBe(false);
    expect(thief.ownerId).toBe('p1');
    expect(thief.daysLeft).toBe(VILLAIN_DAYS);
    expect(bailed.log.some((l) => l.text.includes('保释了小偷'))).toBe(true);
  });

  it('不在监狱门外不能保释', () => {
    const g = newGame(13);
    expect(() => applyAction(g, { type: 'BAIL_PRISONER', npcKind: 'thief' })).toThrow();
  });

  it('现金不足不能保释；已保释者不可重复保释', () => {
    const landed = applyAction(setupLanding(newGame(17), JAIL_CELL, 3), { type: 'ROLL_DICE' });
    expect(availableActions(landed).bailFee).toBe(BAIL_FEE);
    // 现金为 0 时自洽不足：保释金随物价指数缩放，改现金后需重算，
    // 但现金为 0 时保释金恒 > 0，必然付不起
    const broke = structuredClone(landed);
    broke.players[0]!.cash = 0;
    expect(availableActions(broke).bailFee).toBeGreaterThan(0);
    expect(() => applyAction(broke, { type: 'BAIL_PRISONER', npcKind: 'thief' })).toThrow();

    // 已保释者不可重复保释
    const bailed = applyAction(landed, { type: 'BAIL_PRISONER', npcKind: 'thief' });
    expect(() => applyAction(bailed, { type: 'BAIL_PRISONER', npcKind: 'thief' })).toThrow();
  });
});

describe('NPC-01..04 每日活动（移动 + 行窃 + 刑满回监）', () => {
  it('日切时已保释恶人移动 1..6 步并扣除刑期 1 天', () => {
    const g = advanceOneDay(bailForTest(newGame(23), 'thief'));
    const thief = npcOf(g, 'thief');
    expect(thief.jailed).toBe(false);
    expect(thief.daysLeft).toBe(VILLAIN_DAYS - 1);
    // 从 0 号格出发移动 1..6 步（仍在同一圈内）
    expect(thief.position).toBeGreaterThanOrEqual(1);
    expect(thief.position).toBeLessThanOrEqual(6);
  });

  it('只读派生随机零抽数：恶人活动不消耗 state.rngState', () => {
    // 同一状态下重复执行 advanceOneDay，两次得到的 rngState 相同，
    // 且与「无恶人」对照组相同 → 恶人活动确实零抽数
    const withVillains = bailForTest(newGame(29), 'robber');
    const without = (() => {
      const s = newGame(29);
      s.npcs = [];
      return s;
    })();
    const a = advanceOneDay(structuredClone(withVillains));
    const b = advanceOneDay(structuredClone(withVillains));
    const c = advanceOneDay(structuredClone(without));
    expect(a.rngState).toBe(b.rngState);
    expect(a.rngState).toBe(c.rngState);
  });

  it('刑满 7 天后押回监狱', () => {
    let g = bailForTest(newGame(31), 'protection');
    for (let i = 0; i < 60; i++) {
      g = step(g);
      if (npcOf(g, 'protection').jailed) break;
    }
    const n = npcOf(g, 'protection');
    expect(n.jailed).toBe(true);
    expect(n.ownerId).toBeNull();
    expect(n.daysLeft).toBe(0);
    expect(n.position).toBe(JAIL_CELL);
  });

  it('保释人倒闭后恶人押回监狱', () => {
    let g = bailForTest(newGame(37), 'rent-thief');
    g.players[0]!.cash = 0;
    g.players[0]!.deposit = 0;
    g.players[0]!.loan = null;
    g.players[0]!.bankrupt = true;
    const next = advanceOneDay(g);
    const n = npcOf(next, 'rent-thief');
    expect(n.jailed).toBe(true);
    expect(n.ownerId).toBeNull();
    expect(next.log.some((l) => l.text.includes('被押回监狱'))).toBe(true);
  });

  it('未保释的恶人在日切后仍留在监狱', () => {
    const g = advanceOneDay(newGame(41));
    for (const kind of VILLAIN_KINDS) {
      const n = npcOf(g, kind);
      expect(n.jailed).toBe(true);
      expect(n.position).toBe(JAIL_CELL);
    }
  });
});

describe('NPC-01..04 四种行窃行为', () => {
  /**
   * 恶人每日移动 1..6 步（只读派生随机），落点不可直接指定。
   * 两阶段扫描种子：先跑一次知道当日落点，再按该落点布置场景（受害者/地主/公司）重跑，
   * 从而稳定断言「行窃发生在指定格」。`startAt` 可指定起始格（默认 0）。
   */
  function sceneForLanding(
    kind: string,
    setupAt: (g: GameState, landingCellId: number) => void,
    startAt = 0,
    maxSeed = 4000,
  ): { cellId: number; after: GameState } {
    for (let seed = 1; seed <= maxSeed; seed++) {
      const probe = newGame(seed);
      const pn = npcOf(probe, kind);
      pn.jailed = false;
      pn.ownerId = 'p1';
      pn.daysLeft = VILLAIN_DAYS;
      pn.position = startAt;
      let probeAfter: GameState;
      try {
        probeAfter = advanceOneDay(probe);
      } catch {
        continue;
      }
      const moved = npcOf(probeAfter, kind);
      if (moved.jailed) continue;
      const cellId = moved.position;

      // 第二阶段：同种子、同起始位置，布置场景后重跑
      // setupAt 抛错表示该落点不符合本用例需求 → 换下一个种子
      let after: GameState;
      try {
        const g = newGame(seed);
        const n = npcOf(g, kind);
        n.jailed = false;
        n.ownerId = 'p1';
        n.daysLeft = VILLAIN_DAYS;
        n.position = startAt;
        setupAt(g, cellId);
        after = advanceOneDay(g);
      } catch {
        continue;
      }
      if (npcOf(after, kind).position !== cellId) continue;
      return { cellId, after };
    }
    throw new Error(`找不到可用于 ${kind} 作案的种子`);
  }

  it('NPC-01 小偷：偷点券（上限 500）与一件道具', () => {
    const { after } = sceneForLanding('thief', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.points = 2000;
        p.items = { 'bomb-lite': 1 };
      }
    });
    const thief = npcOf(after, 'thief');
    expect(thief.ownerId).toBe('p1');
    expect(after.log.some((l) => l.text.includes('小偷') && l.text.includes('偷走'))).toBe(true);
    // 点券至多被偷 500，且至少一名受害者受损
    const victims = after.players.filter((p) => p.id !== 'p1');
    const anyPointsLost = victims.some((p) => p.points <= 1500);
    const anyItemLost = victims.some((p) => p.items['bomb-lite'] === undefined);
    expect(anyPointsLost || anyItemLost).toBe(true);
    for (const p of victims) expect(2000 - p.points).toBeLessThanOrEqual(500);
  });

  it('NPC-02 收保护费：向地主收取地价 5% 的费用', () => {
    const { cellId, after } = sceneForLanding('protection', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property' || !cell.price) {
        // 该落点不是可收保护费的地产 → 让本次布置失效（下一轮种子会被跳过）
        throw new Error('落点非地产');
      }
      const owner = g.players.find((p) => p.id !== 'p1')!;
      owner.properties.push({ cellId: landing, grade: 1 });
      owner.cash = 1_000_000;
      owner.deposit = 0;
    });
    const cell = after.board[cellId]!;
    const fee = Math.round((cell.price ?? 0) * 0.05);
    expect(fee).toBeGreaterThan(0);
    const owner = after.players.find((p) => p.properties.some((q) => q.cellId === cellId))!;
    // 地主资产显著下降（扣了保护费；可能叠加其他日切影响，故只断言「变少且金额量级相符」）
    expect(owner.cash + owner.deposit).toBeLessThan(1_000_000);
    expect(after.log.some((l) => l.text.includes('收取保护费'))).toBe(true);
  });

  it('NPC-03 行抢：抢走一张卡片', () => {
    const { after } = sceneForLanding('robber', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.cards = ['tax-audit'];
      }
    });
    const victim = after.players.find((p) => p.id !== 'p1');
    expect(victim!.cards).not.toContain('tax-audit');
    expect(after.log.some((l) => l.text.includes('行抢') && l.text.includes('抢走'))).toBe(true);
  });

  it('NPC-03 行抢：无卡片时改抢一件道具', () => {
    const { after } = sceneForLanding('robber', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.cards = [];
        p.items = { 'bomb-lite': 1 };
      }
    });
    const victim = after.players.find((p) => p.id !== 'p1');
    expect(victim!.items['bomb-lite']).toBeUndefined();
    expect(after.log.some((l) => l.text.includes('道具'))).toBe(true);
  });

  it('NPC-04 窃取租金：窃取本地上次收取的租金', () => {
    const { cellId, after } = sceneForLanding('rent-thief', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property') throw new Error('落点非土地');
      g.players.find((p) => p.id !== 'p1')!.properties.push({ cellId: landing, grade: 1, lastRent: 3000 });
    });
    expect(after.board[cellId]!.type).toBe('property');
    const owner = after.players.find((p) => p.properties.some((q) => q.cellId === cellId))!;
    expect(owner.properties.find((q) => q.cellId === cellId)!.lastRent).toBeNull();
    expect(after.log.some((l) => l.text.includes('窃取租金'))).toBe(true);
  });

  it('NPC-04 窃取租金：公司格盗领累积红利', () => {
    // 公司格在 43/47/51/55/57..63，从 45 号格出发可在 1..6 步内抵达 47
    const { cellId, after } = sceneForLanding(
      'rent-thief',
      (g, landing) => {
        const cell = g.board[landing]!;
        if (cell.type !== 'company') throw new Error('落点非公司');
        g.companies.find((c) => c.cellId === landing)!.surplus = 8888;
      },
      45,
    );
    expect(after.board[cellId]!.type).toBe('company');
    expect(after.companies.find((c) => c.cellId === cellId)!.surplus).toBe(0);
    expect(after.log.some((l) => l.text.includes('盗领累积红利'))).toBe(true);
  });

  // 用户规则：四大恶人的赃物都实际交给释放（保释）他的人
  it('赃物转交保释人：小偷偷到的点券与道具归保释人', () => {
    const { after } = sceneForLanding('thief', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.points = 2000;
        p.items = { 'bomb-lite': 1 };
      }
    });
    const bailer = after.players.find((p) => p.id === 'p1')!;
    // 小偷每次只偷一名路人：点券必为 500（2000 触顶），道具一并转交
    expect(bailer.points).toBe(500);
    expect(bailer.items['bomb-lite']).toBe(1);
    expect(after.log.some((l) => l.text.includes('赃物交予') && l.text.includes('阿福'))).toBe(true);
  });

  it('赃物转交保释人：行抢的卡片入保释人手牌', () => {
    const { after } = sceneForLanding('robber', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.cards = ['tax-audit'];
      }
    });
    const bailer = after.players.find((p) => p.id === 'p1')!;
    expect(bailer.cards).toContain('tax-audit');
  });

  it('赃物转交保释人：窃取的租金现金归保释人', () => {
    const { after } = sceneForLanding('rent-thief', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property') throw new Error('落点非土地');
      g.players.find((p) => p.id !== 'p1')!.properties.push({ cellId: landing, grade: 1, lastRent: 3000 });
    });
    const bailer = after.players.find((p) => p.id === 'p1')!;
    expect(bailer.cash).toBe(15000 + 3000);
  });

  it('赃物转交保释人：保护费现金归保释人', () => {
    const { cellId, after } = sceneForLanding('protection', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property' || !cell.price) throw new Error('落点非地产');
      const owner = g.players.find((p) => p.id !== 'p1')!;
      owner.properties.push({ cellId: landing, grade: 1 });
      owner.cash = 1_000_000;
      owner.deposit = 0;
    });
    const fee = Math.round((after.board[cellId]!.price ?? 0) * 0.05);
    const bailer = after.players.find((p) => p.id === 'p1')!;
    expect(bailer.cash).toBe(15000 + fee);
  });
});

describe('TILE-11 魔法屋（NPC-06 女巫）', () => {
  it('魔法屋落格生成施法机会（条件 + 诅咒 + 候选），阶段为 awaiting_action', () => {
    // 条件「all」（下标 0）+ 诅咒「恶魔税」（下标 0）
    const g = setupLanding(newGame(53), MAGIC_CELL, 3, seedForMagic(0, 0));
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.position).toBe(MAGIC_CELL);
    expect(landed.phase).toBe('awaiting_action');
    const magic = landed.magic;
    expect(magic).not.toBeNull();
    expect(MAGIC_CONDITIONS.map((c) => c.kind)).toContain(magic!.condition);
    expect(CURSE_ORDER).toContain(magic!.curse);
    // 候选不含施法者本人
    expect(magic!.candidateIds).not.toContain('p1');
    // availableActions 同步暴露
    expect(availableActions(landed).magic?.condition).toBe(magic!.condition);
  });

  it('施法条件「all」候选为全部对手', () => {
    const g = setupLanding(newGame(59), MAGIC_CELL, 3, seedForMagic(0, 0));
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.magic?.condition).toBe('all');
    expect([...landed.magic!.candidateIds].sort()).toEqual(['p2', 'p3']);
  });

  it('施法条件「landowner」只看名下有无土地', () => {
    // 条件「landowner」下标 4
    const seed = seedForMagic(4, 0);
    // 初始人人无地 → 候选为空
    const none = applyAction(setupLanding(newGame(67), MAGIC_CELL, 3, seed), { type: 'ROLL_DICE' });
    expect(none.magic?.condition).toBe('landowner');
    expect(none.magic?.candidateIds).toEqual([]);
    // p2 名下有地 → p2 成为候选
    const withLand = structuredClone(setupLanding(newGame(67), MAGIC_CELL, 3, seed));
    withLand.players[1]!.properties.push({ cellId: 1, grade: 1 });
    const landed = applyAction(withLand, { type: 'ROLL_DICE' });
    expect(landed.magic?.condition).toBe('landowner');
    expect(landed.magic?.candidateIds).toEqual(['p2']);
  });

  it('施法条件「vehicle」按交通工具（diceCount>1）判定', () => {
    const seed = seedForMagic(3, 0); // 「vehicle」
    const withCar = structuredClone(setupLanding(newGame(71), MAGIC_CELL, 3, seed));
    withCar.players[1]!.diceCount = 2; // 机车
    const landed = applyAction(withCar, { type: 'ROLL_DICE' });
    expect(landed.magic?.condition).toBe('vehicle');
    expect(landed.magic?.candidateIds).toEqual(['p2']);
  });

  it('CAST_MAGIC 施放「恶魔税」：受罚者被扣钱进乐透池', () => {
    const landed = applyAction(setupLanding(newGame(73), MAGIC_CELL, 3, seedForMagic(0, 0)), {
      type: 'ROLL_DICE',
    });
    expect(landed.magic?.curse).toBe('fine');
    const offer = landed.magic!;
    const targetId = offer.candidateIds[0]!;
    const before = landed.players.find((p) => p.id === targetId)!;
    const cashBefore = before.cash;
    const poolBefore = landed.lotteryPool;
    const next = applyAction(landed, { type: 'CAST_MAGIC', targetPlayerId: targetId });
    expect(next.magic).toBeNull();
    expect(next.log.some((l) => l.text.includes(CURSES.fine.name))).toBe(true);
    const after = next.players.find((p) => p.id === targetId)!;
    expect(after.cash + after.deposit).toBeLessThan(cashBefore);
    expect(next.lotteryPool).toBe(poolBefore + offer.amount);
  });

  it('CAST_MAGIC 施放「牢狱之灾」：受罚者入狱暂停回合并丧失收租权', () => {
    const landed = applyAction(setupLanding(newGame(101), MAGIC_CELL, 3, seedForMagic(0, 1)), {
      type: 'ROLL_DICE',
    });
    expect(landed.magic?.curse).toBe('jail');
    const targetId = landed.magic!.candidateIds[0]!;
    const next = applyAction(landed, { type: 'CAST_MAGIC', targetPlayerId: targetId });
    const target = next.players.find((p) => p.id === targetId)!;
    expect(target.skipTurns).toBeGreaterThanOrEqual(CURSES.jail.days!);
    expect(target.custody?.kind).toBe('jail');
    expect(target.rentBlockedTurns).toBeGreaterThan(0);
  });

  it('CAST_MAGIC 施放「怪病缠身」与「放逐异界」', () => {
    // 「hospital」下标 2
    const hosp = applyAction(setupLanding(newGame(103), MAGIC_CELL, 3, seedForMagic(0, 2)), {
      type: 'ROLL_DICE',
    });
    expect(hosp.magic?.curse).toBe('hospital');
    const hTarget = hosp.magic!.candidateIds[0]!;
    const hNext = applyAction(hosp, { type: 'CAST_MAGIC', targetPlayerId: hTarget });
    expect(hNext.players.find((p) => p.id === hTarget)!.custody?.kind).toBe('hospital');

    // 「abroad」下标 3
    const ab = applyAction(setupLanding(newGame(107), MAGIC_CELL, 3, seedForMagic(0, 3)), {
      type: 'ROLL_DICE',
    });
    expect(ab.magic?.curse).toBe('abroad');
    const aTarget = ab.magic!.candidateIds[0]!;
    const aNext = applyAction(ab, { type: 'CAST_MAGIC', targetPlayerId: aTarget });
    expect(aNext.players.find((p) => p.id === aTarget)!.abroadTurns).toBeGreaterThan(0);
  });

  it('CAST_MAGIC 施放「卡片失窃」：受罚者少一张卡', () => {
    // 「lose-card」下标 4；用普通卡（免罪/嫁祸/复仇卡会被 applyDisaster 抵消）
    const g = structuredClone(setupLanding(newGame(109), MAGIC_CELL, 3, seedForMagic(0, 4)));
    g.players[1]!.cards.push('tax-audit');
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.magic?.curse).toBe('lose-card');
    const targetId = landed.magic!.candidateIds[0]!;
    const next = applyAction(landed, { type: 'CAST_MAGIC', targetPlayerId: targetId });
    const target = next.players.find((p) => p.id === targetId)!;
    expect(target.cards).not.toContain('tax-audit');
    expect(next.log.some((l) => l.text.includes('凭空消失'))).toBe(true);
  });

  it('魔法屋机会不跨回合残留（advanceTurn 清空 magic）', () => {
    const landed = applyAction(setupLanding(newGame(307), MAGIC_CELL, 3, seedForMagic(0, 0)), {
      type: 'ROLL_DICE',
    });
    expect(landed.magic).not.toBeNull();
    const next = applyAction(landed, { type: 'END_TURN' });
    expect(next.magic).toBeNull();
  });

  it('非法 CAST_MAGIC：无机会 / 目标不存在 / 候选外被拒', () => {
    const plain = newGame(311);
    expect(() => applyAction(plain, { type: 'CAST_MAGIC', targetPlayerId: 'p2' })).toThrow();

    const landed = applyAction(setupLanding(newGame(313), MAGIC_CELL, 3, seedForMagic(4, 0)), {
      type: 'ROLL_DICE',
    });
    // 条件 landowner 但人人无地 → 候选空，任何目标都非法
    expect(landed.magic?.candidateIds).toEqual([]);
    expect(() => applyAction(landed, { type: 'CAST_MAGIC', targetPlayerId: 'p2' })).toThrow();
    expect(() => applyAction(landed, { type: 'CAST_MAGIC', targetPlayerId: 'nobody' })).toThrow();
  });

  it('施法后仍停留在魔法屋，可继续其他操作或结束回合', () => {
    const landed = applyAction(setupLanding(newGame(317), MAGIC_CELL, 3, seedForMagic(0, 0)), {
      type: 'ROLL_DICE',
    });
    expect(landed.phase).toBe('awaiting_action');
    expect(availableActions(landed).canEnd).toBe(true);
    // 放弃施法 → 结束回合
    const next = applyAction(landed, { type: 'END_TURN' });
    expect(next.magic).toBeNull();
  });
});

describe('总资产（施法条件 ahead/behind 依赖）', () => {
  it('totalAssets 可用于比较前后资产', () => {
    const g = newGame(401);
    const a = totalAssets(g, g.players[0]!);
    expect(typeof a).toBe('number');
    expect(a).toBeGreaterThan(0);
  });
});