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
    throw new Error(data?.error ?? `请求失败 (${res.status})`);
  }
  return data as T;
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
  actions: Array<{ turn: number; action: PlayerAction }>;
}

export async function fetchRecentRecords(limit = 20): Promise<ReplayRecordSummary[]> {
  return request<ReplayRecordSummary[]>(`/records/recent?limit=${limit}`);
}

export async function fetchRecord(id: string): Promise<ReplayRecord> {
  return request<ReplayRecord>(`/records/${id}`);
}
