/**
 * 顶栏：只有四组 —— 资源区 / 状态胶囊 / 消息入口 / 更多 + 设置。
 *
 * 「回合、行动者、物价」在这里出现**一次**（中间那颗胶囊），其余任何地方都不再重复：
 * 旧 HUD 同一句「第 N 回合 · 行动者 X · 物价 ×1.0」在顶栏、右侧面板页脚、dock 相机条上
 * 各写了一遍，是三处要对齐的同一个事实。现在 dock 只讲「这一格」，抽屉只讲「谁怎么样」。
 *
 * 物价指数按简化原则第 3 条**常驻但平时不说话**：只有它真的动了才亮一下（见 `usePricePulse`），
 * 不为此新开一条常驻横幅 —— 信息变化用角标与微动效提醒。
 */
import { useEffect, useRef, useState } from 'react';
import { CURRENCY_ICON } from '@richman/shared';
import type { AcSnapshot } from '../../game/acSnapshot.js';
import { characterPortrait } from '../../game/portrait.js';
import { Icon } from '../mp/Icon.js';

const money = (n: number) => Math.round(n).toLocaleString('zh-CN');

/** 物价指数动了多少算「值得打断一下」：三位小数里第 3 位起跳 */
const PRICE_PULSE = 0.005;
const PULSE_MS = 2400;

/**
 * 物价指数的「动了才亮」。
 * 首帧不亮（那是进对局时从 1.000 落到真值，不是事件），读档后也不亮。
 */
function usePricePulse(index: number): boolean {
  const prev = useRef(index);
  const [hot, setHot] = useState(false);
  useEffect(() => {
    if (Math.abs(index - prev.current) < PRICE_PULSE) {
      prev.current = index;
      return;
    }
    prev.current = index;
    setHot(true);
    const t = window.setTimeout(() => setHot(false), PULSE_MS);
    return () => window.clearTimeout(t);
  }, [index]);
  return hot;
}

export function TopBar({
  snap,
  /** 表现层视角（热座下跟着回合走，联机时可以点头像组切换） */
  viewportPid,
  onPickViewport,
  unread,
  onOpenLog,
  onOpenMore,
  onOpenSettings,
  onToggleMute,
  onOpenHelp,
  muted,
  tag,
}: {
  snap: AcSnapshot;
  viewportPid: string;
  onPickViewport: (pid: string) => void;
  unread: number;
  onOpenLog: () => void;
  onOpenMore: () => void;
  onOpenSettings: () => void;
  onToggleMute: () => void;
  onOpenHelp: () => void;
  muted: boolean;
  tag: string;
}) {
  const { state: st, view } = snap;
  const me = st.players.find((p) => p.id === viewportPid) ?? st.players[0];
  const actor = st.players[st.currentPlayerIndex];
  const hot = usePricePulse(view.priceIndex);
  /* 胶囊里的日期只在跨日时才多说一句；常驻显示等于把状态条搬回顶栏 */
  const special = view.date.isHoliday ? '例假日休市' : view.date.isDividendDay ? '今日分红' : view.date.isMonthEnd ? '月末清算' : '';

  if (!me) return null;

  return (
    <header className="mp-top mp-panel">
      <div className="mp-res">
        <button
          className="mp-res__me"
          type="button"
          title="点开岛民名册（按总资产排，点一位可切换视角）"
          onClick={() => onPickViewport(me.id)}
        >
          <img src={characterPortrait(me.characterId)} alt="" draggable={false} width={34} height={34} />
          <span className="mp-res__who">
            <b>{me.name}</b>
            <small>{tag}</small>
          </span>
        </button>
        <span className="mp-cur" title="现金：买地、认购原始股、缴费">
          <Icon id={CURRENCY_ICON.bell} size="s" />
          <b className={me.cash < 500 ? 'mp-cur--low' : ''}>{money(me.cash)}</b>
        </span>
        <span className="mp-cur" title="存款：可被动扣缴、月末计息、买卖上市股只能用它">
          <Icon id={CURRENCY_ICON.mile} size="s" />
          <b>{money(me.deposit)}</b>
        </span>
        <span className="mp-cur" title="点券：卡片与道具的唯一货币">
          <Icon id={CURRENCY_ICON.turnip} size="s" />
          <b>{money(me.points)}</b>
        </span>
      </div>

      {/* 状态唯一：回合 / 行动者 / 物价只在这一颗胶囊里说一次 */}
      <div className="mp-capsule" role="status">
        <span className="mp-avatars">
          {st.players.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`mp-ava${p.id === actor?.id ? ' mp-ava--on' : ' mp-ava--off'}${p.bankrupt ? ' mp-ava--dead' : ''}`}
              title={`${p.name}${p.id === actor?.id ? ' · 行动中' : ' · 点击查看他的钱包'}${p.bankrupt ? ' · 已破产' : ''}`}
              aria-label={`以 ${p.name} 的视角查看`}
              onClick={() => onPickViewport(p.id)}
            >
              <img src={characterPortrait(p.characterId)} alt="" draggable={false} width={26} height={26} />
            </button>
          ))}
        </span>
        <span className="mp-capsule__txt">
          {st.turn > 0 ? (
            <>
              第 <b className="mp-n2">{st.turn}</b> 回合 · 第 {st.round} 圈
              {st.maxDays ? <> / {st.maxDays}</> : null}
            </>
          ) : (
            '等待开局'
          )}
          <i className="mp-capsule__bar" />
          行动者 <b>{actor?.name ?? '—'}</b>
          <i className="mp-capsule__bar" />
          <span className={`mp-price${hot ? ' mp-price--hot' : ''}`} title="物价指数 = 全体存活玩家总资产 ÷（单人初始资金 × 开局人数）；买地、升级、租金、事件金额都乘它">
            物价 ×<b className="mp-n2">{view.priceIndex.toFixed(3)}</b>
          </span>
          {special ? <span className="mp-capsule__flag">{special}</span> : null}
        </span>
      </div>

      <div className="mp-top__acts">
        <button className="mp-iconbtn" type="button" title="播报（未读新消息）" onClick={onOpenLog}>
          <Icon id="i-log-move" />
          {unread > 0 && <span className="mp-n mp-n--pop">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <button className="mp-iconbtn" type="button" title="更多：岛况 / 账本 / 公布栏 / 规则" onClick={onOpenMore}>
          <Icon id="i-more" />
        </button>
        <button className="mp-iconbtn" type="button" title={muted ? '开启音效' : '静音'} onClick={onToggleMute}>
          <Icon id={muted ? 'i-mute' : 'i-sound'} />
        </button>
        <button className="mp-iconbtn" type="button" title="帮助：这一格怎么办，鼠标指过来就有" onClick={onOpenHelp}>
          <Icon id="i-question" />
        </button>
        <button className="mp-iconbtn" type="button" title="设置" onClick={onOpenSettings}>
          <Icon id="i-gear" />
        </button>
      </div>
    </header>
  );
}
