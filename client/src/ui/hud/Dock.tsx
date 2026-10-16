/**
 * 底部操作台：只有三组 —— 当前格卡片 / 行囊入口（带数量角标）/ 主操作（实体骰子，视觉权重最大）。
 *
 * 旧 dock 同时摆了地块明细、6 格行囊、一整排动作按钮和相机提示条，四组信息抢同一行高度。
 * 现在：
 * - **行囊收成一颗带角标的钮**：点开才是清单（原则 2「不常用收进抽屉」，护栏「2 次点击内可达」：
 *   钮 → 格子 → 就地展开的动作条，路径没有变长，只是不再常驻）；
 * - **动作按频率分层**：每回合都要按的那一颗做成骰子；其余收进「更多动作」，
 *   展开后仍是原来的按钮与原来的门控位，一个都没少；
 * - **相机提示只讲两句**（跟着谁 / 锁定中），操作手法那句在教学结束后淡出（见 `useGuidance`）。
 *
 * 门控位一律读 `view.actions`（= shared 的 `availableActions`），与引擎的 `actionRefusal`
 * 同源 —— 「按钮是亮的」与「引擎不会拒」是同一句话，不存在第二套判断。
 */
import { useEffect, useRef, useState } from 'react';
import { CELL_ICON, FACILITY_ICON, ITEM_ICON, NPC_ICON, type PlayerAction } from '@richman/shared';
import type { AcSnapshot } from '../../game/acSnapshot.js';
import { Icon } from '../mp/Icon.js';
import type { HandEntry } from '../HandQuickBar.js';

const money = (n: number) => Math.round(n).toLocaleString('zh-CN');

/** 一颗主操作钮 + 若干次操作钮。`act` 带 `__open` 的是要开面板的，不是直接派单 */
export interface ActRow {
  key: string;
  label: string;
  icon: string;
  /** 语义档：主操作绿强调、开面板蓝、要花钱橙 */
  variant: 'ok' | 'primary' | 'accent' | 'ghost';
  why: string;
  enabled: boolean;
  act: (PlayerAction & { __open?: string; entry?: HandEntry }) | { __open: string; entry?: HandEntry };
}

const NPC_CN: Record<string, string> = { thief: '小偷', protection: '保护费流氓', robber: '强盗', 'rent-thief': '收租恶霸' };

/** 把 `awaiting_action` 这类实现枚举翻成人话（R4：落格窗分「单步」与「会话」两种出口） */
const PHASE_CN: Record<string, string> = {
  lobby: '大厅等待开局',
  awaiting_roll: '等待掷骰',
  awaiting_action: '落格处理中',
  awaiting_pick: '小游戏中',
  awaiting_auction: '拍卖中',
  awaiting_discard: '手牌额满',
  game_over: '对局结束',
};

function phaseLabel(snap: AcSnapshot): string {
  const st = snap.state;
  const A = snap.view.actions;
  const base = PHASE_CN[st.phase] ?? st.phase;
  if (st.phase !== 'awaiting_action' || !A.landing) return base;
  const name = st.board[A.landing.cellId]?.name ?? '';
  if (A.landing.venue === 'shop') return `在${name}购物`;
  if (A.landing.venue === 'bank') return `在${name}办事`;
  return `停在${name} · 处理完自动结束`;
}

/**
 * 动作清单。逐条对齐 `hud.js:actionSpec()`，只把 emoji 换成图标、把「是否可用」的口径保持不变。
 */
export function buildActions(snap: AcSnapshot): ActRow[] {
  const { state: st, view } = snap;
  const A = view.actions;
  const cur = st.players[st.currentPlayerIndex];
  if (!cur) return [];
  const foot = st.board[cur.position];
  const name = foot?.name ?? '';
  const magicLabel = (c: string) => view.names.magicConditions?.[c] ?? c ?? '';

  /* 股市入口的门控：自己回合 + 未破产就能打开面板。
     面板里除了上市股还挂着公司原始股，一级市场按面值申购不受休市与停牌约束，
     拿 canTradeStock 当门户会让玩家在例假日连转手都做不了。 */
  const stockOpenable = A.canTradeStock || !!view.canOpenStock;
  const stockWhy = A.canTradeStock
    ? '上市股只花存款'
    : st.stockHaltAllDays > 0
      ? `全市场停牌还剩 ${st.stockHaltAllDays} 天：上市股不能动，原始股照常认购`
      : view.date.isHoliday
        ? '例假日休市：上市股不能动，原始股照常认购'
        : '只有自己回合（掷骰前那一段）能开股市';

  const row = (
    key: string,
    label: string,
    icon: string,
    variant: ActRow['variant'],
    why: string,
    enabled: boolean,
    act: ActRow['act'],
  ): ActRow => ({ key, label, icon, variant, why, enabled, act });

  return [
    row('roll', '掷骰', 'i-dice', 'ok', '只有「等待掷骰」阶段能按，且必须有行动权', A.canRoll, { type: 'ROLL_DICE' }),
    row('buy', `买下「${name}」`, 'i-house', 'ok', '脚下是无主地产、现金够、且没在梦游（价格见左侧格块）', A.canBuy, { type: 'BUY_LAND' }),
    row('upgrade', '加盖一层', 'i-house', 'ok', '脚下是自己的地，未达 5 级', A.canUpgrade, { type: 'UPGRADE_LAND' }),
    ...A.buildableFacilities.map((f) =>
      row(`fac-${f}`, `建「${view.names.facilities[f]?.name ?? f}」`, FACILITY_ICON[f], 'primary', '商业用地上可选的设施', true, { type: 'BUILD_FACILITY', facility: f }),
    ),
    ...(A.canBuyShares
      ? [row('shares', `认购原始股 ${money(A.sharePrice)} ×${A.shareQuantityLimit}`, 'i-deed', 'accent', '只有踩到公司格才开这个窗口：现金按面值，当回合锁定不能卖；转手在股市面板按市价、入存款', true, { type: 'BUY_SHARES', cellId: cur.position, quantity: A.shareQuantityLimit })]
      : []),
    row('dep', '存款 / 取款', 'i-bank', 'primary', '月末计息，取出来才能付现钱', A.canDeposit || A.canWithdraw, { __open: 'bank' }),
    row('loan', '贷款 / 还款', 'i-bank', 'primary', '额度上限＝开局资金，3 个月到期必须还清', A.canLoan || A.canRepayLoan, { __open: 'bank' }),
    row('shop', '进商店', 'i-cart', 'primary', '脚下是商店格', A.canShop, { __open: 'shop' }),
    row('stock', '开股市', 'i-chart', 'primary', stockWhy, stockOpenable, { __open: 'stock' }),
    row('lottery', `买乐透 ${money(A.lotteryTicketCost)}`, 'i-slot', 'accent', `一注 ${money(A.lotteryTicketCost)}，每月 15 号开奖`, A.canBuyLottery, { __open: 'lottery' }),
    ...A.bailableVillains.map((k) =>
      row(`bail-${k}`, `保释${NPC_CN[k] ?? k} ${A.bailFee}点券`, NPC_ICON[k], 'accent', '收编恶人，它去偷别人的钱，你抽成', true, { type: 'BAIL_PRISONER', npcKind: k }),
    ),
    ...A.dischargeablePatients.map((id) =>
      row(`dis-${id}`, `让 ${st.players.find((p) => p.id === id)?.name ?? id} 出院 ${money(A.dischargeFee)}`, 'i-med', 'accent', '替他垫钱，攒个人情', true, { type: 'DISCHARGE_PATIENT', targetPlayerId: id }),
    ),
    ...(A.magic
      ? [row('magic', `施法（${magicLabel(A.magic.condition)}）`, 'i-crystal', 'accent', '水晶球只报标语：谁对得上要自己判断，符合条件的人一个都跑不掉；落到谁头上由你选魔法决定', true, { __open: 'magic' })]
      : []),
    ...(A.estateBuildCells.length
      ? [row('estate', `房地产公司加盖（${A.estateBuildCells.length} 处可选）`, 'i-office', 'accent', '董事长特权，施工费＝该地地价 ×50%', true, { __open: 'company' })]
      : []),
    ...(A.canFinancing
      ? [row('fin', `特别融资（剩 ${money(A.financingRemaining)}）`, 'i-office', 'accent', '企业银行董事长专属，期间存款不计息', true, { __open: 'company' })]
      : []),
    row('surrender', '认输投降', 'i-exit', 'ghost', '干净退出，但必须指定一人被死神附身 13 天', A.canSurrender, { __open: 'surrender' }),
  ];
}

/**
 * 落格窗的那个出口：不是主操作（它是「不做」），所以排在骰子之后、用奶油色。
 * R4 之后玩家手上没有常驻的「结束回合」，只有这一句情境出口。
 */
function landingExit(snap: AcSnapshot): { label: string; why: string } | null {
  const A = snap.view.actions;
  if (!A.canFinishLanding) return null;
  const venue = A.landing?.venue ?? null;
  if (venue === 'shop') return { label: '离开商店', why: '买完再走：离开那一刻才把行动权交给下一个人' };
  if (venue === 'bank') return { label: '办完离开', why: '存取款与贷款可以接着办：离开那一刻才结束回合' };
  const label = A.canBuy
    ? '不买这块地'
    : A.canUpgrade
      ? '不加盖'
      : A.buildableFacilities.length
        ? '暂不建设'
        : A.researchableItems.length
          ? '暂不研发'
          : A.canBuyShares
            ? '不认购原始股'
            : A.bailableVillains.length
              ? '不保释'
              : A.dischargeablePatients.length
                ? '不办理出院'
                : A.canBuyLottery
                  ? '不买乐透'
                  : A.magic
                    ? '不施法'
                    : '这一格不做处理';
  return { label, why: '事件处理完就自动结束回合 —— 这一格没有别的事要办' };
}

/** 骰子面：3×3 九宫里点亮对应点位。点数超过 6 时直接写数（三颗以上骰的合计画不出面） */
function Pips({ value }: { value: number }) {
  const ON: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  const lit = ON[value];
  if (!lit) return <span className="mp-dice__num">{value}</span>;
  return (
    <span className="mp-dice__pips">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} className={lit.includes(i) ? 'on' : ''} />
      ))}
    </span>
  );
}

export function Dock({
  snap,
  interactive,
  camLocked,
  camTarget,
  camIso,
  camVisible,
  selCell,
  onSelectCell,
  onFire,
  onOpenPanel,
  bagFocusKey,
  guidance,
}: {
  snap: AcSnapshot;
  interactive: boolean;
  camLocked: boolean;
  /** 镜头正跟着谁（由舞台钩子每帧核对后抛上来，只在真的变了才惊动 React） */
  camTarget: string;
  camIso: boolean;
  camVisible: number;
  /** 钉在卡片上的那一格（默认行动者脚下） */
  selCell: number;
  onSelectCell: (id: number) => void;
  onFire: (act: ActRow['act'], label: string) => void;
  /** 行囊那一格点开的是宿主的内联动作条（没有遮罩，棋盘始终可点） */
  onOpenPanel: (kind: string, arg?: unknown) => void;
  bagFocusKey: string | null;
  /** 首次出现的一次性气泡指引：key → 是否该显示（见 useGuidance） */
  guidance: Record<string, boolean>;
}) {
  const { state: st, view } = snap;
  const A = view.actions;
  const cur = st.players[st.currentPlayerIndex];
  const me = st.players.find((p) => p.id === view.myPlayerId) ?? cur;
  const [moreOpen, setMoreOpen] = useState(false);
  const [bagOpen, setBagOpen] = useState(false);
  const [spin, setSpin] = useState(false);
  const spinTimer = useRef(0);

  /* 骰子只在真掷的那一手转一下：按下就起动画，快照回来（点数到了）自然停 */
  useEffect(() => () => window.clearTimeout(spinTimer.current), []);

  if (!cur || !me) return null;

  const rows = buildActions(snap).filter((r) => r.enabled);
  const primary = rows.find((r) => r.key === 'roll') ?? rows.find((r) => r.key === 'buy') ?? rows.find((r) => r.key === 'upgrade') ?? null;
  const secondary = rows.filter((r) => r !== primary);
  const exit = landingExit(snap);

  /* 停留态（在押 / 住院 / 出国）：不给按钮，只说清「回合会自己走」。
     引擎那一侧同一条判据是 stayRefusal，这里只是翻成玩家看得见的一句话。 */
  const stay =
    cur.skipTurns > 0
      ? `${cur.custody ? (cur.custody.kind === 'jail' ? '在押' : '住院') : cur.abroadTurns > 0 ? '出国' : '停留'}中 · 无法操作，回合自动跳过（剩 ${cur.skipTurns} 回合）`
      : null;

  const cell = st.board[selCell] ?? st.board[cur.position];
  if (!cell) return null;
  const onFoot = selCell === cur.position;
  const corp = st.companies.find((c) => (c.footprint?.length ? c.footprint : [c.cellId]).includes(selCell));
  const ownerId = view.owners[cell.id];
  const price = Math.round((cell.price ?? 0) * view.priceIndex);
  const dice = st.dice ?? [];
  const total = dice.reduce((a, b) => a + b, 0);
  const items = Object.entries(me.items);
  const itemCount = items.reduce((n, [, q]) => n + q, 0);
  const bagCount = itemCount + me.cards.length;

  const fire = (r: ActRow) => {
    if (r.key === 'roll') {
      setSpin(true);
      window.clearTimeout(spinTimer.current);
      spinTimer.current = window.setTimeout(() => setSpin(false), 620);
    }
    onFire(r.act, r.label);
    setMoreOpen(false);
  };

  return (
    <footer className={`mp-dock mp-panel${camLocked ? ' mp-dock--locked' : ''}`}>
      {/* --- 1. 当前格卡片 --- */}
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
            <button className="mp-btn mp-btn--sm mp-btn--ghost" type="button" title="把卡片收回行动者脚下那一格" onClick={() => onSelectCell(cur.position)}>
              回到脚下
            </button>
          )}
        </div>
        <div className="mp-tile__rows">
          {corp ? (
            <span>面值 <b className="mp-n2">{money(corp.sharePrice)}</b> · 这家公司占 {corp.footprint?.join('·') ?? cell.id} 格，踩到哪一格都能认购</span>
          ) : cell.price ? (
            <span>{onFoot && A.canBuy ? '售价' : '地价'} <b className="mp-n2">{money(price)}</b></span>
          ) : null}
          {cell.baseRent ? <span>租金 <b className="mp-n2">{money(cell.baseRent * view.priceIndex)}</b>/级</span> : null}
          <span>
            归属 <b>{ownerId ? st.players.find((p) => p.id === ownerId)?.name ?? '?' : '无主'}</b>
          </span>
          {corp ? <span>经营权 <b>{corp.chairmanId ? st.players.find((p) => p.id === corp.chairmanId)?.name ?? '?' : '空缺'}</b></span> : null}
          <span>
            骰子 <b className="mp-n2">{dice.length ? `${dice.join('+')}=${total}` : '未掷'}</b> · 骰力 <b className="mp-n2">{cur.diceCount}</b>
          </span>
        </div>
        {/* 这一句只说「引擎在等什么」，不重述回合 / 行动者 / 物价 —— 那三个数在顶栏胶囊里 */}
        <span className="mp-tile__phase">{phaseLabel(snap)}</span>
      </div>

      {/* --- 2. 行囊入口（角标 = 卡片 + 道具数） --- */}
      <div className="mp-bagwrap">
        <button
          className={`mp-bag${bagOpen ? ' mp-bag--on' : ''}`}
          type="button"
          aria-expanded={bagOpen}
          title={`卡片 ${me.cards.length}/15 · 道具 ${itemCount}（每种上限 9）`}
          onClick={() => {
            setBagOpen((v) => !v);
            setMoreOpen(false);
          }}
        >
          <Icon id="i-bag" size="l" />
          <span className="mp-bag__txt">
            行囊
            <small>{me.name} 的卡片与道具</small>
          </span>
          {bagCount > 0 && <span className="mp-n">{bagCount}</span>}
          {guidance.bag && <span className="mp-bubble">点开看清单：卡片道具都在这里用</span>}
        </button>

        {bagOpen && (
          <div className="mp-bagpop mp-panel" role="group" aria-label="行囊清单">
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
                      onClick={() => onOpenPanel('hand', { entry: { kind: 'item', id, i: 0 } })}
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
                      onClick={() => onOpenPanel('hand', { entry: { kind: 'card', id: cid, i } })}
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

      {/* --- 3. 主操作：骰子那颗视觉权重最大 --- */}
      <div className="mp-act">
        {secondary.length > 0 && (
          <div className="mp-morewrap">
            <button
              className="mp-btn mp-btn--ghost"
              type="button"
              aria-expanded={moreOpen}
              onClick={() => {
                setMoreOpen((v) => !v);
                setBagOpen(false);
              }}
            >
              <Icon id="i-more" size="s" />
              更多动作 {secondary.length}
            </button>
            {moreOpen && (
              <div className="mp-morepop mp-panel" role="group" aria-label="此刻可做的次操作">
                <div className="mp-morepop__t">此刻可做的次操作（共 {secondary.length}）</div>
                <div className="mp-morepop__grid">
                  {secondary.map((r) => (
                    <button key={r.key} className={`mp-btn mp-btn--${r.variant}`} type="button" title={r.why} onClick={() => fire(r)}>
                      <Icon id={r.icon} size="s" />
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {guidance.more && <span className="mp-bubble mp-bubble--up">其余动作都收在这里，一个没少</span>}
          </div>
        )}

        {stay ? (
          <span className="mp-stay">{stay}</span>
        ) : primary ? (
          <button
            className={`mp-dice mp-dice--${primary.key === 'roll' ? 'roll' : 'go'}`}
            type="button"
            data-primary="1"
            disabled={camLocked || !interactive}
            title={`${primary.label} · 回车或空格 ${primary.why}`}
            onClick={() => fire(primary)}
          >
            <span className={`mp-dice__cube${spin ? ' mp-dice__cube--spin' : ''}`}>
              {primary.key === 'roll' ? <Pips value={dice.length ? total : 1} /> : <Icon id={primary.icon} size="l" />}
            </span>
            <span className="mp-dice__label">
              <b>{primary.label}</b>
              <small>回车 · 空格</small>
            </span>
          </button>
        ) : !interactive ? (
          <span className="mp-stay">等待对方操作</span>
        ) : secondary.length === 0 ? (
          /* 只有「真的什么都没有」才说这句：会话窗（银行 / 商店）没有主 CTA，但次操作与出口都在 */
          <span className="mp-stay">此刻没有可执行的操作</span>
        ) : null}

        {exit && (
          <button className="mp-btn mp-btn--ghost" type="button" title={exit.why} disabled={camLocked || !interactive} onClick={() => onFire({ type: 'FINISH_LANDING' }, exit.label)}>
            <Icon id="i-arrow-right" size="s" />
            {exit.label}
          </button>
        )}
      </div>

      {/* 相机只报两句：跟着谁、是不是还在飞。操作手法那句属于教学，教完就淡出 */}
      <div className="mp-camnote" role="status" aria-live="polite">
        {camLocked ? (
          <span className="mp-camnote--lock">
            <Icon id="i-lock" size="s" /> 镜头聚焦中 · 操作已屏蔽
          </span>
        ) : (
          <span>
            <Icon id="i-cam" size="s" /> 镜头跟随 <b>{camTarget || '—'}</b>
            {camIso ? <> · 近景 {camVisible} 格</> : null}
            <em>轮到谁操作，镜头就交给谁</em>
          </span>
        )}
        {guidance.cam && <span className="mp-bubble mp-bubble--up">拖拽转视角 · 滚轮推拉 · 悬停看格子 · 点击钉到这张卡片</span>}
      </div>
    </footer>
  );
}

/* ITEM_ICON 是 Record<string,…>，指不到 symbol 时 <use> 什么都不画（连兜底都没有），
   所以缺键必须给一枚明确的替代。完整性由 shared/test/icons.test.ts 盯着。 */
const ITEM_ICON_SAFE = (id: string) => ITEM_ICON[id] ?? 'i-gift';
