import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import {
  addPlayer,
  applyAction,
  availableActions,
  createGame,
  removePlayer,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

const PLAYER_COLORS = [0xef5350, 0x42a5f5, 0x66bb6a, 0xffee58];
const DEFAULT_NAMES = ['阿福', '小美', '大宝', '金宝'];
const OFFLINE_AUTO_ACT_DELAY_MS = 3000;
const RECONNECT_TIMEOUT_SEC = 60;

/**
 * 权威对战房间：
 * - 全部规则计算通过 @richman/shared 引擎完成，客户端只负责表现
 * - 每次状态变化后广播完整快照（回合制游戏足够，后续可优化为增量同步）
 * - 内置聊天、断线重连（20s 窗口）与掉线托管
 */
export class GameRoom extends Room {
  maxClients = 4;
  private game!: GameState;
  private autoActTimer: ReturnType<typeof setTimeout> | null = null;

  onCreate(options: { seed?: number; maxPlayers?: number }) {
    this.maxClients = Math.min(Math.max(options.maxPlayers ?? 4, 2), 4);
    this.game = createGame([], options.seed ?? Date.now() % 2147483647);
    this.updateMetadata('lobby');

    this.onMessage('start_game', (client) => {
      try {
        this.game = applyAction(this.game, { type: 'START_GAME' });
        this.updateMetadata('playing');
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onMessage('get_state', (client) => {
      client.send('state', { game: this.game, actions: availableActions(this.game) });
    });

    this.onMessage('chat', (client, message: { text?: unknown }) => {
      const text = typeof message.text === 'string' ? message.text.trim().slice(0, 120) : '';
      if (!text) return;
      const player = this.game.players.find((p) => p.id === client.sessionId);
      this.broadcast('chat', {
        fromId: client.sessionId,
        fromName: player?.name ?? '未知玩家',
        text,
      });
    });

    this.onMessage('action', (client, message: { action: PlayerAction }) => {
      try {
        if (message.action.type !== 'START_GAME') {
          this.assertCurrentPlayer(client);
        }
        this.game = applyAction(this.game, message.action);
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });
  }

  onJoin(client: Client, options: { name?: string }) {
    if (this.game.phase !== 'lobby') {
      throw new Error('对局已开始，无法加入');
    }
    const index = this.game.players.length;
    const rawName = (options.name ?? '').trim().slice(0, 8);
    this.game = addPlayer(this.game, {
      id: client.sessionId,
      name: rawName || DEFAULT_NAMES[index % DEFAULT_NAMES.length]!,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length]!,
    });
    this.updateMetadata('lobby');
    this.broadcastState();
  }

  async onLeave(client: Client, consented: boolean) {
    if (this.game.phase === 'lobby') {
      this.game = removePlayer(this.game, client.sessionId);
      this.updateMetadata('lobby');
      this.broadcastState();
      return;
    }

    this.setOnline(client.sessionId, false);

    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_TIMEOUT_SEC);
        this.setOnline(client.sessionId, true);
        return;
      } catch {
        // 重连超时：保持离线，交给托管
      }
    }
    this.scheduleAutoAct();
  }

  onDispose() {
    if (this.autoActTimer) clearTimeout(this.autoActTimer);
  }

  private setOnline(sessionId: string, online: boolean) {
    const p = this.game.players.find((q) => q.id === sessionId);
    if (p) p.online = online;
    this.broadcastState();
  }

  /** 更新房间元数据（供大厅房间列表展示与过滤） */
  private updateMetadata(phase: 'lobby' | 'playing' | 'finished') {
    void this.setMetadata({
      phase,
      players: this.game.players.length,
      maxPlayers: this.maxClients,
    });
  }

  private assertCurrentPlayer(client: Client) {
    const current = this.game.players[this.game.currentPlayerIndex];
    if (!current || current.id !== client.sessionId) {
      throw new Error('还没轮到你操作');
    }
  }

  private scheduleAutoAct() {
    if (this.autoActTimer) return;
    this.autoActTimer = setTimeout(() => {
      this.autoActTimer = null;
      this.autoActForOffline();
    }, OFFLINE_AUTO_ACT_DELAY_MS);
  }

  /** 掉线玩家托管：自动掷骰 + 结束回合 */
  private autoActForOffline() {
    if (this.game.phase !== 'awaiting_roll' && this.game.phase !== 'awaiting_action') return;
    const current = this.game.players[this.game.currentPlayerIndex];
    if (!current || current.online) return;
    try {
      this.game = applyAction(this.game, { type: 'ROLL_DICE' });
      if (this.game.phase === 'awaiting_action') {
        const still = this.game.players[this.game.currentPlayerIndex];
        if (still && !still.online) {
          this.game = applyAction(this.game, { type: 'END_TURN' });
        }
      }
      this.broadcastState();
      const next = this.game.players[this.game.currentPlayerIndex];
      if (next && !next.online && this.game.phase !== 'game_over') {
        this.scheduleAutoAct();
      }
    } catch {
      // 托管失败忽略，等待下一轮调度
    }
  }

  private sendError(client: Client, e: unknown) {
    const message = e instanceof Error ? e.message : '非法操作';
    client.send('error', { message });
  }

  private broadcastState() {
    if (this.game.phase === 'game_over' && this.metadata?.phase !== 'finished') {
      this.updateMetadata('finished');
    }
    this.broadcast('state', { game: this.game, actions: availableActions(this.game) });
  }
}

