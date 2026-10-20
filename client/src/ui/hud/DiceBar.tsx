/**
 * 棋盘上的操作锚点：一颗实体骰子浮在盘面底边中间 —— 大富翁4 原版就是「骰子在盘子上」，
 * 不是盘外另开一排按钮。旁边只挂两颗小胶囊：落格出口（不做）与「更多动作 N」。
 *
 * 为什么次操作不留常驻：这一步要动的东西一多，按钮排就会横着长，把盘面吃掉一条；
 * 收进向上弹的小面板之后，盘面尺寸与「现在能做什么」彻底解耦 ——
 * 回合推进、落格换格、换人，盘面都不会跟着 resize（旧 `.mp-dock` 那套高度锁就是为了这个）。
 *
 * 位置约束（改样式前必读）：它是 `.mp-stage` 的**兄弟节点**，不是子节点。
 * `world.dispose()` 会把舞台 innerHTML 清空、`overlay.dispose()` 会删掉舞台里所有 canvas，
 * 挂进去的按钮活不过一次重开。
 */
import { useEffect, useRef, useState } from 'react';
import type { AcSnapshot } from '../../game/acSnapshot.js';
import { Icon } from '../mp/Icon.js';
import { buildActions, landingExit, Pips, type ActRow } from './actions.js';

export function DiceBar({
  snap,
  interactive,
  camLocked,
  onFire,
  guideMore,
}: {
  snap: AcSnapshot;
  interactive: boolean;
  /** 镜头在补间途中：所有操作都要灰掉，否则会在飞行中途把动作派出去 */
  camLocked: boolean;
  onFire: (act: ActRow['act'], label: string) => void;
  /** 首次出现的一次性气泡指引：确实有东西被收起来了才值得教 */
  guideMore: boolean;
}) {
  const { state: st } = snap;
  const cur = st.players[st.currentPlayerIndex];
  const [moreOpen, setMoreOpen] = useState(false);
  const [spin, setSpin] = useState(false);
  const spinTimer = useRef(0);
  const moreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => window.clearTimeout(spinTimer.current), []);

  /* 镜头一起飞就把弹层收掉。旧 hud.js 的 `camLock()` 锁上那一刻会摘掉所有 `.hud-pop--open`，
     理由写得很直白：弹层浮在已经置灰的按钮上会「看着还能点」，而底下其实全是 disabled。 */
  useEffect(() => {
    if (camLocked) setMoreOpen(false);
  }, [camLocked]);

  /* 弹层没有遮罩兜底，所以自己挂一个「点外面关掉」。触发那颗钮本身要排除，
     否则 pointerdown 先关、click 再开，永远关不上。 */
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || moreRef.current?.contains(t)) return;
      setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  if (!cur) return null;

  const rows = buildActions(snap).filter((r) => r.enabled);
  const primary = rows.find((r) => r.key === 'roll') ?? rows.find((r) => r.key === 'buy') ?? rows.find((r) => r.key === 'upgrade') ?? null;
  const secondary = rows.filter((r) => r !== primary);
  const exit = landingExit(snap);
  const dice = st.dice ?? [];
  const total = dice.reduce((a, b) => a + b, 0);

  /* 停留态（在押 / 住院 / 出国）：不给按钮，只说清「回合会自己走」。
     引擎那一侧同一条判据是 stayRefusal，这里只是翻成玩家看得见的一句话。 */
  const stay =
    cur.skipTurns > 0
      ? `${cur.custody ? (cur.custody.kind === 'jail' ? '在押' : '住院') : cur.abroadTurns > 0 ? '出国' : '停留'}中 · 回合自动跳过（剩 ${cur.skipTurns}）`
      : null;

  const fire = (r: ActRow) => {
    if (r.key === 'roll') {
      setSpin(true);
      window.clearTimeout(spinTimer.current);
      spinTimer.current = window.setTimeout(() => setSpin(false), 620);
    }
    onFire(r.act, r.label);
    setMoreOpen(false);
  };

  const blocked = camLocked || !interactive;

  return (
    <div className={`mp-dicebar${camLocked ? ' mp-dicebar--locked' : ''}`}>
      {/* 落格窗的那个出口：不是主操作（它是「不做」），排在骰子左边、用奶油色小胶囊 */}
      {exit && (
        <button className="mp-chip" type="button" title={exit.why} disabled={blocked} onClick={() => onFire({ type: 'FINISH_LANDING' }, exit.label)}>
          <Icon id="i-arrow-right" size="s" />
          {exit.label}
        </button>
      )}

      <div className="mp-dicewrap">
        {stay ? (
          <span className="mp-stay">{stay}</span>
        ) : primary ? (
          <button
            className={`mp-dice mp-dice--${primary.key === 'roll' ? 'roll' : 'go'}`}
            type="button"
            data-primary="1"
            disabled={blocked}
            title={`${primary.label} · 回车或空格 ${primary.why}`}
            onClick={() => fire(primary)}
          >
            <span className={`mp-dice__cube${spin ? ' mp-dice__cube--spin' : ''}`}>
              {primary.key === 'roll' ? <Pips value={dice.length ? total : 1} /> : <Icon id={primary.icon} size="l" />}
            </span>
            <span className="mp-dice__label">
              <b>{primary.label}</b>
              <small>{dice.length ? `${dice.join('+')}=${total}` : '回车 · 空格'}</small>
            </span>
          </button>
        ) : !interactive ? (
          <span className="mp-stay">等待对方操作</span>
        ) : secondary.length === 0 && !exit ? (
          /* 只有「真的什么都没有」才说这句：会话窗（银行 / 商店）没有主 CTA，但次操作与出口都在 */
          <span className="mp-stay">此刻没有可执行的操作</span>
        ) : null}
      </div>

      {/* 次操作全部收进这颗胶囊：一个都没少，只是不再常驻占盘面 */}
      {secondary.length > 0 && (
        <div className="mp-morewrap" ref={moreRef}>
          <button
            className={`mp-chip${moreOpen ? ' mp-chip--on' : ''}`}
            type="button"
            aria-expanded={moreOpen}
            disabled={blocked}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <Icon id="i-more" size="s" />
            更多动作 {secondary.length}
          </button>
          {moreOpen && (
            <div className="mp-morepop mp-panel" role="group" aria-label="此刻可做的次操作">
              <div className="mp-morepop__t">此刻可做的次操作（共 {secondary.length}）</div>
              <div className="mp-morepop__grid">
                {secondary.map((r) => (
                  <button
                    key={r.key}
                    className={`mp-btn mp-btn--${r.variant}`}
                    type="button"
                    title={r.why}
                    /* 门控不能漏：镜头补间中途或别人的回合里真能把动作派出去 */
                    disabled={blocked}
                    onClick={() => fire(r)}
                  >
                    <Icon id={r.icon} size="s" />
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {guideMore && <span className="mp-bubble mp-bubble--up">其余动作都收在这里，一个没少</span>}
        </div>
      )}
    </div>
  );
}
