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

  it('掷骰阶段直接掷骰；停留且有天使卡先用卡', () => {
    let g = applyAction(createGame(BOTS, 407), { type: 'START_GAME' });
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'ROLL_DICE' });
    g.players[0]!.skipTurns = 1;
    g.players[0]!.cards = ['angel'];
    expect(botDecide(g, 'b1', () => 0.5)).toEqual({ type: 'USE_CARD', cardId: 'angel' });
  });

  it('猜杯阶段按 rng 选杯（0-2）', () => {
    let g = applyAction(createGame(BOTS, 409), { type: 'START_GAME' });
    g.players[0]!.position = 17;
    g.phase = 'awaiting_pick';
    g.minigame = { round: 0, hits: [] };
    const action = botDecide(g, 'b1', () => 0.99) as PlayerAction & { hole: number };
    expect(action.type).toBe('MINIGAME_PICK');
    expect(action.hole).toBe(2);
  });

  it('非本方回合返回 null', () => {
    let g = applyAction(createGame(BOTS, 411), { type: 'START_GAME' });
    expect(botDecide(g, 'b2', () => 0.5)).toBeNull();
    expect(botDecide(g, 'ghost', () => 0.5)).toBeNull();
  });
});
