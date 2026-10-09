import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import {
  addPlayer,
  applyAction,
  availableActions,
  botDecide,
  createGame,
  forceGameOver,
  nextRandom,
  removePlayer,
  resolveMaxDays,
  ONLINE_DEFAULT_MAX_DAYS,
  type DateSerial,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

const PLAYER_COLORS = [0xef5350, 0x42a5f5, 0x66bb6a, 0xffee58];
const DEFAULT_NAMES = ['阿福', '小美', '大宝', '金宝'];
const OFFLINE_AUTO_ACT_DELAY_MS = 3000;
const RECONNECT_TIMEOUT_SEC = 60;

/** 系统时钟 → 日期序列（仅在本文件与 LocalHotseatSession 各读一次） */
function todaySerial(): DateSerial {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** TIME-06：校验客户端上报的起始日期（含真实月长与闰年） */
function isValidDateSerial(d: unknown): d is DateSerial {
  if (!d || typeof d !== 'object') return false;
  const { year, month, day } = d as DateSerial;
  if (!Number.isInteger(year) || year < 1980 || year > 2999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

interface AuthResult {
  userId?: string;
  username?: string;
}

/**
 * 权威对战房间：
 * - 全部规则计算通过 @richman/shared 引擎完成，客户端只负责表现
 * - 每次状态变化后广播完整快照（回合制游戏足够，后续可优化为增量同步）
 * - 内置聊天、断线重连（60s 窗口）与掉线托管、账号绑定与战绩入库
 */
export class GameRoom extends Room {
  maxClients = 4;
  private game!: GameState;
  private autoActTimer: ReturnType<typeof setTimeout> | null = null;
  private seed = 0;
  private startDate!: DateSerial;
  private recordSaved = false;
  private userIds = new Map<string, string>();
  private actionLog: Array<{ turn: number; action: PlayerAction }> = [];
  private botIds = new Set<string>();
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private botRngState = 1;
  private botCounter = 0;

  /** 携带 token 的玩家绑定账号，其余以游客身份进入 */
  async onAuth(_client: Client, options: { token?: string }): Promise<AuthResult | boolean> {
    const token = (options.token ?? '').trim();
    if (!token) return true;
    try {
      const { getSessionUser } = await import('../storage.js');
      const user = await getSessionUser(token);
      if (!user) return true; // token 无效时降级为游客，不阻断进入房间
      return { userId: user.id, username: user.username };
    } catch {
      return true;
    }
  }

  onCreate(options: { seed?: number; maxPlayers?: number; startDate?: DateSerial; maxDays?: number | null }) {
    this.maxClients = Math.min(Math.max(options.maxPlayers ?? 4, 2), 4);
    this.seed = options.seed ?? Date.now() % 2147483647;
    this.botRngState = this.seed;
    this.startDate = isValidDateSerial(options.startDate) ? options.startDate : todaySerial();
    // CORE-04 / 玩法文档 §14 第 2 项：联机默认打满 60 天就按总资产结算，长局收得了口。
    // 房主显式传 0 / null 才是「不限天数」；没传这个参数时用默认值，而不是当成不限。
    this.game = createGame([], this.seed, {
      startDate: this.startDate,
      maxDays: options.maxDays === undefined ? ONLINE_DEFAULT_MAX_DAYS : resolveMaxDays(options.maxDays),
    });
    this.updateMetadata('lobby');

    this.onMessage('add_bot', (client) => {
      try {
        if (this.game.phase !== 'lobby') throw new Error('对局已开始，无法添加 AI');
        if (this.game.players.length >= this.maxClients) throw new Error('房间已满');
        const BOT_NAMES = ['阿智', '小灵', '阿巧'];
        const idx = this.game.players.length;
        const botId = `bot-${idx}-${this.botCounter++}`;
        this.game = addPlayer(this.game, {
          id: botId,
          name: `AI·${BOT_NAMES[(idx - 1 + BOT_NAMES.length) % BOT_NAMES.length]!}`,
          color: PLAYER_COLORS[idx % PLAYER_COLORS.length]!,
        });
        this.botIds.add(botId);
        this.updateMetadata('lobby');
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onMessage('start_game', (client) => {
      try {
        this.game = applyAction(this.game, { type: 'START_GAME' });
        this.actionLog.push({ turn: this.game.turn, action: { type: 'START_GAME' } });
        this.updateMetadata('playing');
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onMessage('get_state', (client) => {
      client.send('state', { game: this.game, actions: availableActions(this.game) });
    });

    // 测试模式钩子（仅 RICHMAN_TEST_MODE=1 时注册）：走真实 game_over/战绩流程
    if (process.env.RICHMAN_TEST_MODE === '1') {
      this.onMessage('test_finish', (client) => {
        this.game = forceGameOver(this.game, client.sessionId);
        this.broadcastState();
      });
    }

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
        this.actionLog.push({ turn: this.game.turn, action: message.action });
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });
  }

  onJoin(client: Client, options: { name?: string }, auth?: AuthResult) {
    if (this.game.phase !== 'lobby') {
      throw new Error('对局已开始，无法加入');
    }
    const index = this.game.players.length;
    if (auth?.userId) this.userIds.set(client.sessionId, auth.userId);
    const rawName = (auth?.username ?? options.name ?? '').trim().slice(0, 8);
    this.game = addPlayer(this.game, {
      id: client.sessionId,
      name: rawName || DEFAULT_NAMES[index % DEFAULT_NAMES.length]!,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length]!,
    });
    this.updateMetadata('lobby');
    this.broadcastState();
  }

  async onLeave(client: Client, consented: boolean) {
    // 显式退出（consented）不保留重连；异常断开（刷新/断网）保留窗口，
    // 否则房间会被立即 dispose，旧连接后续推送全部报
    // 「room has been disposed」，客户端表现为联机失败。
    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_TIMEOUT_SEC);
      } catch {
        // 重连超时或期间无重连：走下面的正常离场流程
      }
    }

    if (this.game.phase === 'lobby') {
      this.game = removePlayer(this.game, client.sessionId);
      this.userIds.delete(client.sessionId);
      this.updateMetadata('lobby');
      this.broadcastState();
      return;
    }

    this.setOnline(client.sessionId, false);
    this.scheduleAutoAct();
  }

  onDispose() {
    if (this.autoActTimer) clearTimeout(this.autoActTimer);
    if (this.botTimer) clearTimeout(this.botTimer);
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
    const actingId = this.actingPlayerId();
    if (!actingId || actingId !== client.sessionId) {
      throw new Error(this.game.phase === 'awaiting_auction' ? '还没轮到你出价' : '还没轮到你操作');
    }
  }

  /** 当前应行动的玩家：拍卖会由竞买人轮流主拍，其余情况为当前回合玩家 */
  private actingPlayerId(): string | null {
    if (this.game.phase === 'awaiting_auction') {
      const a = this.game.auction;
      return a ? a.bidders[a.turnIndex] ?? null : null;
    }
    return this.game.players[this.game.currentPlayerIndex]?.id ?? null;
  }

  private scheduleAutoAct() {
    if (this.autoActTimer) return;
    this.autoActTimer = setTimeout(() => {
      this.autoActTimer = null;
      this.autoActForOffline();
    }, OFFLINE_AUTO_ACT_DELAY_MS);
  }

  /** 掉线玩家托管：拍卖里弃权退出，其余自动掷骰 + 结束回合 */
  private autoActForOffline() {
    if (this.game.phase === 'awaiting_auction') {
      const bidder = this.actingPlayerId();
      const p = bidder ? this.game.players.find((q) => q.id === bidder) : undefined;
      if (!p || p.online) return;
      // 不在场的人不该留在竞价轮次里：PASS 会保留资格，于是每一轮都要等他一个
      // `OFFLINE_AUTO_ACT_DELAY_MS`；直接弃权退出，拍卖立刻能往下走。
      // 但他若已是最高出价者就不能弃权（已经是要付钱的人），那时只能让过。
      const canGiveUp = this.game.auction && this.game.auction.highestBidderId !== bidder;
      try {
        const action = canGiveUp ? { type: 'AUCTION_GIVE_UP' as const } : { type: 'AUCTION_PASS' as const };
        this.game = applyAction(this.game, action);
        this.actionLog.push({ turn: this.game.turn, action });
        this.broadcastState();
        this.scheduleAutoAct();
      } catch {
        // 托管失败忽略，等待下一轮调度
      }
      return;
    }
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
      this.trySaveRecord();
    }
    this.broadcast('state', { game: this.game, actions: availableActions(this.game) });
    this.maybeScheduleBotAct();
  }

  /** 若当前行动者是 AI，安排其行动 */
  private maybeScheduleBotAct() {
    if (this.botTimer) return;
    if (this.game.phase === 'lobby' || this.game.phase === 'game_over') return;
    const actingId = this.actingPlayerId();
    if (!actingId || !this.botIds.has(actingId)) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.botAct();
    }, 700);
  }

  /** 执行一次 AI 动作（动作会进入 actionLog，因此回放完全一致） */
  private botAct() {
    if (this.game.phase === 'lobby' || this.game.phase === 'game_over') return;
    const actingId = this.actingPlayerId();
    if (!actingId || !this.botIds.has(actingId)) return;
    const rng = () => {
      const draw = nextRandom(this.botRngState);
      this.botRngState = draw.nextState;
      return draw.value;
    };
    const action = botDecide(this.game, actingId, rng);
    if (!action) return;
    try {
      this.game = applyAction(this.game, action);
      this.actionLog.push({ turn: this.game.turn, action });
      this.broadcastState();
    } catch (e) {
      // 决策与规则冲突时降级为结束回合，避免 AI 卡死
      if (this.game.phase === 'awaiting_action') {
        this.game = applyAction(this.game, { type: 'END_TURN' });
        this.actionLog.push({ turn: this.game.turn, action: { type: 'END_TURN' } });
        this.broadcastState();
      } else {
        console.warn('[bot] 决策执行失败:', e instanceof Error ? e.message : e);
      }
    }
  }

  /** 对局结束后写入战绩（尽力而为，不阻塞广播） */
  private trySaveRecord(): void {
    if (this.recordSaved) return;
    this.recordSaved = true;
    const winner = this.game.players.find((p) => p.id === this.game.winnerId);
    void import('../storage.js').then(({ saveGameRecord }) =>
      saveGameRecord({
        roomId: this.roomId,
        seed: this.seed,
        startDate: this.startDate,
        winnerName: winner?.name ?? null,
        turns: this.game.turn,
        rounds: this.game.round,
        actions: this.actionLog,
        players: this.game.players.map((p) => ({
          userId: this.userIds.get(p.id) ?? null,
          playerName: p.name,
          color: p.color,
          cash: p.cash,
          bankrupt: p.bankrupt,
        })),
      }),
    );
  }
}


