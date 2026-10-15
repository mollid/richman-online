export interface AuthUser {
  id: string;
  username: string;
}

export interface LeaderboardEntry {
  username: string;
  wins: number;
  games: number;
}

import type { DateSerial, PlayerAction } from '@richman/shared';

const TOKEN_KEY = 'richman.token';

export function httpBaseUrl(): string {
  const envUrl = (import.meta.env?.VITE_SERVER_URL as string | undefined) ?? undefined;
  const ws = envUrl ?? `ws://${window.location.hostname}:2567`;
  return ws.replace(/^ws/, 'http');
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${httpBaseUrl()}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    // 带上状态码：调用方要区分「票作废了，清掉」和「服务连不上，留着下次再试」
    const err = new Error(data?.error ?? `请求失败 (${res.status})`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/**
 * 刷新后凭 localStorage 里的 token 换回登录态。
 * 没登录、票过期、服务没起，一律安静返回 null —— 这条路径上没有该报错给用户的东西。
 */
export async function fetchMe(): Promise<AuthUser | null> {
  if (!getToken()) return null;
  try {
    return (await request<{ user: AuthUser }>('/auth/me')).user;
  } catch (e) {
    if (e instanceof Error && (e as Error & { status?: number }).status === 401) setToken(null);
    return null;
  }
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const data = await request<{ token: string; user: AuthUser }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(data.token);
  return data.user;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const data = await request<{ token: string; user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(data.token);
  return data.user;
}

export async function logout(): Promise<void> {
  try {
    await request('/auth/logout', { method: 'POST' });
  } finally {
    setToken(null);
  }
}

export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  return request<LeaderboardEntry[]>('/leaderboard');
}

export interface ReplayPlayer {
  player_name: string;
  color: number;
  cash: number;
  bankrupt: boolean;
  /** 局内玩家 id：认输复仇、挂牌成交等动作引用它，回放建局要用同一个 id */
  player_key?: string | null;
}

export interface ReplayRecordSummary {
  id: string;
  room_id: string;
  winner_name: string | null;
  player_count: number;
  turns: number;
  rounds: number;
  finished_at: string;
  players: ReplayPlayer[];
}

export interface ReplayRecord extends ReplayRecordSummary {
  seed: number;
  /** 起始日期；老记录可能为空 */
  start_date?: DateSerial | null;
  /** 建局时的天数上限（W4）；缺省 = 不限。回放必须带着它，否则到期结算复现不出来 */
  max_days?: number | null;
  /** 本局地图（缺省 / null = 自建 64 格环）；回放必须带着，否则原版图会复现成默认图 */
  map_id?: number | null;
  actions: Array<{ turn: number; action: PlayerAction }>;
}

export async function fetchRecentRecords(limit = 20): Promise<ReplayRecordSummary[]> {
  return request<ReplayRecordSummary[]>(`/records/recent?limit=${limit}`);
}

export async function fetchRecord(id: string): Promise<ReplayRecord> {
  return request<ReplayRecord>(`/records/${id}`);
}
