import { applyAction, createGame } from './engine.js';
import { normalizeGameState } from './normalize.js';
import type { DateSerial, GameState, PlayerDef } from './types.js';
import type { PlayerAction } from './types.js';

export interface ReplayRecordData {
  seed: number;
  /** 起始日期；老记录缺省时引擎用固定常量兜底 */
  startDate?: DateSerial;
  /**
   * 建局时的天数上限（W4）。必须随记录一起存：不存的话「到期结算」那一步
   * 在回放里永远不会发生，复现出来的就是另一局。null / 缺省 = 不限。
   */
  maxDays?: number | null;
  /**
   * 建局时的地图（R5-b）。必须随记录一起存：不存的话原版图的回放会复现成自建 64 格环 ——
   * 棋盘都不一样，动作日志再逐字一致也不是那一局。null / 缺省 = 默认图。
   */
  mapId?: number | null;
  /**
   * 座位序即数组下标 —— 回合轮转按座位走，顺序错了整局就串。
   * `player_key` 是局内玩家 id（联机是 sessionId，热座是 local-N）：
   * `SURRENDER` 的复仇者、挂牌的卖家等动作引用的是它，回放必须同名。
   */
  players: Array<{ player_name: string; color: number; player_key?: string | null }>;
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
      // 局内 id 必须与录制时一致，否则动作里引用到玩家 id 的那几类（认输复仇、挂牌成交）会对不上人
      id: p.player_key || `replay-${i}`,
      name: p.player_name,
      color: p.color,
    }));
    // 外部传入的录像记录可能缺字段：先补默认值再逐帧复现
    let state = normalizeGameState(
      applyAction(createGame(defs, record.seed, { startDate: record.startDate, maxDays: record.maxDays ?? null, mapId: record.mapId ?? null }), {
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

