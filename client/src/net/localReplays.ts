import type { ReplayRecord, ReplayRecordSummary } from './auth.js';

/**
 * 单人局的回放：只落这台浏览器，不上云。
 *
 * 决策人把单人局定成「不进排行榜、纯本地」，所以这里既没有服务端参与，也不该有 ——
 * 但回放仍然要能看，于是按账号分键存一份环形缓冲。清缓存或换设备就没了，这是那条决定的代价。
 */
const KEY_PREFIX = 'richman.localReplays';
/** 一整局的动作日志不小（长局几百 KB），留 10 条足够回看最近的几局，再多就撞 localStorage 配额 */
const KEEP = 10;

export interface ReplayListItem extends ReplayRecordSummary {
  /** true = 单人局，数据在本机；false = 联机局，数据在服务端 */
  local: boolean;
}

function keyOf(username: string): string {
  return `${KEY_PREFIX}.${username}`;
}

function readAll(username: string): ReplayRecord[] {
  try {
    const raw = localStorage.getItem(keyOf(username));
    return raw ? (JSON.parse(raw) as ReplayRecord[]) : [];
  } catch {
    return [];
  }
}

/** 存一局。写不进去（配额满）就当没存 —— 单人回放不值得为它弹错误条 */
export function saveLocalReplay(username: string, record: ReplayRecord): void {
  try {
    const rest = readAll(username).filter((r) => r.id !== record.id);
    localStorage.setItem(keyOf(username), JSON.stringify([record, ...rest].slice(0, KEEP)));
  } catch {
    /* 忽略：隐私模式与配额满都走到这里 */
  }
}

export function listLocalReplays(username: string): ReplayListItem[] {
  return readAll(username).map((r) => ({ ...r, local: true }));
}

export function getLocalReplay(username: string, id: string): ReplayRecord | null {
  return readAll(username).find((r) => r.id === id) ?? null;
}
