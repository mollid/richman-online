import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayRecord } from '../net/auth.js';
import { ReplaySession } from '../net/replay.js';
import { BoardRenderer } from '../game/BoardRenderer.js';
import { PlayerList } from './PlayerList.js';
import { LogPanel } from './LogPanel.js';
import { useGameSfx } from './useGameSfx.js';

const SPEEDS = [1, 2, 4];

/** 对局回放播放器：确定性引擎逐帧复现整局 */
export function ReplayScreen({ record, onExit }: { record: ReplayRecord; onExit: () => void }) {
  const session = useMemo(() => new ReplaySession(record), [record]);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const boardRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);

  const game = session.stateAt(step);
  useGameSfx(game);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const renderer = new BoardRenderer(el, game.board);
    rendererRef.current = renderer;
    renderer.setState(game);
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rendererRef.current?.setState(game);
  }, [game]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setStep((s) => {
        if (s >= session.totalSteps) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 650 / speed);
    return () => clearInterval(id);
  }, [playing, speed, session]);

  const finished = step >= session.totalSteps;

  return (
    <div className="game-screen">
      <div className="board-area" ref={boardRef}>
        <div className="replay-bar">
          <span className="replay-title">▶ 对局回放</span>
          <span className="replay-progress">
            {step} / {session.totalSteps}
          </span>
          <div className="replay-progress-track">
            <div className="replay-progress-fill" style={{ width: `${session.totalSteps ? (step / session.totalSteps) * 100 : 0}%` }} />
          </div>
          <button className="small ghost" onClick={() => { setStep(0); setPlaying(false); }}>
            ⏮ 重置
          </button>
          <button className="small primary" disabled={finished} onClick={() => setPlaying((p) => !p)}>
            {playing ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <button className="small" disabled={finished} onClick={() => { setPlaying(false); setStep((s) => Math.min(s + 1, session.totalSteps)); }}>
            ⏭ 单步
          </button>
          {SPEEDS.map((s) => (
            <button key={s} className={`small ${speed === s ? 'primary' : 'ghost'}`} onClick={() => setSpeed(s)}>
              x{s}
            </button>
          ))}
          <button className="small ghost" onClick={onExit}>
            退出回放
          </button>
        </div>
        {finished && (
          <div className="replay-finish-banner">
            🏆 回放结束：{record.winner_name ?? '未知'} 获胜（{record.turns} 回合 / {record.rounds} 轮）
          </div>
        )}
      </div>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="logo">大富翁 Online</span>
          <span className="mode-tag">回放</span>
        </div>
        <PlayerList game={game} />
        <div className="panel">
          <div className="panel-title">对局信息</div>
          <div className="record-meta">
            房间 {record.room_id} · {record.rounds} 轮 · 胜者 {record.winner_name ?? '-'}
          </div>
        </div>
        <LogPanel game={game} />
      </aside>
    </div>
  );
}
