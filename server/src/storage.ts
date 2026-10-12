import pg from 'pg';
import Redis from 'ioredis';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { DateSerial } from '@richman/shared';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';

export const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
export const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

export const storageReady = { pg: false, redis: false };

const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

export interface UserRow {
  id: string;
  username: string;
  created_at: Date;
}

export async function initStorage(): Promise<void> {
  if (pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username VARCHAR(16) NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS game_records (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          room_id VARCHAR(32) NOT NULL,
          seed INT NOT NULL,
          start_date JSONB,
          winner_name VARCHAR(16),
          player_count INT NOT NULL,
          turns INT NOT NULL,
          rounds INT NOT NULL,
          actions JSONB NOT NULL DEFAULT '[]'::jsonb,
          finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE game_records ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE game_records ADD COLUMN IF NOT EXISTS start_date JSONB;
        CREATE TABLE IF NOT EXISTS game_record_players (
          record_id UUID NOT NULL REFERENCES game_records(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id),
          player_name VARCHAR(16) NOT NULL,
          color INT NOT NULL DEFAULT 16777215,
          cash INT NOT NULL,
          bankrupt BOOLEAN NOT NULL
        );
        ALTER TABLE game_record_players ADD COLUMN IF NOT EXISTS color INT NOT NULL DEFAULT 16777215;
        -- 回放要能逐帧复现，光有动作序列不够，还得存下「这局是怎么建起来的」：
        --   max_days    天数上限（W4）：不存的话到期结算那一步在回放里永远不会发生
        --   seat        座位序：回合轮转、并列决胜都按座位走，按名字排会串位
        --   player_key  局内玩家 id：SURRENDER / 挂牌等动作引用的是这个 id，回放必须同名
        ALTER TABLE game_records ADD COLUMN IF NOT EXISTS max_days INT;
        --   map_id      本局跑的是哪张图（null = 自建 64 格环）：不存的话原版图的回放会复现成默认图
        ALTER TABLE game_records ADD COLUMN IF NOT EXISTS map_id INT;
        ALTER TABLE game_record_players ADD COLUMN IF NOT EXISTS seat INT NOT NULL DEFAULT 0;
        ALTER TABLE game_record_players ADD COLUMN IF NOT EXISTS player_key VARCHAR(64);
        CREATE INDEX IF NOT EXISTS idx_records_finished ON game_records(finished_at DESC);
        CREATE INDEX IF NOT EXISTS idx_record_players_user ON game_record_players(user_id);
      `);
      storageReady.pg = true;
      console.log('[storage] PostgreSQL 已连接，账号与战绩已启用');
    } catch (e) {
      console.warn('[storage] PostgreSQL 不可用，账号/战绩将以游客模式运行:', e instanceof Error ? e.message : e);
    }
  } else {
    console.warn('[storage] 未配置 DATABASE_URL，跳过持久化');
  }

  if (redis) {
    try {
      await redis.ping();
      storageReady.redis = true;
      console.log('[storage] Redis 已连接，会话缓存已启用');
    } catch (e) {
      console.warn('[storage] Redis 不可用，会话将不可用:', e instanceof Error ? e.message : e);
    }
  }
}

export function validateCredentials(username: unknown, password: unknown): { username: string; password: string } | null {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const name = username.trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(name)) return null;
  if (password.length < 6 || password.length > 64) return null;
  return { username: name, password };
}

export async function createUser(username: string, password: string): Promise<UserRow | null> {
  if (!pool) throw new Error('服务未连接数据库');
  const hash = await bcrypt.hash(password, 10);
  try {
    const res = await pool.query<UserRow>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username, hash],
    );
    return res.rows[0] ?? null;
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === '23505') {
      throw new Error('用户名已被占用');
    }
    throw e;
  }
}

export async function findUserByUsername(username: string): Promise<(UserRow & { password_hash: string }) | null> {
  if (!pool) return null;
  const res = await pool.query<UserRow & { password_hash: string }>(
    'SELECT id, username, created_at, password_hash FROM users WHERE username = $1',
    [username],
  );
  return res.rows[0] ?? null;
}

export async function createSession(userId: string): Promise<string | null> {
  if (!redis) return null;
  const token = randomUUID();
  await redis.set(`session:${token}`, userId, 'EX', SESSION_TTL_SEC);
  return token;
}

export async function getSessionUser(token: string): Promise<UserRow | null> {
  if (!redis || !pool) return null;
  const userId = await redis.get(`session:${token}`);
  if (!userId) return null;
  const res = await pool.query<UserRow>('SELECT id, username, created_at FROM users WHERE id = $1', [userId]);
  return res.rows[0] ?? null;
}

export async function destroySession(token: string): Promise<void> {
  if (!redis) return;
  await redis.del(`session:${token}`);
}

export interface GameRecordInput {
  roomId: string;
  seed: number;
  /** 起始日期（确定性回放基线） */
  startDate: DateSerial;
  winnerName: string | null;
  turns: number;
  rounds: number;
  /** 回放动作日志（含 START_GAME），引擎确定性回放用 */
  actions: Array<{ turn: number; action: unknown }>;
  /** 天数上限（W4）：建局参数之一，不存就复现不出到期结算 */
  maxDays: number | null;
  /** 本局地图（null = 自建 64 格环）：不存就复现成另一张棋盘 */
  mapId: number | null;
  /** 按座位序传入（数组下标即 `seat`），`id` 是局内玩家 id */
  players: Array<{ id: string; userId: string | null; playerName: string; color: number; cash: number; bankrupt: boolean }>;
}

export async function saveGameRecord(input: GameRecordInput): Promise<void> {
  if (!pool || !storageReady.pg) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recordRes = await client.query<{ id: string }>(
      `INSERT INTO game_records (room_id, seed, start_date, winner_name, player_count, turns, rounds, actions, max_days, map_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING id`,
      [
        input.roomId,
        input.seed,
        JSON.stringify(input.startDate),
        input.winnerName,
        input.players.length,
        input.turns,
        input.rounds,
        JSON.stringify(input.actions),
        input.maxDays,
        input.mapId,
      ],
    );
    const recordId = recordRes.rows[0]!.id;
    for (const [seat, p] of input.players.entries()) {
      await client.query(
        `INSERT INTO game_record_players (record_id, user_id, player_name, color, cash, bankrupt, seat, player_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [recordId, p.userId, p.playerName, p.color, p.cash, p.bankrupt, seat, p.id],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.warn('[storage] 保存对局记录失败:', e instanceof Error ? e.message : e);
  } finally {
    client.release();
  }
}

export interface ReplayRecordSummary {
  id: string;
  room_id: string;
  winner_name: string | null;
  player_count: number;
  turns: number;
  rounds: number;
  finished_at: Date;
  /** 座位序（`seat`）排列；`player_key` 是局内玩家 id，回放建局要用它当 id */
  players: Array<{ player_name: string; color: number; cash: number; bankrupt: boolean; player_key?: string | null }>;
}

export interface ReplayRecord extends ReplayRecordSummary {
  seed: number;
  /** 老记录可能为空，客户端缺省时引擎用固定常量兜底 */
  start_date: DateSerial | null;
  /** 建局时的天数上限（W4）；null = 不限 */
  max_days: number | null;
  /** 本局地图；null = 自建 64 格环（老记录没有这一列，读出来即 null） */
  map_id: number | null;
  actions: Array<{ turn: number; action: unknown }>;
}

export async function listRecentRecords(limit = 20): Promise<ReplayRecordSummary[]> {
  if (!pool || !storageReady.pg) return [];
  const res = await pool.query(
    `SELECT gr.id, gr.room_id, gr.winner_name, gr.player_count, gr.turns, gr.rounds, gr.finished_at,
            COALESCE(
              json_agg(json_build_object('player_name', rp.player_name, 'color', rp.color, 'cash', rp.cash, 'bankrupt', rp.bankrupt, 'player_key', rp.player_key)
                       ORDER BY rp.seat)
              FILTER (WHERE rp.player_name IS NOT NULL), '[]'::json
            ) AS players
     FROM game_records gr
     LEFT JOIN game_record_players rp ON rp.record_id = gr.id
     GROUP BY gr.id
     ORDER BY gr.finished_at DESC
     LIMIT $1`,
    [limit],
  );
  return res.rows as ReplayRecordSummary[];
}

export async function getRecord(id: string): Promise<ReplayRecord | null> {
  if (!pool || !storageReady.pg) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<ReplayRecord>(
    `SELECT gr.id, gr.room_id, gr.seed, gr.start_date, gr.max_days, gr.map_id, gr.winner_name, gr.player_count, gr.turns, gr.rounds, gr.actions, gr.finished_at,
            COALESCE(
              json_agg(json_build_object('player_name', rp.player_name, 'color', rp.color, 'cash', rp.cash, 'bankrupt', rp.bankrupt, 'player_key', rp.player_key)
                       ORDER BY rp.seat)
              FILTER (WHERE rp.player_name IS NOT NULL), '[]'::json
            ) AS players
     FROM game_records gr
     LEFT JOIN game_record_players rp ON rp.record_id = gr.id
     WHERE gr.id = $1
     GROUP BY gr.id`,
    [id],
  );
  return res.rows[0] ?? null;
}

export interface LeaderboardRow {
  username: string;
  wins: number;
  games: number;
}

export async function getLeaderboard(limit = 20): Promise<LeaderboardRow[]> {
  if (!pool || !storageReady.pg) return [];
  const res = await pool.query<LeaderboardRow>(
    `SELECT u.username,
            COUNT(*) FILTER (WHERE rp.user_id IS NOT NULL AND gr.winner_name = u.username)::int AS wins,
            COUNT(DISTINCT gr.id)::int AS games
     FROM users u
     LEFT JOIN game_record_players rp ON rp.user_id = u.id
     LEFT JOIN game_records gr ON gr.id = rp.record_id
     GROUP BY u.id, u.username
     ORDER BY wins DESC, games ASC, u.username ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}

