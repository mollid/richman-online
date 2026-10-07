import { applyAction, createGame } from './engine.js';
import type { GameState, PlayerDef } from './types.js';
import type { PlayerAction } from './types.js';

export interface ReplayRecordData {
  seed: number;
  players: Array<{ player_name: string; color: number }>;
  actions: Array<{ turn: number; action: PlayerAction }>;
}

/**
 * 确定性回放：同一 seed + 动作日志 ⇒ 引擎逐帧复现整局。
 * 引擎的 RNG 状态内嵌于 GameState，动作序列一致则状态完全一致。
 */
export class ReplayEngine {
  readonly record: ReplayRecordData;
  readonly states: GameState[] = [];
  readonly finalState: GameState;

  constructor(record: ReplayRecordData) {
    this.record = record;
    const defs: PlayerDef[] = record.players.map((p, i) => ({
      id: `replay-${i}`,
      name: p.player_name,
      color: p.color,
    }));
    let state = applyAction(createGame(defs, record.seed), { type: 'START_GAME' });
    this.states.push(state);
    for (const entry of record.actions) {
      if (entry.action.type === 'START_GAME') continue; // 已在上面应用
      state = applyAction(state, entry.action);
      this.states.push(state);
    }
    this.finalState = state;
  }

  get totalSteps(): number {
    return this.states.length - 1;
  }

  stateAt(step: number): GameState {
    const clamped = Math.max(0, Math.min(step, this.totalSteps));
    return this.states[clamped] ?? this.states[0]!;
  }
}

