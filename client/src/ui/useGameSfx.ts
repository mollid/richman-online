import { useEffect, useRef } from 'react';
import type { GameState } from '@richman/shared';
import { sfx } from '../game/sfx.js';

/** 根据状态差异播放对应音效（骰子/交易/破产/胜利） */
export function useGameSfx(game: GameState, enabled = true): void {
  const prev = useRef<GameState | null>(null);

  useEffect(() => {
    const old = prev.current;
    prev.current = game;
    if (!enabled || !old) return;

    if (game.dice && !old.dice) sfx.dice();

    const oldLen = old.log.length;
    const newEntries = game.log.slice(oldLen);
    for (const entry of newEntries) {
      if (entry.text.includes('猜中了')) sfx.hit();
      else if (entry.text.includes('猜错')) sfx.miss();
      else if (entry.text.includes('购入') || entry.text.includes('升级为')) sfx.buy();
      else if (entry.text.includes('租金') || entry.text.includes('需缴税') || entry.text.includes('损失')) sfx.pay();
      else if (entry.text.includes('破产')) sfx.bankrupt();
      else if (entry.text.includes('获得最终胜利')) sfx.win();
    }
    if (game.phase === 'game_over' && old.phase !== 'game_over') sfx.win();
  }, [game, enabled]);
}

