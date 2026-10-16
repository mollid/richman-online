/**
 * 一次性气泡指引。
 *
 * 护栏里那条「被收纳功能首次出现时给一次性气泡指引」不能做成常驻说明 ——
 * 那等于把刚删掉的规则文本请回来。所以三条硬规矩：
 * 1. **armed 才计时**：功能没真的出现过就不许把这次机会烧掉（行囊还是空的时弹「点开看清单」毫无意义）；
 * 2. **只出现一次**：第一次真正显示就立刻写标记，重载也不会再弹；
 * 3. **会自动走**：`autoMs` 之后自己淡掉，不要求玩家点掉。
 */
import { useEffect, useRef, useState } from 'react';

const STORE = 'mp-guide';

function readStore(): Record<string, 1> {
  try {
    return JSON.parse(window.localStorage.getItem(STORE) ?? '{}') as Record<string, 1>;
  } catch {
    return {};
  }
}

function markSeen(key: string): void {
  try {
    const s = readStore();
    if (s[key]) return;
    s[key] = 1;
    window.localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    /* 隐私模式写不进去：顶多每次都弹一下，不影响功能 */
  }
}

/**
 * @param key 这条指引的唯一键
 * @param armed 此刻是否相关（例如「行囊里有东西」「确实有次操作被收起来了」）
 * @param autoMs 显示多久后自动收
 * @returns 是否该画这颗气泡
 */
export function useBubble(key: string, armed: boolean, autoMs = 6500): boolean {
  const [show, setShow] = useState(false);
  /** 已看过的那一份只在第一次判断时要，不该进依赖数组（进了就是自我触发的循环） */
  const seenRef = useRef<Record<string, 1> | null>(null);
  seenRef.current ??= readStore();

  useEffect(() => {
    if (!armed) return;
    if (seenRef.current?.[key]) return;
    markSeen(key);
    setShow(true);
    const t = window.setTimeout(() => setShow(false), autoMs);
    return () => window.clearTimeout(t);
  }, [armed, key, autoMs]);

  return show;
}
