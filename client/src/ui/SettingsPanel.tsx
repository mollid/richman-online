import { useEffect, useState } from 'react';
import { setVolume } from '../game/sfx.js';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  getSettings,
  resetSettings,
  saveSettings,
  type GameSpeed,
  type Settings,
} from '../game/settings.js';

const SPEED_OPTIONS: Array<[GameSpeed, string]> = [
  ['low', '慢'],
  ['mid', '标准'],
  ['high', '快'],
];

/** KeyboardEvent.code 的可读名称，例如 KeyB -> B */
function prettyCode(code: string): string {
  if (!code) return '未设置';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return '空格';
  if (code === 'Enter') return '回车';
  if (code === 'Escape') return 'Esc';
  return code;
}

/**
 * 全局设置面板（UI-02/03/09/10/11/12、TIME-06）。
 * 每次改动立即落盘并派发 richman:settings-changed 事件。
 * 注意：起始日期只写入设置，不改动已经开局的对局。
 */
export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const [settings, setSettings] = useState<Settings>(() => getSettings());
  // 正在等待重新绑定按键的动作名
  const [rebinding, setRebinding] = useState<string | null>(null);
  const [date, setDate] = useState(() => {
    const d = getSettings().startDate;
    const now = new Date();
    return {
      year: d?.year ?? now.getFullYear(),
      month: d?.month ?? now.getMonth() + 1,
      day: d?.day ?? now.getDate(),
    };
  });
  const [dateError, setDateError] = useState('');

  const update = (patch: Partial<Settings>) => setSettings(saveSettings(patch));

  // UI-10 动画总开关：写到 <html> 的 data-animations 上，由 styles.css 生效
  useEffect(() => {
    document.documentElement.dataset.animations = settings.animations ? 'on' : 'off';
  }, [settings.animations]);

  // UI-11 音效音量下发到合成器（0..100 归一为 0..1）
  useEffect(() => {
    setVolume(settings.sfxVolume / 100);
  }, [settings.sfxVolume]);

  // 打开面板时同步一次，保证 localStorage 外部改动也能生效
  useEffect(() => {
    setSettings(getSettings());
    document.documentElement.dataset.animations = getSettings().animations ? 'on' : 'off';
    setVolume(getSettings().sfxVolume / 100);
  }, []);

  // 重设热键：捕获单个按键，Escape 取消
  useEffect(() => {
    if (!rebinding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setRebinding(null);
        return;
      }
      const next = { ...getSettings().hotkeyMap, [rebinding]: e.code };
      // 同一按键只允许绑定一个动作，先从旧绑定中移除
      for (const key of Object.keys(next)) {
        if (key !== rebinding && next[key] === e.code) delete next[key];
      }
      update({ hotkeyMap: next });
      setRebinding(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [rebinding]);

  const applyDate = () => {
    const year = Number(date.year);
    const month = Number(date.month);
    const day = Number(date.day);
    if (!Number.isInteger(year) || year < 1900 || year > 2999) {
      setDateError('年份需在 1900 - 2999 之间');
      return;
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      setDateError('月份需在 1 - 12 之间');
      return;
    }
    // 用 Date 校验日是否合法（例如 2 月 30 日）
    const probe = new Date(year, month - 1, day);
    if (probe.getMonth() !== month - 1 || probe.getDate() !== day) {
      setDateError('该日期不存在，请检查月份与天数');
      return;
    }
    setDateError('');
    update({ startDate: { year, month, day } });
  };

  const useSystemDate = () => {
    const now = new Date();
    setDate({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
    setDateError('');
    update({ startDate: null });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="panel-title">设置</span>
          <button className="ghost small" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="settings-body">
          {/* UI-10 动画 */}
          <section className="settings-group">
            <div className="settings-group-title">动画</div>
            <label className="settings-row">
              <span>启用动画</span>
              <input
                type="checkbox"
                checked={settings.animations}
                onChange={(e) => update({ animations: e.target.checked })}
              />
            </label>
          </section>

          {/* UI-11 音效与音乐 */}
          <section className="settings-group">
            <div className="settings-group-title">音效与音乐</div>
            <label className="settings-row">
              <span>音效音量</span>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.sfxVolume}
                onChange={(e) => update({ sfxVolume: Number(e.target.value) })}
              />
              <b className="settings-value">{settings.sfxVolume}</b>
            </label>
            <label className="settings-row">
              <span>背景音乐</span>
              <input
                type="checkbox"
                checked={settings.musicEnabled}
                disabled
                title="项目目前没有音乐资源，暂不可用"
                onChange={(e) => update({ musicEnabled: e.target.checked })}
              />
              <span className="settings-hint">暂无音乐资源</span>
            </label>
            <label className="settings-row">
              <span>音乐音量</span>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.musicVolume}
                disabled={!settings.musicEnabled}
                onChange={(e) => update({ musicVolume: Number(e.target.value) })}
              />
              <b className="settings-value">{settings.musicVolume}</b>
            </label>
          </section>

          {/* UI-09 速度 */}
          <section className="settings-group">
            <div className="settings-group-title">游戏速度</div>
            <div className="settings-row">
              <span>动画与结算速度</span>
              <select value={settings.gameSpeed} onChange={(e) => update({ gameSpeed: e.target.value as GameSpeed })}>
                {SPEED_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* UI-12 自动存档 */}
          <section className="settings-group">
            <div className="settings-group-title">自动存档</div>
            <label className="settings-row">
              <span>每回合自动存档</span>
              <input type="checkbox" checked={settings.autoSave} onChange={(e) => update({ autoSave: e.target.checked })} />
            </label>
            <div className="settings-hint">开启后每回合记录一次存档点</div>
          </section>

          {/* UI-02 指令热键 */}
          <section className="settings-group">
            <div className="settings-group-title">指令热键</div>
            <label className="settings-row">
              <span>启用指令热键</span>
              <input
                type="checkbox"
                checked={settings.hotkeysEnabled}
                onChange={(e) => update({ hotkeysEnabled: e.target.checked })}
              />
            </label>
            <div className="hotkey-list">
              {HOTKEY_ACTIONS.map(({ name, label }) => {
                const code = settings.hotkeyMap[name] ?? DEFAULT_HOTKEYS[name] ?? '';
                const conflict = Object.entries(settings.hotkeyMap).find(([k, v]) => k !== name && v === code);
                return (
                  <div key={name} className="hotkey-row">
                    <span className="hotkey-name">{label}</span>
                    <button
                      className={`small ${rebinding === name ? 'primary' : 'ghost'}`}
                      disabled={!settings.hotkeysEnabled}
                      onClick={() => setRebinding(rebinding === name ? null : name)}
                    >
                      {rebinding === name ? '请按新键…' : prettyCode(code)}
                    </button>
                    {conflict && <span className="settings-hint">与「{HOTKEY_ACTIONS.find((a) => a.name === conflict[0])?.label}」冲突</span>}
                  </div>
                );
              })}
            </div>
            <div className="settings-actions">
              <span className="settings-hint">点击按键后按新键重设，Esc 取消</span>
              <button className="small ghost" onClick={() => update({ hotkeyMap: { ...DEFAULT_HOTKEYS } })}>
                恢复默认
              </button>
            </div>
          </section>

          {/* TIME-06 起始日期 */}
          <section className="settings-group">
            <div className="settings-group-title">起始日期</div>
            <div className="date-row">
              <label>
                <span>年</span>
                <input
                  type="number"
                  value={date.year}
                  onChange={(e) => setDate({ ...date, year: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>月</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={date.month}
                  onChange={(e) => setDate({ ...date, month: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>日</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={date.day}
                  onChange={(e) => setDate({ ...date, day: Number(e.target.value) })}
                />
              </label>
            </div>
            {dateError && <div className="error-text">{dateError}</div>}
            <div className="settings-actions">
              <span className="settings-hint">
                仅对下一局生效：{settings.startDate
                  ? `${settings.startDate.year}/${settings.startDate.month}/${settings.startDate.day}`
                  : '使用系统日期'}
              </span>
              <button className="small primary" onClick={applyDate}>
                应用到下一局
              </button>
              <button className="small ghost" onClick={useSystemDate}>
                使用系统日期
              </button>
            </div>
          </section>

          <div className="settings-footer">
            <button
              className="ghost"
              onClick={() => {
                const next = resetSettings();
                setSettings(next);
                setVolume(next.sfxVolume / 100);
                const now = new Date();
                setDate({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
                setDateError('');
              }}
            >
              恢复默认设置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}