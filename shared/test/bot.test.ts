import { describe, expect, it } from 'vitest';
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

