import { Client, type Room } from 'colyseus.js';
import { availableActions, type GameState, type PlayerAction } from '@richman/shared';
import type { GameSession } from './session.js';

export interface RemoteSnapshot {
  game: GameState;
  actions: ReturnType<typeof availableActions>;
}

/** M3：联机会话（连接 Colyseus 权威服务器，接收快照广播） */
export class ColyseusSession implements GameSession {
  private room: Room<unknown>;
  private game: GameState;
  private listeners = new Set<(g: GameState) => void>();
  private messageHandlers = new Set<(message: string) => void>();

  constructor(room: Room<unknown>, initialGame: GameState) {
    this.room = room;
    this.game = initialGame;

    room.onMessage<RemoteSnapshot>('state', (snapshot) => {
      this.game = snapshot.game;
      for (const fn of this.listeners) fn(this.game);
    });

    room.onMessage<{ message: string }>('error', (message) => {
      for (const fn of this.messageHandlers) fn(message.message);
    });

    // 主动拉取一次当前状态，避免错过加入时的首次广播
    room.send('get_state', {});
  }

  /** 创建或加入房间并建立会话 */
  static async connect(opts: {
    serverUrl?: string;
    playerName: string;
    roomId?: string;
    seed?: number;
  }): Promise<ColyseusSession> {
    const envUrl = (import.meta.env?.VITE_SERVER_URL as string | undefined) ?? undefined;
    const serverUrl = opts.serverUrl ?? envUrl ?? `ws://${window.location.hostname}:2567`;
    const client = new Client(serverUrl);
    const room = opts.roomId
      ? await client.joinById(opts.roomId, { name: opts.playerName })
      : await client.create('game', { name: opts.playerName, seed: opts.seed });
    const placeholder: GameState = {
      players: [],
      board: [],
      currentPlayerIndex: 0,
      phase: 'lobby',
      dice: null,
      turn: 0,
      round: 1,
      rngState: 0,
      log: [{ turn: 0, text: '正在同步房间状态…' }],
      winnerId: null,
      stockMarket: { stocks: [] },
      pendingFixedDice: null,
    };
    return new ColyseusSession(room, placeholder);
  }

  get myPlayerId(): string | null {
    return this.room.sessionId;
  }

  get roomId(): string {
    return this.room.roomId;
  }

  getGame(): GameState {
    return this.game;
  }

  dispatch(action: PlayerAction): void {
    this.room.send('action', { action });
  }

  startGame(): void {
    this.room.send('start_game', {});
  }

  onError(fn: (message: string) => void): () => void {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  subscribe(fn: (g: GameState) => void): () => void {
    this.listeners.add(fn);
    fn(this.game);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    this.listeners.clear();
    void this.room.leave(true);
  }
}
