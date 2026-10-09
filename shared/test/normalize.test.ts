import { describe, expect, it } from 'vitest';
import { applyAction, createGame, normalizeGameState } from '../src/index.js';
import type { GameState } from '../src/index.js';
import { GOLDEN_PLAYERS, MONDAY } from './helpers/golden_run.js';

/**
 * 回放兼容铁律的回归测试。
 *
 * 铁律：给 `GameState` 新增字段时，**字段缺失必须等价于「该机制未启用」**，且补默认值
 * 只能发生在外部状态流入点（`normalizeGameState`）。否则重构前存下的热座存档、录下的
 * 录像，在新引擎里会走出另一条轨迹 —— 老录像不能再逐帧复现，也没有任何测试会提醒你我。
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
