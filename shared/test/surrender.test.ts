import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  createGame,
  DEATH_DURATION_DAYS,
  unluckyMultiplier,
  type GameState,
  type PlayerDef,
} from '../src/index.js';
import { atLegacyStart, pinIndexOne } from './helpers/state.js';

/**
 * UI-13 认输投降 + GOD-12 死神效果（对标 help[13]、help[51]、文档 UI-13 与 GOD-12）。
 *
 * 原版依据：
 * - help[13]「認輸投降：…魔法屋的女巫會替您召喚死神，附身在**您指定的人**身上」
 * - help[51]「死神附身時，不但會遺失所有卡片道具，還會發生一連串倒楣的事情。為期十三天」
 * - GOD-12 死神：遗失所有卡片道具 + 一连串倒霉事，13 天后自动消失
 *
 * 本组用例固化：认输者**指定**一位复仇者后干净退出，死神落在该复仇者身上，
 * 其全部卡牌道具被清空并进入 13 天霉运加倍状态。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  return atLegacyStart(applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' }));
}

/** 让指定玩家持有卡牌与道具，便于验证被清空 */
function arm(p: GameState, playerId: string, cards = 3, items = 2): GameState {
  const target = p.players.find((q) => q.id === playerId)!;
  target.cards = Array.from({ length: cards }, () => 'angel');
  target.items = { teleporter: items };
  return p;
}

describe('UI-13 认输：指定复仇者时死神不落在自己头上', () => {
  it('认输者干净退出（不承受死神惩罚）', () => {
    const g = arm(pinIndexOne(newGame()), 'p1', 3, 2);
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    const me = r.players[0]!;
    expect(me.bankrupt).toBe(true);
    expect(me.god).toBeNull();
    expect(me.unlucky).toBeNull();
  });

  it('死神附身于复仇者：清空其全部卡片与道具', () => {
    const g = pinIndexOne(newGame());
    arm(g, 'p2', 4, 3);
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    const avenger = r.players[1]!;
    expect(avenger.cards).toEqual([]);
    expect(avenger.items).toEqual({});
    expect(avenger.god?.godId).toBe('death');
    expect(r.log.some((l) => l.text.includes('复仇者'))).toBe(true);
  });

  it('复仇者进入 13 天霉运且倍率加倍', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p3' });
    const avenger = r.players[2]!;
    expect(avenger.unlucky).not.toBeNull();
    expect(avenger.unlucky!.daysLeft).toBe(DEATH_DURATION_DAYS);
    expect(avenger.unlucky!.multiplier).toBe(2);
    expect(unluckyMultiplier(avenger)).toBe(2);
    // 死神本体同样 13 天
    expect(avenger.god?.remainingDays).toBe(DEATH_DURATION_DAYS);
  });

  it('必须指定复仇者：缺省时拒绝认输', () => {
    const g = arm(pinIndexOne(newGame()), 'p1', 2, 1);
    g.phase = 'awaiting_action';
    // @ts-expect-error 故意缺省 revengeTargetId 验证运行时校验
    expect(() => applyAction(g, { type: 'SURRENDER' })).toThrow('复仇者');
  });

  it('非法复仇者被拒（不存在 / 自己 / 已倒闭）', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'SURRENDER', revengeTargetId: 'nobody' })).toThrow('复仇者不存在');
    expect(() => applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p1' })).toThrow('不能是认输者本人');
    g.players[2]!.bankrupt = true;
    expect(() => applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p3' })).toThrow('已倒闭');
  });

  it('两人局：认输者出局后另一人获胜', () => {
    const two = applyAction(createGame([PLAYERS[0]!, PLAYERS[1]!], 5, { startDate: { ...MONDAY } }), {
      type: 'START_GAME',
    });
    const r = applyAction(two, { type: 'SURRENDER', revengeTargetId: 'p2' });
    expect(r.phase).toBe('game_over');
    expect(r.winnerId).toBe('p2');
  });
});

describe('GOD-12 霉运的实效', () => {
  it('霉运期间过路费被抬高 2 倍', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    const avenger = r.players[1]!;
    expect(avenger.unlucky!.multiplier).toBe(2);
    // 租金计算入口应用了 unluckyMultiplier
    expect(unluckyMultiplier(avenger)).toBeGreaterThan(1);
    expect(r.log.some((l) => l.text.includes('复仇者'))).toBe(true);
  });

  it('无霉运时倍率为 1', () => {
    const g = newGame(7);
    expect(unluckyMultiplier(g.players[0]!)).toBe(1);
    expect(g.players[0]!.unlucky).toBeNull();
  });

  it('霉运在 13 天后自动清除', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    let s = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    expect(s.players[1]!.unlucky).not.toBeNull();
    // 推进若干天让霉运到期（死神 13 天到期后自动消失）
    for (let i = 0; i < 13 * 3 + 20; i++) {
      if (s.phase === 'game_over') break;
      if (s.phase === 'awaiting_roll') s = applyAction(s, { type: 'ROLL_DICE' });
      else if (s.phase === 'awaiting_action') s = applyAction(s, { type: 'END_TURN' });
      else if (s.phase === 'awaiting_pick') s = applyAction(s, { type: 'MINIGAME_PICK', hole: 0 });
      else if (s.phase === 'awaiting_discard') s = applyAction(s, { type: 'DISCARD_CARD', cardId: s.players[s.currentPlayerIndex]!.cards[0]! });
      else break;
    }
    expect(s.players[1]!.unlucky).toBeNull();
    expect(unluckyMultiplier(s.players[1]!)).toBe(1);
  });
});

describe('UI-13 复仇者候选', () => {
  it('对局中暴露存活且非自己的候选', () => {
    const g = newGame(11);
    const acts = availableActions(g);
    expect(acts.canSurrender).toBe(true);
    expect(acts.revengeCandidates.map((c) => c.id)).toEqual(['p2', 'p3']);
  });

  it('大厅 / 游戏结束时候选为空', () => {
    const lobby = createGame(PLAYERS, 13);
    expect(availableActions(lobby).revengeCandidates).toEqual([]);
    const over = newGame(13);
    over.phase = 'game_over';
    expect(availableActions(over).revengeCandidates).toEqual([]);
  });

  it('已倒闭玩家不会成为候选', () => {
    const g = newGame(15);
    g.players[2]!.bankrupt = true;
    expect(availableActions(g).revengeCandidates.map((c) => c.id)).toEqual(['p2']);
  });
});
