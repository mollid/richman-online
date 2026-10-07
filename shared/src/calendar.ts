import type { DateSerial, GameState } from './types.js';

/**
 * 时间日历（TIME-01..06）：纯函数、零依赖。
 *
 * 关键设计：只持久化「起始日期 + 流逝天数」，其余（星期/例假/分红日/月末）全部派生。
 * 使用整型儒略式序列号（Hinnant 算法），保证跨月/闰年完全确定，且 applyAction 路径内不读系统时钟。
 */

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/**
 * 缺省起始日期（调用方未传入时兜底）。
 * shared 不读系统时钟：真实日期由 GameRoom / LocalHotseatSession 在构造时各捕获一次。
 */
export const DEFAULT_START_DATE: DateSerial = { year: 1980, month: 1, day: 1 };

/** 日期 → 整数天序列号（1970-01-01 为 0） */
export function toSerial(d: DateSerial): number {
  const y = d.year - (d.month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (d.month + (d.month > 2 ? -3 : 9)) + 2) / 5) + d.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 整数天序列号 → 日期 */
export function fromSerial(z: number): DateSerial {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/** 星期（0=周日 … 6=周六），真实公历 */
export function weekdayOf(d: DateSerial): number {
  return (((toSerial(d) + 4) % 7) + 7) % 7;
}

/** 是否例假日（周六/周日） */
export function isHolidayWeekday(d: DateSerial): boolean {
  const wd = weekdayOf(d);
  return wd === 0 || wd === 6;
}

/** 某年某月的天数 */
export function daysInMonth(year: number, month: number): number {
  const first = toSerial({ year, month, day: 1 });
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return toSerial({ year: nextYear, month: nextMonth, day: 1 }) - first;
}

/** 加 n 个月（日号溢出时收敛到当月最后一天） */
export function addMonths(d: DateSerial, n: number): DateSerial {
  const total = d.year * 12 + (d.month - 1) + n;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12 + 1;
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}

function isoOf(d: DateSerial): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** 派生出的游戏日期（供 UI 与引擎共用） */
export interface GameDate {
  /** 距开局流逝的天数 */
  dayIndex: number;
  year: number;
  month: number;
  day: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
  weekdayLabel: string;
  /** 例假日（股市/银行休市） */
  isHoliday: boolean;
  /** 每月 15 号：分红日 + 乐透开奖 */
  isDividendDay: boolean;
  /** 当月最后一天：存款计息 */
  isMonthEnd: boolean;
  /** 距月末剩余天数（0 表示今天就是月末） */
  daysLeftInMonth: number;
  iso: string;
}

/** 当前游戏日期 */
export function gameDate(state: GameState): GameDate {
  const { start, elapsedDays } = state.calendar;
  const date = fromSerial(toSerial(start) + elapsedDays);
  const weekday = weekdayOf(date);
  const dim = daysInMonth(date.year, date.month);
  return {
    dayIndex: elapsedDays,
    year: date.year,
    month: date.month,
    day: date.day,
    weekday,
    weekdayLabel: WEEKDAY_LABELS[weekday]!,
    isHoliday: weekday === 0 || weekday === 6,
    isDividendDay: date.day === 15,
    isMonthEnd: date.day === dim,
    daysLeftInMonth: dim - date.day,
    iso: isoOf(date),
  };
}

/** 距开局流逝的天数 */
export function elapsedDays(state: GameState): number {
  return state.calendar.elapsedDays;
}

/** 给定月份的所有天（TIME-05 月曆），返回日期序列 */
export function monthDays(year: number, month: number): DateSerial[] {
  const dim = daysInMonth(year, month);
  const out: DateSerial[] = [];
  for (let d = 1; d <= dim; d++) out.push({ year, month, day: d });
  return out;
}