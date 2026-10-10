import { describe, expect, it } from 'vitest';
import { atLegacyStart } from './helpers/state.js';
import { applyAction, botDecide, createGame } from '../src/index.js';
import type { PlayerAction } from '../src/index.js';

const BOTS = [
  { id: 'b1', name: 'AI·阿智', color: 0xaaaaaa },
  { id: 'b2', name: 'AI·小灵', color: 0xbbbbbb },
];

describe('M9 AI 托管决策', () => {
  it('现金充裕时买地', () => {
    let g = applyAction(createGame(BOTS, 401), { type: 'START_GAME' });
    g.players[0]!.position = 4; // 成都路 ¥350
    g.phase = 'awaiting_action';
    const action = botDecide(g, 'b1', () => 0.5);
    expect(action).toEqual({ type: 'BUY_LAND' });
  });

  it('现金低于安全垫时放弃买地，结束回合', () => {
    let g = applyAction(createGame(BOTS, 403), { type: 'START_GAME' });
    g.players[0]!.position = 4;
    g.players[0]!.cash = 2000; // 350+2000 安垫不够
    g.phase = 'awaiting_action';
    const action = botDecide(g, 'b1', () => 0.5);
    expect(action).toEqual({ type: 'END_TURN' });
  });

  it('自家地产现金充裕时升级', () => {
    let g = applyAction(createGame(BOTS, 405), { type: 'START_GAME' });
    g.players[0]!.position = 4;
    g.players[0]!.properties = [{ cellId: 4, grade: 1 }];
    g.phase = 'awaiting_action';
    const action = botDecide(g, 'b1', () => 0.5);
    expect(action).toEqual({ type: 'UPGRADE_LAND' });
  });

  it('掷骰阶段直接掷骰；附穷神且持送神卡先送神', () => {
    let g = applyAction(createGame(BOTS, 407), { type: 'START_GAME' });
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'ROLL_DICE' });
    g.players[0]!.god = { godId: 'small-poverty', remainingDays: 3 };
    g.players[0]!.cards = ['send-god'];
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'USE_CARD', cardId: 'send-god' });
  });

  it('猜杯阶段按 rng 选杯（0-2）', () => {
    let g = applyAction(createGame(BOTS, 409), { type: 'START_GAME' });
    g.players[0]!.position = 17;
    g.phase = 'awaiting_pick';
    g.minigame = { kind: 'shells', round: 0, hits: [], symbols: [], revealed: [], matched: [], flips: 0 };
    const action = botDecide(g, 'b1', () => 0.99) as PlayerAction & { hole: number };
    expect(action.type).toBe('MINIGAME_PICK');
    expect(action.hole).toBe(2);
  });

  it('记忆翻牌只翻「还没翻开、也未配对」的牌', () => {
    let g = applyAction(createGame(BOTS, 413), { type: 'START_GAME' });
    g.players[0]!.position = 17;
    g.phase = 'awaiting_pick';
    g.minigame = {
      kind: 'memory',
      round: 0,
      hits: [],
      symbols: [7, 3, 3, 1, 8, 2, 5, 9],
      revealed: [0],
      matched: [false, true, true, false, false, false, false, false],
      flips: 3,
    };
    // 旧实现一律猜 0-2 号「杯」：这游戏是 8 张牌，0 号已翻开、1、2 号已配对，
    // 每次都被引擎以「这张牌不能翻」拒绝，而兜底只在 awaiting_action 下结束回合
    // ⇒ 整局卡在 awaiting_pick（实测一局两千多个被吞错误）。
    for (const roll of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      const action = botDecide(g, 'b1', () => roll) as PlayerAction & { hole: number };
      expect(action.type).toBe('MINIGAME_PICK');
      expect([0, 1, 2]).not.toContain(action.hole);
      expect(action.hole).toBeGreaterThanOrEqual(0);
      expect(action.hole).toBeLessThan(8);
    }
  });

  it('一张都翻不动时不再产出必然被拒的动作', () => {
    let g = applyAction(createGame(BOTS, 415), { type: 'START_GAME' });
    g.players[0]!.position = 17;
    g.phase = 'awaiting_pick';
    g.minigame = {
      kind: 'memory',
      round: 0,
      hits: [],
      symbols: [1, 1, 2, 2, 3, 3, 4, 4],
      revealed: [],
      matched: [true, true, true, true, true, true, true, true],
      flips: 6,
    };
    expect(botDecide(g, 'b1', () => 0.5)).toBeNull();
  });

  it('非本方回合返回 null', () => {
    let g = applyAction(createGame(BOTS, 411), { type: 'START_GAME' });
    expect(botDecide(g, 'b2', () => 0.5)).toBeNull();
    expect(botDecide(g, 'ghost', () => 0.5)).toBeNull();
  });
});

/**
 * CORP-14：AI 也会用股市转手原始股。
 *
 * 只钉一条纪律 —— **救急变现**：现金见底才卖，而且不动经营权在自己手里的那家，
 * 卖的数量还必须被引擎接受（门控与引擎同源，bot 身上也一样成立）。
 */
describe('M9 AI 原始股变现（CORP-14）', () => {
  /** 造一个「b1 回合内、站在起点、脚下无事可做」的局面，持股与现金按参数填 */
  function setup(cash: number, opts: { shares?: number; locked?: number; mine?: boolean } = {}) {
    const g = applyAction(createGame(BOTS, 421, { startDate: { year: 2026, month: 1, day: 5 } }), {
      type: 'START_GAME',
    });
    atLegacyStart(g); // SP-01 出生点随机：夹具要的是「脚下无事可做」，钉回起点才是那个局面
    const comp = g.companies.find((c) => c.cellId === 43)!; // 电脑公司，面值 ¥400
    comp.shares.b1 = opts.shares ?? 10;
    comp.firstHeldDayIndex.b1 = 0;
    comp.lockedShares = opts.locked ? { b1: opts.locked } : {};
    comp.chairmanId = opts.mine === false ? 'b2' : opts.mine ? 'b1' : null;
    g.players[0]!.cash = cash;
    g.phase = 'awaiting_action';
    return g;
  }

  it('现金告急：按面值把已解锁的原始股全数卖回股市', () => {
    const g = setup(1200, { mine: false });
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'SELL_SHARES', cellId: 43, quantity: 10 });
  });

  it('经营权还在自己手里就不卖：董事长免付费比一次性现金值钱', () => {
    const g = setup(1200, { mine: true });
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'END_TURN' });
  });

  it('还在锁定期的持股不会产出必然被拒的动作', () => {
    const g = setup(1200, { locked: 10, mine: false });
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'END_TURN' });
  });

  it('现金充裕时不变现（那是救急线，不是理财策略）', () => {
    const g = setup(15000, { mine: false });
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'END_TURN' });
  });

  it('多家持股时先卖最值钱的那家', () => {
    const g = setup(1200, { mine: false }); // 电脑公司 10 张 = ¥4,000
    const oil = g.companies.find((c) => c.cellId === 59)!; // 石油公司，面值 ¥420
    oil.shares.b1 = 12; // 12 张 = ¥5,040 ⇒ 更该先动
    oil.firstHeldDayIndex.b1 = 0;
    oil.chairmanId = null;
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'SELL_SHARES', cellId: 59, quantity: 12 });
  });
});

