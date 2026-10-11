/**
 * 全局设置存储（UI-02/03/09/10/11/12、TIME-06）。
 * 全部设置写入 localStorage，key 前缀沿用 `richman.` 风格。
 * 读取走内存缓存，避免每次 render 都命中 localStorage。
 */

export type GameSpeed = 'low' | 'mid' | 'high';

export interface StartDate {
  year: number;
  month: number;
  day: number;
}

export interface Settings {
  /** UI-10 动画总开关 */
  animations: boolean;
  /** UI-11 音乐音量 0..100 */
  musicVolume: number;
  /** UI-11 音效音量 0..100 */
  sfxVolume: number;
  /** 项目目前没有音乐资源，默认关闭 */
  musicEnabled: boolean;
  /** UI-09 游戏速度三档 */
  gameSpeed: GameSpeed;
  /** UI-12 每回合自动存档 */
  autoSave: boolean;
  /** UI-02 指令热键总开关 */
  hotkeysEnabled: boolean;
  /** UI-02 指令热键绑定：动作名 -> KeyboardEvent.code */
  hotkeyMap: Record<string, string>;
  /** TIME-06 起始日期，null 表示使用系统日期 */
  startDate: StartDate | null;
}

/** 默认指令热键表（可在设置面板中重设，Escape 取消） */
export const DEFAULT_HOTKEYS: Record<string, string> = {
  roll_dice: 'Space',
  buy_land: 'KeyB',
  upgrade_land: 'KeyU',
  /** R4：回车只做「推进流程、不花钱」这一件事（走出落格窗，否则掷骰） */
  confirm: 'Enter',
  toggle_report: 'KeyQ',
  open_settings: 'KeyO',
  open_help: 'KeyH',
  toggle_mute: 'KeyM',
};

export const DEFAULT_SETTINGS: Settings = {
  animations: true,
  musicVolume: 30,
  sfxVolume: 70,
  musicEnabled: false,
  gameSpeed: 'mid',
  autoSave: false,
  hotkeysEnabled: true,
  hotkeyMap: { ...DEFAULT_HOTKEYS },
  startDate: null,
};

const STORAGE_KEY = 'richman.settings';

/** 设置变更事件名，供其它组件订阅 */
export const SETTINGS_CHANGED_EVENT = 'richman:settings-changed';

let cache: Settings | null = null;

/** 把任意来源的数据收敛为合法设置，缺失字段回落默认值 */
function normalize(raw: unknown): Settings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
  };

  const hotkeyMap: Record<string, string> = { ...DEFAULT_HOTKEYS };
  if (src.hotkeyMap && typeof src.hotkeyMap === 'object') {
    for (const [action, code] of Object.entries(src.hotkeyMap)) {
      if (typeof code === 'string' && code) hotkeyMap[action] = code;
    }
  }
  /* R4：`end_turn` 这个指令名已经不存在了（玩家不再手动结束回合），但它换成的是
     `confirm` —— 同一个回车、同一族「推进流程」的语义。老存档里那条绑定必须搬过去：
     `useHotkeys` 的 code→动作反查表是 first-wins，留着一条没人注册的 `end_turn: 'Enter'`
     会让回车**静默失效**（按键被吃掉，动作表里查不到处理者）。 */
  if (src.hotkeyMap && typeof src.hotkeyMap === 'object') {
    const legacy = (src.hotkeyMap as Record<string, string>)['end_turn'];
    if (legacy && !('confirm' in src.hotkeyMap)) hotkeyMap.confirm = legacy;
  }
  delete hotkeyMap.end_turn;

  let startDate: StartDate | null = null;
  const sd = src.startDate;
  if (sd && typeof sd === 'object') {
    const year = Number((sd as StartDate).year);
    const month = Number((sd as StartDate).month);
    const day = Number((sd as StartDate).day);
    // 年月日必须落在合理区间，非法则视为未设置
    if (Number.isFinite(year) && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      startDate = { year: Math.round(year), month: Math.round(month), day: Math.round(day) };
    }
  }

  const speed = src.gameSpeed;
  return {
    animations: typeof src.animations === 'boolean' ? src.animations : DEFAULT_SETTINGS.animations,
    musicVolume: num(src.musicVolume, DEFAULT_SETTINGS.musicVolume),
    sfxVolume: num(src.sfxVolume, DEFAULT_SETTINGS.sfxVolume),
    musicEnabled: typeof src.musicEnabled === 'boolean' ? src.musicEnabled : DEFAULT_SETTINGS.musicEnabled,
    gameSpeed: speed === 'low' || speed === 'mid' || speed === 'high' ? speed : DEFAULT_SETTINGS.gameSpeed,
    autoSave: typeof src.autoSave === 'boolean' ? src.autoSave : DEFAULT_SETTINGS.autoSave,
    hotkeysEnabled:
      typeof src.hotkeysEnabled === 'boolean' ? src.hotkeysEnabled : DEFAULT_SETTINGS.hotkeysEnabled,
    hotkeyMap,
    startDate,
  };
}

/** 从 localStorage 读取设置（会刷新内存缓存） */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = normalize(raw ? (JSON.parse(raw) as unknown) : null);
  } catch {
    // localStorage 不可用或数据损坏时退回默认值
    cache = { ...DEFAULT_SETTINGS, hotkeyMap: { ...DEFAULT_HOTKEYS } };
  }
  return cache;
}

/** 读取当前设置，首次访问时才真正解析 localStorage */
export function getSettings(): Settings {
  return cache ?? loadSettings();
}

/** 合并写入设置并持久化，同时派发 richman:settings-changed 事件 */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next = normalize({ ...getSettings(), ...patch });
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式等场景下写入失败：内存缓存仍然生效
  }
  window.dispatchEvent(new CustomEvent<Settings>(SETTINGS_CHANGED_EVENT, { detail: next }));
  return next;
}

/** 恢复出厂设置 */
export function resetSettings(): Settings {
  return saveSettings({ ...DEFAULT_SETTINGS, hotkeyMap: { ...DEFAULT_HOTKEYS } });
}

/** 供设置面板使用的可绑定指令清单（顺序即展示顺序） */
export const HOTKEY_ACTIONS: Array<{ name: string; label: string }> = [
  { name: 'roll_dice', label: '掷骰子' },
  { name: 'buy_land', label: '购买土地' },
  { name: 'upgrade_land', label: '升级建筑' },
  { name: 'confirm', label: '确认 / 离开（不花钱）' },
  { name: 'toggle_report', label: '切换报表' },
  { name: 'open_settings', label: '打开设置' },
  { name: 'open_help', label: '打开帮助' },
  { name: 'toggle_mute', label: '静音切换' },
];