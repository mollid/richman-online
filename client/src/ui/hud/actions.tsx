/**
 * 动作清单的唯一来源：棋盘上那颗骰子、右侧面板的次操作、以及「更多动作」弹层，
 * 三处读的都是这里的 `buildActions()` / `landingExit()`。
 *
 * 门控位一律读 `view.actions`（= shared 的 `availableActions`），与引擎的 `actionRefusal`
 * 同源 —— 「按钮是亮的」与「引擎不会拒」是同一句话，不存在第二套判断。
 *
 * 这个文件从 `Dock.tsx` 里分出来：底部操作台拆成「棋盘上的骰子」与「右侧面板」两块之后，
 * 两边都要这份清单，再留在一个组件的模块里就会互相 import 成环。
 */
import { FACILITY_ICON, NPC_ICON, type PlayerAction } from '@richman/shared';
import type { AcSnapshot } from '../../game/acSnapshot.js';
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

export function phaseLabel(snap: AcSnapshot): string {
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
    row('buy', `买下「${name}」`, 'i-house', 'ok', '脚下是无主地产、现金够、且没在梦游（价格见右侧地契）', A.canBuy, { type: 'BUY_LAND' }),
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
 * 落格窗的那个出口：不是主操作（它是「不做」），所以排在骰子之外、用奶油色。
 * R4 之后玩家手上没有常驻的「结束回合」，只有这一句情境出口。
 */
export function landingExit(snap: AcSnapshot): { label: string; why: string } | null {
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
export function Pips({ value }: { value: number }) {
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
