import { useState } from 'react';
import { gameDate, monthDays, priceIndex, weekdayOf, type GameState } from '@richman/shared';

const WEEK_HEADERS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 日历面板（TIME-01..06）：当前日期/星期/例假、物价指数、日曆⇄月曆切换（TIME-05）。
 */
export function CalendarPanel({ game }: { game: GameState }) {
  const [monthView, setMonthView] = useState(false);
  const date = gameDate(game);
  const index = priceIndex(game);
  const indexPct = (index - 1) * 100;

  const leading = weekdayOf({ year: date.year, month: date.month, day: 1 });
  const days = monthView ? monthDays(date.year, date.month) : [];

  return (
    <div className="panel calendar-panel">
      <div className="calendar-head">
        <span className="calendar-date">
          {date.year} 年 {date.month} 月 {date.day} 日
        </span>
        <span className={`badge weekday ${date.isHoliday ? 'holiday' : ''}`}>{date.weekdayLabel}</span>
      </div>
      <div className="calendar-sub">
        <span>第 {date.dayIndex + 1} 天</span>
        {/* 天数上限（W4）：让玩家看得见这局还剩几天可打；不限时这一格整个不显示 */}
        {game.maxDays !== null && (
          <span className={`badge ${game.maxDays - game.calendar.elapsedDays <= 5 ? 'dividend' : ''}`}>
            对局第 {game.calendar.elapsedDays + 1} / {game.maxDays} 天
          </span>
        )}
        {date.isHoliday && <span className="badge holiday">例假·休市</span>}
        {date.isDividendDay && <span className="badge dividend">分红日</span>}
        {date.isMonthEnd && <span className="badge interest">计息日</span>}
      </div>
      <div className="calendar-index">
        物价指数 <b>{index.toFixed(2)}</b>
        <span className={indexPct >= 0 ? 'up' : 'down'}>
          （{indexPct >= 0 ? '+' : ''}
          {indexPct.toFixed(1)}%）
        </span>
        <span className="index-hint">距月末 {date.daysLeftInMonth} 天</span>
      </div>

      <div className="calendar-toggle">
        <button className={`small ${monthView ? '' : 'primary'}`} onClick={() => setMonthView(false)}>
          日曆
        </button>
        <button className={`small ${monthView ? 'primary' : ''}`} onClick={() => setMonthView(true)}>
          月曆
        </button>
      </div>

      {monthView && (
        <div className="calendar-grid">
          {WEEK_HEADERS.map((w) => (
            <div key={w} className="calendar-weekday">
              {w}
            </div>
          ))}
          {Array.from({ length: leading }, (_, i) => (
            <div key={`blank-${i}`} className="calendar-day blank" />
          ))}
          {days.map((d) => {
            const isToday = d.day === date.day;
            const wd = weekdayOf(d);
            const holiday = wd === 0 || wd === 6;
            return (
              <div
                key={d.day}
                className={`calendar-day ${holiday ? 'holiday' : ''} ${isToday ? 'today' : ''}`}
              >
                {d.day}
                {d.day === 15 && <span className="dot-mark dividend" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}