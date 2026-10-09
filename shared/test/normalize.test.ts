import { describe, expect, it } from 'vitest';
import { applyAction, createGame, normalizeGameState } from '../src/index.js';
import type { GameState } from '../src/index.js';
import { GOLDEN_PLAYERS, MONDAY } from './helpers/golden_run.js';

/**
 * `normalizeGameState` 的回归测试。
 *
 * 要守住的是：给 `GameState` 新增字段时，补默认值**只能发生在外部状态流入点**
 * （`normalizeGameState`），且补进去的默认值不得改变局面 —— 它是表现层的兜底，不是规则开关。
 * 老录像本身不做保底（开发阶段没有需要复现的历史数据），但**老热座存档**仍在玩，
 * 缺字段必须照样能跑，且跑出来的与字段本来就齐的局面一致。
 */

function midGame(steps = 12): GameState {
  let state = applyAction(
    createGame(structuredClone(GOLDEN_PLAYERS), 20260105, { startDate: { ...MONDAY } }),
    { type: 'START_GAME' },
  );
  for (let i = 0; i < steps; i++) {
    const mover = state.players[state.currentPlayerIndex]!;
    if (state.phase === 'awaiting_roll') state = applyAction(state, { type: 'ROLL_DICE' });
    else if (state.phase === 'awaiting_action') state = applyAction(state, { type: 'END_TURN' });
    else if (state.phase === 'awaiting_discard') {
      state = applyAction(state, { type: 'DISCARD_CARD', cardId: mover.cards[0]! });
    } else break;
  }
  return state;
}

/** 模拟「重构前存下的存档」：把当时还不存在的键整个删掉 */
function asLegacySave(state: GameState): GameState {
  const legacy = structuredClone(state) as unknown as Record<string, unknown>;
  delete legacy.turnStage;
  return legacy as unknown as GameState;
}

describe('normalizeGameState：老存档 / 老录像的字段兜底', () => {
  it('幂等：补过一次再补不会变', () => {
    const state = midGame();
    const once = normalizeGameState(structuredClone(state));
    const twice = normalizeGameState(structuredClone(once));
    expect(twice).toEqual(once);
  });

  it('新状态本就带齐字段，normalize 不动它', () => {
    const state = midGame();
    const before = structuredClone(state);
    expect(normalizeGameState(state)).toEqual(before);
  });

  it('缺失 turnStage 时按可见相位反推；除该键以外与正常状态完全一致', () => {
    const fresh = midGame();
    const legacy = asLegacySave(fresh);
    expect(legacy.turnStage).toBeUndefined();
    const restored = normalizeGameState(legacy);
    expect(restored.turnStage).toBeDefined();
    // 回合内子阶段不参与规则判定：老存档补完之后的下一步落格，必须与本来就有该键的状态一致
    const next = restored.phase === 'awaiting_roll' ? { type: 'ROLL_DICE' as const } : { type: 'END_TURN' as const };
    const strip = (state: GameState) => {
      const copy = structuredClone(state) as unknown as Record<string, unknown>;
      delete copy.turnStage;
      return JSON.stringify(copy);
    };
    expect(strip(applyAction(restored, next))).toBe(strip(applyAction(structuredClone(fresh), next)));
  });

  it('大厅 / 终局 / 中盘三种相位各得其所', () => {
    const lobby = normalizeGameState(asLegacySave(createGame(structuredClone(GOLDEN_PLAYERS), 1, { startDate: { ...MONDAY } })));
    expect(lobby.turnStage).toBe('start');

    const mid = normalizeGameState(asLegacySave(midGame()));
    expect(['start', 'roll', 'move', 'tile_resolve', 'end']).toContain(mid.turnStage);

    const over = structuredClone(midGame(2));
    over.phase = 'game_over';
    expect(normalizeGameState(asLegacySave(over)).turnStage).toBe('end');
  });
});
