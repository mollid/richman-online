/**
 * 右侧面板：原来摊在底部操作台上的一整排，搬进这一列。
 *
 * 顺序按「现在最想知道什么」排，从上到下：
 *   1. 当前格地契 —— 踩在哪、多少钱、谁的；这是每手必看的唯一一块；
 *   2. 行囊 —— 收成一颗带角标的钮，点开就地铺清单（不弹浮层，面板本身就是抽屉）；
 *   3. 数据页签 —— 岛况 / 账本 / 岛民 / 播报，点开是浮在盘面上的大表格；
 *   4. 脚下四个小件 —— 规则 / 存档 / 读档 / 退出，尺寸压到最小，不与第 1 块抢注意力。
 *
 * 面板整体 grid 两行（可滚的正文 + 贴底小件栏）：正文再长也只在自己那一格里滚，
 * 退出永远在视线里，不需要为了退出先去滚一遍。
 */
import { useState } from 'react';
import { CELL_ICON, ITEM_ICON } from '@richman/shared';
import type { AcSnapshot } from '../../game/acSnapshot.js';
import { Icon } from '../mp/Icon.js';
import type { HandEntry } from '../HandQuickBar.js';
import { phaseLabel } from './actions.js';
import { DRAWER_TABS, type DrawerTab } from './Drawer.js';

const money = (n: number) => Math.round(n).toLocaleString('zh-CN');

/* ITEM_ICON 是 Record<string,…>，指不到 symbol 时 <use> 什么都不画（连兜底都没有），
   所以缺键必须给一枚明确的替代。完整性由 shared/test/icons.test.ts 盯着。 */
const ITEM_ICON_SAFE = (id: string) => ITEM_ICON[id] ?? 'i-gift';

export function SidePanel({
  snap,
  selCell,
  onSelectCell,
  onOpenPanel,
  bagFocusKey,
  guideBag,
  drawer,
  onOpenDrawer,
  isRemote,
  onOpenHelp,
  onSaveGame,
  onLoadGame,
  onExit,
}: {
  snap: AcSnapshot;
  /** 钉在地契上的那一格（默认行动者脚下） */
  selCell: number;
  onSelectCell: (id: number) => void;
  /** 行囊那一格点开的是宿主的内联动作条（没有遮罩，棋盘始终可点） */
  onOpenPanel: (kind: string, arg?: unknown) => void;
  bagFocusKey: string | null;
  guideBag: boolean;
  drawer: DrawerTab | null;
  onOpenDrawer: (tab: DrawerTab | null) => void;
  isRemote: boolean;
  onOpenHelp: () => void;
  onSaveGame?: () => void;
  onLoadGame?: () => void;
  onExit: () => void;
}) {
  const { state: st, view } = snap;
  const A = view.actions;
  const cur = st.players[st.currentPlayerIndex];
  const me = st.players.find((p) => p.id === view.myPlayerId) ?? cur;
  const [bagOpen, setBagOpen] = useState(false);

  if (!cur || !me) return null;

  const cell = st.board[selCell] ?? st.board[cur.position];
  if (!cell) return null;
  const onFoot = selCell === cur.position;
  const corp = st.companies.find((c) => (c.footprint?.length ? c.footprint : [c.cellId]).includes(selCell));
  const ownerId = view.owners[cell.id];
  const price = Math.round((cell.price ?? 0) * view.priceIndex);
  const items = Object.entries(me.items);
  const itemCount = items.reduce((n, [, q]) => n + q, 0);
  const bagCount = itemCount + me.cards.length;

  return (
    <aside className="mp-side" aria-label="当前状况">
      <div className="mp-side__bd">
        {/* --- 1. 当前格：一张地契，不是一张表 --- */}
        <div className="mp-tile">
          <div className="mp-tile__hd">
            <Icon id={CELL_ICON[cell.type]} size="l" />
            <span className="mp-tile__name">
              <b>{cell.name}</b>
              <small>
                {onFoot ? '脚下' : '选中'} · {cell.id} 号格
              </small>
            </span>
            {!onFoot && (
              <button className="mp-btn mp-btn--sm mp-btn--ghost" type="button" title="把地契收回行动者脚下那一格" onClick={() => onSelectCell(cur.position)}>
                回到脚下
              </button>
            )}
          </div>
          <div className="mp-tile__rows">
            {corp ? (
              <span>
                面值 <b className="mp-n2">{money(corp.sharePrice)}</b> · 这家公司占 {corp.footprint?.join('·') ?? cell.id} 格，踩到哪一格都能认购
              </span>
            ) : cell.price ? (
              <span>
                {onFoot && A.canBuy ? '售价' : '地价'} <b className="mp-n2">{money(price)}</b>
              </span>
            ) : null}
            {cell.baseRent ? (
              <span>
                租金 <b className="mp-n2">{money(cell.baseRent * view.priceIndex)}</b>/级
              </span>
            ) : null}
            <span>
              归属 <b>{ownerId ? st.players.find((p) => p.id === ownerId)?.name ?? '?' : '无主'}</b>
            </span>
            {corp ? (
              <span>
                经营权 <b>{corp.chairmanId ? st.players.find((p) => p.id === corp.chairmanId)?.name ?? '?' : '空缺'}</b>
              </span>
            ) : null}
          </div>
          {/* 这一句只说「引擎在等什么」，不重述回合 / 行动者 / 物价 —— 那三个数在顶栏胶囊里 */}
          <span className="mp-tile__phase">{phaseLabel(snap)}</span>
        </div>

        {/* --- 2. 行囊：一颗带角标的钮，点开就地铺清单 --- */}
        <div className="mp-bagwrap">
          <button
            className={`mp-bag${bagOpen ? ' mp-bag--on' : ''}`}
            type="button"
            aria-expanded={bagOpen}
            title={`卡片 ${me.cards.length}/15 · 道具 ${itemCount}（每种上限 9）`}
            onClick={() => setBagOpen((v) => !v)}
          >
            <Icon id="i-bag" size="l" />
            <span className="mp-bag__txt">
              行囊
              <small>{me.name} 的卡片与道具</small>
            </span>
            {bagCount > 0 && <span className="mp-n">{bagCount}</span>}
            {guideBag && <span className="mp-bubble">点开看清单：卡片道具都在这里用</span>}
          </button>

          {bagOpen && (
            <div className="mp-baglist" role="group" aria-label="行囊清单">
              {!bagCount ? (
                <p className="mp-empty">空空如也：走到点券格 / 宝箱攒点券，去商店换卡片道具</p>
              ) : (
                <div className="mp-grid">
                  {items.map(([id, qty]) => {
                    const usable = A.usableItems.includes(id);
                    const nm = view.names.items[id]?.name ?? id;
                    const key = `item:${id}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`mp-slot${usable ? ' mp-slot--ok' : ' mp-slot--off'}${bagFocusKey === key ? ' mp-slot--on' : ''}`}
                        title={`${nm}：${view.names.items[id]?.desc ?? ''}`}
                        aria-expanded={bagFocusKey === key}
                        onClick={() => onOpenPanel('hand', { entry: { kind: 'item', id, i: 0 } as HandEntry })}
                      >
                        <span className="mp-slot__face">
                          <Icon id={ITEM_ICON_SAFE(id)} />
                          {qty > 1 && <b className="mp-slot__qty">{qty}</b>}
                        </span>
                        <span className="mp-slot__cap">{nm}</span>
                      </button>
                    );
                  })}
                  {me.cards.map((cid, i) => {
                    const usable = A.usableCards.includes(cid);
                    const nm = view.names.cards[cid]?.name ?? cid;
                    const key = `card:${cid}:${i}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`mp-slot${usable ? ' mp-slot--ok' : ' mp-slot--off'}${bagFocusKey === key ? ' mp-slot--on' : ''}`}
                        title={`${nm}：${view.names.cards[cid]?.desc ?? ''}`}
                        aria-expanded={bagFocusKey === key}
                        onClick={() => onOpenPanel('hand', { entry: { kind: 'card', id: cid, i } as HandEntry })}
                      >
                        <span className="mp-slot__face">
                          <Icon id="i-cards" />
                        </span>
                        <span className="mp-slot__cap">{nm}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {me.research && (
                <p className="mp-hint">
                  研发中：{view.names.items[me.research.itemId]?.name ?? me.research.itemId} · 剩 {me.research.remainDays} 天
                </p>
              )}
            </div>
          )}
        </div>

        {/* --- 3. 数据页签：点开是浮在盘面上的大表格 --- */}
        <div className="mp-side__tabs" aria-label="数据页签">
          {DRAWER_TABS.map((t) => (
            <button
              key={t.id}
              className={`mp-side__tab${drawer === t.id ? ' mp-side__tab--on' : ''}`}
              type="button"
              title={t.label}
              aria-pressed={drawer === t.id}
              onClick={() => onOpenDrawer(drawer === t.id ? null : t.id)}
            >
              <Icon id={t.icon} size="s" />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* --- 4. 脚下小件：尺寸压到最小，退出常驻在视线里 --- */}
      <div className="mp-side__foot">
        <button className="mp-side__mini" type="button" title="规则：这一格怎么办，鼠标指过来就有" onClick={onOpenHelp}>
          <Icon id="i-question" size="s" />
          <span>规则</span>
        </button>
        {!isRemote && onSaveGame && (
          <button className="mp-side__mini" type="button" title="存档" onClick={onSaveGame}>
            <Icon id="i-save" size="s" />
            <span>存档</span>
          </button>
        )}
        {!isRemote && onLoadGame && (
          <button className="mp-side__mini" type="button" title="读档" onClick={onLoadGame}>
            <Icon id="i-load" size="s" />
            <span>读档</span>
          </button>
        )}
        <button className="mp-side__mini mp-side__mini--quit" type="button" title="退出对局" onClick={onExit}>
          <Icon id="i-exit" size="s" />
          <span>退出</span>
        </button>
      </div>
    </aside>
  );
}
