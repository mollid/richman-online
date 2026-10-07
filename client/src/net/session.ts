import type { ChatMessage } from './remote.js';
import { applyAction, createGame, type GameState, type PlayerAction } from '@richman/shared';

/** 会话抽象：本地热座与联机共用同一套 UI */
export interface GameSession {
  getGame(): GameState;
  dispatch(action: PlayerAction): void;
  subscribe(fn: (game: GameState) => void): () => void;
  destroy(): void;
  /** 本人玩家 id；热座模式为 null（所有人共用一台设备轮流操作） */
  readonly myPlayerId: string | null;
  /** 联机房间码；热座为 undefined */
  readonly roomId?: string;
  /** 联机模式由房主触发开局 */
  startGame?(): void;
  /** 联机模式：服务器错误消息订阅 */
  onError?(fn: (message: string) => void): () => void;
  /** 联机模式：聊天 */
  sendChat?(text: string): void;
  onChat?(fn: (messages: ChatMessage[]) => void): () => void;
  /** 联机模式：连接状态变化 */
  onConnectionChange?(fn: (state: 'connected' | 'reconnecting' | 'closed') => void): () => void;
}

/** M1：本地热座会话（所有人共用一台设备轮流操作） */
export class LocalHotseatSession implements GameSession {
  private game: GameState;
  private listeners = new Set<(g: GameState) => void>();
  readonly myPlayerId = null;

  constructor(playerCount: number, seed = Date.now() % 2147483647) {
    const names = ['阿福', '小美', '大宝', '金宝'];
    const colors = [0xef5350, 0x42a5f5, 0x66bb6a, 0xffee58];
    const players = Array.from({ length: playerCount }, (_, i) => ({
      id: `local-${i}`,
      name: names[i]!,
      color: colors[i]!,
    }));
    this.game = applyAction(createGame(players, seed), { type: 'START_GAME' });
  }

  getGame(): GameState {
    return this.game;
  }

  dispatch(action: PlayerAction): void {
    this.game = applyAction(this.game, action);
    for (const fn of this.listeners) fn(this.game);
  }

  subscribe(fn: (g: GameState) => void): () => void {
    this.listeners.add(fn);
    fn(this.game);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    this.listeners.clear();
  }
}


