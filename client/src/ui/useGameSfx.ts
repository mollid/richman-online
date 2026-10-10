import { useEffect, useRef } from 'react';
import type { GameState } from '@richman/shared';
import { sfx } from '../game/sfx.js';

/**
 * 根据状态差异播放对应音效。
 * 顺序敏感：同一条日志若同时命中多个关键词，只播最靠前的那一个，避免叠音。
 */
export function useGameSfx(game: GameState, enabled = true): void {
  const prev = useRef<GameState | null>(null);

  useEffect(() => {
    const old = prev.current;
    prev.current = game;
    if (!enabled || !old) return;

    // 引擎把「掷骰 + 走子」压在一个原子动作里，所以有人挪了位就等于刚掷出一手。
    // 不能只比 `game.dice` 有没有：那玩意儿会一路留到下一手，全场只在第一次响。
    const moved = game.players.some((p, i) => old.players[i]?.position !== p.position);
    if (game.dice && moved) sfx.dice();

    // 日切翻页（回合回绕，elapsedDays 自增）
    if (game.calendar.elapsedDays > old.calendar.elapsedDays) sfx.dayTurn();

    const oldLen = old.log.length;
    const newEntries = game.log.slice(oldLen);
    for (const entry of newEntries) {
      const t = entry.text;
      if (t.includes('猜中了')) sfx.hit();
      else if (t.includes('猜错')) sfx.miss();
      else if (t.includes('购入') || t.includes('升级为')) sfx.buy();
      else if (t.includes('租金') || t.includes('需缴税') || t.includes('损失')) sfx.pay();
      else if (t.includes('破产') || t.includes('被关进监狱')) sfx.bankrupt();
      else if (t.includes('获得最终胜利')) sfx.win();
      // 波 8 特殊单位与事件
      else if (t.includes('恶犬')) sfx.dog();
      else if (t.includes('水晶球') || t.includes('施法')) sfx.magic();
      else if (t.includes('诅咒') || t.includes('凭空消失')) sfx.curse();
      else if (t.includes('保释') || t.includes('赃物') || t.includes('恶人')) sfx.villain();
      // 波 6 经济事件
      else if (t.includes('落槌') || t.includes('拍得')) sfx.auction();
      else if (t.includes('分红')) sfx.dividend();
    }
    if (game.phase === 'game_over' && old.phase !== 'game_over') sfx.win();
  }, [game, enabled]);
}