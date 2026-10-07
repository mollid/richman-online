import pg from 'pg';
import Redis from 'ioredis';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

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
          winner_name VARCHAR(16),
          player_count INT NOT NULL,
          turns INT NOT NULL,
          rounds INT NOT NULL,
          finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS game_record_players (
          record_id UUID NOT NULL REFERENCES game_records(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id),
          player_name VARCHAR(16) NOT NULL,
          cash INT NOT NULL,
          bankrupt BOOLEAN NOT NULL
        );
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
  winnerName: string | null;
  turns: number;
  rounds: number;
  players: Array<{ userId: string | null; playerName: string; cash: number; bankrupt: boolean }>;
}

export async function saveGameRecord(input: GameRecordInput): Promise<void> {
  if (!pool || !storageReady.pg) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recordRes = await client.query<{ id: string }>(
      `INSERT INTO game_records (room_id, seed, winner_name, player_count, turns, rounds)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.roomId, input.seed, input.winnerName, input.players.length, input.turns, input.rounds],
    );
    const recordId = recordRes.rows[0]!.id;
    for (const p of input.players) {
      await client.query(
        `INSERT INTO game_record_players (record_id, user_id, player_name, cash, bankrupt)
         VALUES ($1, $2, $3, $4, $5)`,
        [recordId, p.userId, p.playerName, p.cash, p.bankrupt],
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
