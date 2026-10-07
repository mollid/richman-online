import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, SETTINGS_CHANGED_EVENT, type Settings } from '../game/settings.js';

/** 事件 target 是否为可编辑元素——在这些元素里按指令键不能触发游戏动作 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 指令热键（UI-02）。
 * - 绑定值为 KeyboardEvent.code（如 'KeyB'、'Space'），与键盘布局无关。
 * - 仅在 settings.hotkeysEnabled 为 true 时生效。
 * - 设置面板改动 hotkeyMap 后会自动重绑（订阅 richman:settings-changed）。
 * - 焦点在输入框/下拉框/可编辑区域时一律忽略。
 *
 * @param dispatch 动作名兜底处理器：某个动作没有通过 registerAction 注册时调用
 * @returns registerAction 把动作名绑到真实实现，返回解绑函数供组件卸载时清理
 */
export function useHotkeys(dispatch?: (actionType: string) => void) {
  const [settings, setSettings] = useState<Settings>(() => getSettings());
  const handlers = useRef(new Map<string, () => void>());
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // 跟随设置变更，保证热键开关与重绑定即时生效
  useEffect(() => {
    const onChanged = () => setSettings(getSettings());
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
  }, []);

  const { hotkeysEnabled, hotkeyMap } = settings;

  useEffect(() => {
    if (!hotkeysEnabled) return;

    // 反查表：code -> 动作名。同一个 code 只保留一个动作，先注册的优先。
    const byCode = new Map<string, string>();
    for (const [action, code] of Object.entries(hotkeyMap)) {
      if (code && !byCode.has(code)) byCode.set(code, action);
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const action = byCode.get(e.code);
      if (!action) return;
      const fn = handlers.current.get(action);
      if (fn) {
        e.preventDefault();
        fn();
      } else {
        dispatchRef.current?.(action);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeysEnabled, hotkeyMap]);

  const registerAction = useCallback((name: string, fn: () => void) => {
    handlers.current.set(name, fn);
    return () => {
      // 只在自己仍是最新实现时才删，避免同名重复注册互相误删
      if (handlers.current.get(name) === fn) handlers.current.delete(name);
    };
  }, []);

  return { registerAction };
}