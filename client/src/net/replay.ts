import { ReplayEngine, type ReplayRecordData } from '@richman/shared';
import type { ReplayRecord } from './auth.js';

export type { ReplayRecordData };

/** 确定性回放会话（逻辑在 shared，UI 层薄封装） */
export class ReplaySession {
  private engine: ReplayEngine;

  constructor(record: ReplayRecord) {
    this.engine = new ReplayEngine(record);
  }

  get totalSteps(): number {
    return this.engine.totalSteps;
  }

  stateAt(step: number): ReturnType<ReplayEngine['stateAt']> {
    return this.engine.stateAt(step);
  }
}
