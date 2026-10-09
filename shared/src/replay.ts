import { applyAction, createGame } from './engine.js';
import { normalizeGameState } from './normalize.js';
import type { DateSerial, GameState, PlayerDef } from './types.js';
import type { PlayerAction } from './types.js';

export interface ReplayRecordData {
  seed: number;
  /**
   * 这局录像里神明是否会随机现身驻留（GOD 现身机制，W2）。
   *
   * **缺省按 false 处理**：现存录像都没有这个标记，而重放必须逐帧复现录制时的轨迹 ——
   * 保守地关掉新机制是唯一安全的读法（开启会让日切多消耗 RNG 抽数，整局就跑偏了）。
   * 写入端：`GameRoom` 结束时存 `boardGods !== null`，服务端 `game_records.spawn_gods` 落列，
   * 客户端 `ReplaySession` 原样透传回这里。
   */
  spawnGods?: boolean;
  /** 起始日期；老记录缺省时引擎用固定常量兜底 */
  startDate?: DateSerial;
  players: Array<{ player_name: string; color: number }>;
  actions: Array<{ turn: number; action: PlayerAction }>;
}

/**
 * 确定性回放：同一 seed + startDate + 动作日志 ⇒ 引擎逐帧复现整局。
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
    // 外部传入的录像记录可能早于某个 GameState 新字段：先补默认值再逐帧复现
    let state = normalizeGameState(
      applyAction(createGame(defs, record.seed, { startDate: record.startDate, spawnGods: record.spawnGods ?? false }), {
        type: 'START_GAME',
      }),
    );
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

