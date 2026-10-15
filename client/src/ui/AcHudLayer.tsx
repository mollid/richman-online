/**
 * ac-HUD 挂载层：把 `client/public/ac-hud/` 的动物森林 HUD（three.js 2.5D 棋盘 + Pixi 名牌 + DOM 面板）
 * 接进 React。HUD 本体是 vanilla IIFE，通过全局 `window.AC_HUD` 暴露 update/setHost/destroy 三个口子。
 *
 * 数据流：App 的 `GameState` → `buildAcSnapshot()` → `window.GAME_SNAPSHOT` / `AC_HUD.update()`。
 * 动作流：HUD 的 dock 按钮 → `AC_HUD.setHost({ dispatch })` → 真实 `session.dispatch()`。
 * 需要填金额 / 挑一堆物件的动作（存取款、商店、股市、乐透、挂出、用法术…）走 `openPanel(kind, payload)`，
 * 在本组件里用 ac 皮肤的弹层托管既有 React 面板 —— 这一步是「壳换皮、流程不丢」的临时桥，
 * 后续可把这些面板逐个重做进 ac 皮肤。
 * 手牌 / 道具是例外（`kind === 'hand'`）：那是本局最高频的动作，遮罩会把棋盘点击吃掉，
 * 所以它不开面板，改在行囊格上方就地展开一条 `HandQuickBar`，棋盘全程可见可点。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { actionRefusal } from '@richman/shared';
import type { GameState, PlayerAction } from '@richman/shared';
import { buildAcSnapshot } from '../game/acSnapshot.js';
import { ControlPanel } from './ControlPanel.js';
import { BankPanel } from './BankPanel.js';
import { ShopPanel } from './ShopPanel.js';
import { StockPanel } from './StockPanel.js';
import { LotteryPanel } from './LotteryPanel.js';
import { TradePanel } from './TradePanel.js';
import { AuctionPanel } from './AuctionPanel.js';
import { NpcPanel } from './NpcPanel.js';
import { CompanyPanel } from './CompanyPanel.js';
import { entryKey, HandQuickBar, type HandEntry, type PickRequest } from './HandQuickBar.js';
import './acHudClient.css';

type AcHostTool = { label: string; title?: string; onClick?: () => void };
type AcHostApi = {
  dispatch: ((a: PlayerAction) => void) | null;
  openPanel: ((kind: string, arg?: unknown) => void) | null;
  /**
   * 选格模式下 HUD 把点到的那一格原样交回（W2）。
   * 合法性不在表现层判 —— 由 React 拿引擎的 `actionRefusal` 说一句话，两处永不分叉。
   */
  onPickCell: ((cellId: number) => void) | null;
  /** 选人模式（W3-d）：HUD 把点到的棋子 id 交回来，同样由 React 拿 `actionRefusal` 判 */
  onPickPlayer: ((pid: string) => void) | null;
  tag?: string;
  tools?: AcHostTool[];
  interactive?: boolean;
  /** 热座下为 true：表现层视角跟随当前行动者 */
  followCurrent?: boolean;
  /** 宿主弹层开着：HUD 让出键盘（回车不再掷骰）与 Esc */
  modalOpen?: boolean;
};
type AcHudGlobal = {
  update: (snap: unknown) => void;
  /** 移动演出落定了吗（未挂载 / 方环示意时按「已落定」处理） */
  isSettled?: () => boolean;
  setHost: (h: Partial<AcHostApi>) => void;
  /** 进入 / 退出「在棋盘上点一格 / 点一个人」模式（null = 退出）。被拒项的理由供 HUD 在 hover 时引用原话 */
  setPickTargets?: (t: {
    cells: number[];
    rejected?: { id: number; reason: string }[];
    players?: string[];
    playerRejected?: { id: string; reason: string }[];
  } | null) => void;
  /** 行囊里被点开的那一格（动作条的选中态由 HUD 画在格子上，两处才不会各说各话） */
  setBagFocus?: (key: string | null) => void;
  destroy: () => void;
  toast?: (t: string, tone?: string) => void;
};

declare global {
  interface Window {
    GAME_SNAPSHOT?: unknown;
    AC_HUD?: AcHudGlobal;
  }
}

const HUD_BASE = '/ac-hud';
const FONT_BASE = '/fonts';
const STYLE_IDS = ['ac-hud-fonts', 'ac-hud-font-pixel', 'ac-hud-skin', 'ac-hud-pixel-skin', 'ac-hud-shell'];

/**
 * 字体口味。`round` = 设计稿的圆体（默认），另两种把整套 HUD 换成像素中文。
 *
 * 像素口味不是「换个 font-family」就完事：像素字只有在设计字号的整数倍下才是清晰点阵，
 * 而 ac 皮肤的字阶是 9~16px 的细腻梯队 —— 13px 的缝合像素等于 12px 点阵被缩放 1.0833 倍，必糊。
 * 所以另挂一份 `ac-pixel.css`（由 tools/build-pixel-skin.py 从上游 CSS 机械派生），
 * 它会把这区间里的字号全部吸附到网格上。开关挂在 `<html>` 上，因为令牌定义在 `:root`，
 * 且弹层 / 横幅这些 React 部件是 `#ac-hud-root` 的兄弟节点。
 */
type FontMode = 'round' | 'pix12' | 'qiuye';

const FONT_MODES: FontMode[] = ['round', 'pix12', 'qiuye'];
const FONT_CLASS: Record<FontMode, string> = {
  round: '',
  pix12: 'ac-font-pix12',
  qiuye: 'ac-font-qiuye',
};
const FONT_LABEL: Record<FontMode, string> = {
  round: '圆体',
  pix12: '缝合像素',
  qiuye: '秋叶像素',
};
const FONT_KEY = 'ac-font-mode';

/** URL 参数优先于本地记忆，方便用脚本切口味截图：`?font=qiuye` */
function readFontMode(): FontMode {
  try {
    const q = new URLSearchParams(window.location.search).get('font');
    if (q && (FONT_MODES as string[]).includes(q)) return q as FontMode;
    const saved = window.localStorage.getItem(FONT_KEY);
    if (saved && (FONT_MODES as string[]).includes(saved)) return saved as FontMode;
  } catch {
    /* 隐私模式下 localStorage 会抛，忽略即可 */
  }
  return 'round';
}

/**
 * 注入 HUD 需要的样式表（挂载时装、卸载时撤，避免与 client 既有全局样式长期打架）。
 *
 * 字体不再走 Google Fonts：`fonts.gstatic.com` 在国内基本连不通，实测每次加载刷 50+ 条
 * ERR_CONNECTION_CLOSED，还拖住 `document.fonts.ready`；而且 M PLUS Rounded 1c 是日文字体
 * （8201 码位），界面里的中文字有 1/3 它没有，会逐字回退到系统字，同一个词一半圆一半方。
 * 现在改为自托管 `client/public/fonts/fonts.css`（狮尾圆体 + M+ + Nunito，由
 * design/hud-ac/tools/build-fonts.py 子集化分片生成）。它必须排在皮肤之前，
 * 保证 @font-face 先于用它的规则出现。
 *
 * 像素字体的 `@font-face` 也一并挂上：声明本身只有 2.5KB，而字体文件要等页面真的用到
 * 那一族字才会下载，所以关着口味时零成本。
 */
function ensureHudStyles(): void {
  const sheets: Array<[string, string]> = [
    ['ac-hud-fonts', `${FONT_BASE}/fonts.css`],
    ['ac-hud-font-pixel', `${FONT_BASE}/pixel/fonts.css`],
    ['ac-hud-skin', `${HUD_BASE}/ac.css`],
    ['ac-hud-pixel-skin', `${HUD_BASE}/ac-pixel.css`],
    ['ac-hud-shell', `${HUD_BASE}/hud.css`],
  ];
  for (const [id, href] of sheets) {
    if (document.getElementById(id)) continue;
    const l = document.createElement('link');
    l.id = id;
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }
}

function releaseHudStyles(): void {
  for (const id of STYLE_IDS) document.getElementById(id)?.remove();
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-ac-hud="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.dataset.acHud = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`ac-HUD 脚本加载失败：${src}`));
    document.head.appendChild(s);
  });
}

/** 整条链只加载一次（React StrictMode 会双挂载，重复注入会把 IIFE 跑两遍） */
let loadPromise: Promise<void> | null = null;
function loadAcHud(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      await loadScript(`${HUD_BASE}/vendor/three.umd.min.js`);
      await loadScript(`${HUD_BASE}/vendor/pixi.min.js`);
      await loadScript(`${HUD_BASE}/world.js`);
      await loadScript(`${HUD_BASE}/overlay.js`);
      await loadScript(`${HUD_BASE}/hud.js`);
    })();
  }
  return loadPromise;
}

const PANEL_TITLE: Record<string, string> = {
  bank: '🏦 银行 · 存款 / 取款 / 贷款',
  shop: '🛍️ 商店',
  stock: '📈 股市 · 行情与原始股权益',
  lottery: '🎰 乐透行',
  trade: '🤝 公布栏 · 挂牌与买入',
  // 标题不再写「监狱保释」：这个面板只有水晶球会打开（保释与出院是 dock 上的直接动作，
  // 不走面板），留着那半截只会让人以为面板缺一块
  magic: '🔮 魔法屋 · 女巫的水晶球',
  company: '🏢 公司企业',
  auction: '🔨 拍卖会',
  surrender: '🚩 认输投降',
  control: '⏳ 请处理当前流程',
};

/**
 * 每个面板要多宽，由它自己的内容决定（见 acHudClient.css 的 --sm/--md/--wide）。
 * 只有股市是双表格 + K 线 + 长文案，非宽版不可 —— 其余按「单列表单 / 分区列表」分两档。
 */
const PANEL_SIZE: Record<string, 'sm' | 'md' | 'wide'> = {
  bank: 'md',
  shop: 'md',
  stock: 'wide',
  lottery: 'sm',
  trade: 'md',
  magic: 'md',
  company: 'md',
  auction: 'md',
  surrender: 'md',
  control: 'md',
};

export function AcHudLayer({
  game,
  myPlayerId,
  isRemote,
  interactive,
  muted,
  connection,
  netError,
  roomId,
  onAction,
  onToggleMute,
  onOpenSettings,
  onOpenHelp,
  onSaveGame,
  onLoadGame,
  onExit,
  onStartGame,
  onAddBot,
}: {
  game: GameState;
  myPlayerId: string | null;
  isRemote: boolean;
  interactive: boolean;
  muted: boolean;
  connection: 'connected' | 'reconnecting' | 'closed';
  netError: string;
  roomId?: string;
  onAction: (a: PlayerAction) => void;
  onToggleMute: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onSaveGame?: () => void;
  onLoadGame?: () => void;
  onExit: () => void;
  onStartGame?: () => void;
  onAddBot?: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [panel, setPanel] = useState<string | null>(null);
  /** 行囊里被点开的那一格（内联动作条的目标），null = 收起 */
  const [handSel, setHandSel] = useState<HandEntry | null>(null);
  /** 动作条的定位盒：跟着 HUD 的行囊格重量出来，HUD 整壳重建也不会错位 */
  const [quickBox, setQuickBox] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [fontMode, setFontMode] = useState<FontMode>(readFontMode);

  /* ---------------- 选目标模式（W2）----------------
   * 状态机只有三个结：面板发起 → HUD 报回一格 → 填满派单或退回继续选。
   *
   * 三条刻意的取舍：
   * 1. **合法性在这里问引擎**（`actionRefusal`），不在表现层复制一套判断 —— 与 W1 同一个理由；
   * 2. 点了非法格**留在选态**并播引擎那句理由，玩家马上就能改点另一格，不必回头再按一次「使用」；
   * 3. 回合换了就退出：手里的请求是在上一位的局面下算出来的候选，留着它会派一个已经非法的动作。 */
  const [pick, setPick] = useState<PickRequest | null>(null);
  /** 上一次被拒的理由：留在横幅上看得见，不依赖 HUD 的 toast（脚本没加载完就没有 toast） */
  const [pickHint, setPickHint] = useState('');
  /**
   * 发起「在棋盘上点一格 / 点一个人」。
   *
   * 发起方只有行囊动作条一家，而它本来就无遮罩，所以这里**不收弹层也不收条**：
   * 选格期间那条一直挂着，玩家看得见自己是在对哪张卡下手，Esc 或点「收起」才退出。
   */
  const requestPick = useCallback((req: PickRequest) => {
    setPick(req);
    setPickHint('');
  }, []);
  const cancelPick = useCallback(() => {
    setPick(null);
    setPickHint('');
  }, []);
  /** 收起动作条：连带退出选目标态，否则棋盘上还挂着一圈来自这一格的绿环 */
  const dismissHand = useCallback(() => {
    setHandSel(null);
    setPick(null);
    setPickHint('');
  }, []);
  /** 选人到这一步才派单：合法性仍由引擎那一个谓词裁决，界面只负责把 id 递过去 */
  const onPickPlayer = useCallback(
    (pid: string) => {
      if (!pick) return;
      const next = { ...pick.action, targetPlayerId: pid } as PlayerAction;
      const refusal = actionRefusal(game, next);
      if (refusal !== null) {
        setPickHint(refusal);
        window.AC_HUD?.toast?.(refusal, 'warn');
        return;
      }
      setPick(null);
      setPickHint('');
      onAction(next);
    },
    [pick, game, onAction],
  );
  const onPickCell = useCallback(
    (cellId: number) => {
      if (!pick) return;
      /* 选人态下点到的是一格（没正好点到棋子）：把那一格上站着的候选人当目标 ——
         玩家瞄的是人，不该因为指针偏了两像素就失败。格上没人则原样退回一句话。 */
      if (!pick.cells.length && pick.players?.length) {
        const q = game.players.find((p) => p.position === cellId && pick.players!.includes(p.id));
        if (q) onPickPlayer(q.id);
        else {
          const r = '那一格上没有可选的人';
          setPickHint(r);
          window.AC_HUD?.toast?.(r, 'warn');
        }
        return;
      }
      const next = { ...pick.action, cellId } as PlayerAction;
      const refusal = actionRefusal(game, next);
      if (refusal !== null) {
        // 非法格：把引擎那句话原样播出来，并**留在选态**让玩家改点另一格
        setPickHint(refusal);
        window.AC_HUD?.toast?.(refusal, 'warn');
        return;
      }
      setPick(null);
      setPickHint('');
      onAction(next);
    },
    [pick, game, onAction, onPickPlayer],
  );
  /* Esc 一层一层退：选格中 → 只退出选格（动作条留着，玩家能改主意再按一次使用）；没在选格 → 收起动作条。
     两个监听都挂在 window 的捕获阶段，`stopPropagation` 挡不住同节点的另一个监听器，
     所以规矩是「每个 handler 只管自己那一层」，而不是谁抢先把事件吃掉。 */
  useEffect(() => {
    if (!handSel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (pick) setPick(null);
      else dismissHand();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handSel, pick, dismissHand]);

  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPick(null);
    };
    // 捕获阶段拦一下：Esc 同时被弹层监听，选格时不该顺手把面板也关掉
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pick]);
  useEffect(() => setPick(null), [game.currentPlayerIndex, game.turn]);

  /* 口味类挂在 <html> 上。卸载时摘掉，避免离开对局后还把大厅的圆体换掉。
     顺手写进 localStorage 与 data 属性 —— 后者让自动化脚本能回读当前口味。 */
  useEffect(() => {
    const el = document.documentElement;
    const classes = Object.values(FONT_CLASS).filter(Boolean) as string[];
    for (const c of classes) el.classList.remove(c);
    const cls = FONT_CLASS[fontMode];
    if (cls) el.classList.add(cls);
    el.dataset.acFont = fontMode;
    try {
      window.localStorage.setItem(FONT_KEY, fontMode);
    } catch {
      /* 隐私模式，忽略 */
    }
    return () => {
      for (const c of classes) el.classList.remove(c);
      delete el.dataset.acFont;
    };
  }, [fontMode]);

  const snapshot = useMemo(() => buildAcSnapshot(game, myPlayerId), [game, myPlayerId]);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

  /**
   * HUD 要开一个界面。
   *
   * `hand` 不再走模态弹窗：手牌 / 道具是本局最高频的操作，弹层带遮罩会把棋盘点击吃掉
   * （旧代码里 `requestPick` 第一件事就是 `setPanel(null)` 为的就是这个），所以它改成
   * 在行囊格**上方**就地展开一条动作条；其余（银行 / 商店 / 股市…是表单，拍卖 / 小游戏是强制流程）仍是弹窗。
   */
  const openPanel = useCallback((kind: string, arg?: unknown) => {
    if (kind === 'hand') {
      setPanel(null);
      const next = (arg as { entry?: HandEntry } | undefined)?.entry ?? null;
      // 再点同一格 = 收起：没有遮罩，玩家没有「点外面关掉」这个习惯可依赖，得给一条原路退回
      setHandSel((prev) => (next && prev && entryKey(prev) === entryKey(next) ? null : next));
      return;
    }
    setHandSel(null);
    setPanel(kind);
  }, []);

  const tools = useMemo<AcHostTool[]>(() => {
    const next = () => setFontMode((m) => FONT_MODES[(FONT_MODES.indexOf(m) + 1) % FONT_MODES.length]!);
    const list: AcHostTool[] = [
      {
        label: fontMode === 'round' ? '🔤' : '🕹',
        title: `字体口味：${FONT_LABEL[fontMode]} · 点击切换（圆体 → 缝合像素 → 秋叶像素）`,
        onClick: next,
      },
      { label: muted ? '🔇' : '🔊', title: muted ? '开启音效' : '静音', onClick: onToggleMute },
      { label: '❓', title: '帮助', onClick: onOpenHelp },
      { label: '⚙️', title: '设置', onClick: onOpenSettings },
    ];
    if (!isRemote && onSaveGame && onLoadGame) {
      list.push({ label: '💾', title: '存档', onClick: onSaveGame }, { label: '📂', title: '读档', onClick: onLoadGame });
    }
    list.push({ label: '退出', title: '退出对局', onClick: onExit });
    return list;
  }, [fontMode, muted, isRemote, onSaveGame, onLoadGame, onToggleMute, onOpenHelp, onOpenSettings, onExit]);

  // 首次挂载：装样式 → 塞首个快照 → 载脚本
  //
  // 门槛 `hasRoster`：HUD 只在「有玩家可以画」时才挂载。联机会话的首帧是 `emptyState()`
  // （players: []），而 hud.js 在 IIFE 里就要读 `cur.position`（选中格 = 行动者脚下）——
  // 空名单直接抛 TypeError，脚本 onload 却照样 resolve，于是 window.AC_HUD 永远不存在，
  // 之后真实状态到了也没人渲染：联机整屏空白，开局后依然是空白。
  const hasRoster = game.players.length > 0;
  useEffect(() => {
    if (!hasRoster) return;
    let cancelled = false;
    ensureHudStyles();
    window.GAME_SNAPSHOT = snapRef.current;
    loadAcHud()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '加载失败');
      });
    return () => {
      cancelled = true;
      window.AC_HUD?.destroy();
      releaseHudStyles();
    };
  }, [hasRoster]);

  // 数据 / 宿主能力变更：注入并整壳重绘
  const dispatch = useCallback((a: PlayerAction) => onAction(a), [onAction]);
  useEffect(() => {
    if (!ready) return;
    const AC = window.AC_HUD;
    if (!AC) return;
    AC.setHost({
      dispatch,
      openPanel,
      onPickCell,
      onPickPlayer,
      tag: isRemote ? '联机' : '热座',
      tools,
      interactive,
      /* 热座：一台机器轮流操作，「表现层视角」应跟着当前行动者走；联机：锁在自己身上 */
      followCurrent: !isRemote,
    });
    AC.update(snapshot);
    /* 选格集合每次快照重推：候选是引擎算的，回合一动就可能变（例如对手走出了视野） */
    AC.setPickTargets?.(
      pick
        ? { cells: pick.cells, rejected: pick.rejected, players: pick.players ?? [], playerRejected: pick.playerRejected ?? [] }
        : null,
    );
    AC.setBagFocus?.(handSel ? entryKey(handSel) : null);
  }, [ready, snapshot, dispatch, openPanel, onPickCell, onPickPlayer, tools, interactive, isRemote, pick, handSel]);

  /* 动作条贴在行囊格**上方**（往上长才不压住 dock 里的骰子按钮）。
     HUD 每次快照都整壳重建 DOM（`hud.js:render()`），所以位置每次重量一遍，不是一次算完就存下来。
     条本身比行囊宽（名称 + 说明 + 参数 + 两个按钮），所以以行囊中心为锚再夹进视口，
     避免最后一格点开时整条溢出屏幕右边。 */
  useEffect(() => {
    if (!ready || !handSel) return;
    const measure = () => {
      const bag = document.querySelector('.hud-bag');
      if (!bag) return;
      const r = bag.getBoundingClientRect();
      const width = Math.min(560, window.innerWidth - 24);
      const left = Math.min(Math.max(12, r.left + r.width / 2 - width / 2), window.innerWidth - 12 - width);
      setQuickBox({ left, width, bottom: window.innerHeight - r.top + 10 });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ready, handSel, snapshot]);

  // 需要输入的阶段强制弹面板（小游戏 / 舍弃手牌 / 拍卖 / 结算）
  const forced = useMemo(() => {
    if (!ready) return null;
    if (game.phase === 'awaiting_auction') return 'auction';
    if (game.phase === 'awaiting_pick' || game.phase === 'awaiting_discard' || game.phase === 'game_over') return 'control';
    return null;
  }, [ready, game.phase]);

  // 阶段离开时，把手动打开的面板也收掉，避免残留在无事可做的界面
  useEffect(() => {
    if (game.phase === 'lobby') setPanel(null);
  }, [game.phase]);

  /* R4：面板跟着**落格决策窗**开，而不是跟着相位开。
   *
   * 两个条件必须同时成立：
   * ① `actions.landing` 在 —— 引擎真的把这一格交给当前玩家决策。旧的写法是看
   *    `phase === 'awaiting_action'` + 行动者脚下格自己猜，而 R4 之后终结动作在同一帧就把
   *    回合推进了，那一帧短到可以被整段跳过：靠相位猜会既弹错、又漏弹。
   * ② 演出落定 —— 引擎把「掷骰 → 走 n 步 → 落格」压成一个原子动作，快照到达时棋子还在路上；
   *    这时糊一层面板，玩家看到的是上一格的镜头配下一格的决定。所以轮询 `isSettled()`，
   *    跳完才弹（80ms 一量，落定即停；窗一变就取消，不留悬着的定时器）。
   *
   * 签名取「回合 + 行动者 + 格 + 场所」：同一个落点只弹一次，玩家自己关掉后不再骚扰。
   * 收层只收**我们自己弹开的那一种** —— dock 上「加盖 / 特别融资」开的也是公司面板，
   * 不该替玩家关掉他主动要看的东西。 */
  const landing = snapshot.view.actions.landing as { cellId: number; venue: string | null } | null;
  const { canDeposit, canWithdraw, canLoan, canRepayLoan } = snapshot.view.actions;
  const landingKind = useMemo(() => {
    if (!landing) return null;
    if (landing.venue === 'shop') return 'shop';
    // 银行面板的正文就是那四件事（`BankPanel` 的 `atBank` 读的同一份）：一件都办不了时它什么都不渲染，
    // 于是弹窗判据必须跟着正文一起收 —— 引擎把窗开着（企业银行董事长还能特别融资）时，
    // 弹一层只有「关闭」的空壳不如让 dock 那排按钮自己说话。
    if (landing.venue === 'bank') return canDeposit || canWithdraw || canLoan || canRepayLoan ? 'bank' : null;
    const cell = game.board[landing.cellId];
    if (!cell) return null;
    // 需要选目标 / 填金额的那几格才自动开面板；买地、加盖、保释这类 dock 上一个按钮就够
    if (cell.type === 'company') return 'company';
    if (cell.type === 'magic') return 'magic';
    if (cell.type === 'lottery') return 'lottery';
    return null;
  }, [landing, game.board, canDeposit, canWithdraw, canLoan, canRepayLoan]);

  const landingPromptRef = useRef<string | null>(null);
  const autoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!landing || !landingKind) {
      landingPromptRef.current = null;
      if (autoOpenedRef.current && panel === autoOpenedRef.current) setPanel(null);
      return;
    }
    if (!ready || !interactive) return; // 不是我方行动：别替别人弹窗
    const sig = `${game.turn}:${game.currentPlayerIndex}:${landing.cellId}:${landing.venue ?? 'single'}`;
    if (landingPromptRef.current === sig) return;
    const kind = landingKind;
    let cancelled = false;
    let timer = 0;
    const wait = () => {
      if (cancelled) return;
      if (window.AC_HUD?.isSettled?.() === false) {
        timer = window.setTimeout(wait, 80);
        return;
      }
      landingPromptRef.current = sig;
      autoOpenedRef.current = kind;
      setPanel(kind);
    };
    wait();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ready, interactive, panel, landing, landingKind, game.turn, game.currentPlayerIndex]);

  const active = forced ?? panel;

  /* 弹层开着时让 HUD 交出键盘：否则在弹层里按回车会隔着遮罩把骰子掷了。
     单开一个 effect 只推 modalOpen，避免整壳重绘（AC.update 会重渲染一遍 HUD）。 */
  useEffect(() => {
    if (!ready) return;
    window.AC_HUD?.setHost({ modalOpen: active !== null });
  }, [ready, active]);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  /* 弹层打开期间：锁背景滚动、把焦点移进来、Esc 关闭、关闭后把焦点还回去。
     锁滚动是因为棋盘铺满整屏，滚轮本来是推拉相机 —— 弹层里滚动时不该连相机一起动。 */
  useEffect(() => {
    if (!active) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      /* 强制弹层（等待小游戏 / 拍卖 / 结算）没有可关的余地，Esc 一律吞掉不外传 */
      e.stopPropagation();
      if (!forced) setPanel(null);
    };
    window.addEventListener('keydown', onKey, true);
    modalRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      returnFocusRef.current?.focus?.();
    };
  }, [active, forced]);

  const panelBody = (() => {
    switch (active) {
      case 'bank':
        return <BankPanel game={game} onAction={onAction} interactive={interactive} />;
      case 'shop':
        return <ShopPanel game={game} onAction={onAction} interactive={interactive} />;
      case 'stock':
        return <StockPanel game={game} onAction={onAction} interactive={interactive} />;
      case 'lottery':
        return <LotteryPanel game={game} onAction={onAction} interactive={interactive} />;
      case 'trade':
        return <TradePanel game={game} onAction={onAction} interactive={interactive} />;
      case 'magic':
        return <NpcPanel game={game} onAction={onAction} interactive={interactive} />;
      case 'company':
        return <CompanyPanel game={game} onAction={onAction} interactive={interactive} />;
      case 'auction':
        return <AuctionPanel game={game} onAction={onAction} myPlayerId={myPlayerId} />;
      case 'control':
      case 'surrender':
        return <ControlPanel game={game} onAction={onAction} interactive={interactive} />;
      default:
        return null;
    }
  })();

  const current = game.players[game.currentPlayerIndex];

  return (
    <>
      <div id="ac-hud-root" className="ac-hud-root" />

      {loadError && <div className="ac-scrim"><div className="ac-note ac-note--danger">HUD 加载失败：{loadError}</div></div>}

      {/* 联机大厅：开局前覆盖在棋盘上 */}
      {game.phase === 'lobby' && isRemote && (
        <div className="ac-scrim">
          <div className="ac-lobby">
            <div className="ac-lobby__code">
              房间码 <b>{roomId}</b>
            </div>
            <div className="ac-lobby__title">房间玩家（{game.players.length}/4）</div>
            <div className="ac-lobby__list">
              {game.players.map((p) => (
                <div key={p.id} className="ac-lobby__row">
                  {p.name}
                  {p.id === myPlayerId && <span className="ac-lobby__me">你</span>}
                </div>
              ))}
            </div>
            <div className="ac-lobby__acts">
              <button className="ac-btn ac-btn--green ac-btn--lg" disabled={game.players.length < 2} onClick={() => onStartGame?.()}>
                开始对局{game.players.length < 2 ? '（至少 2 人）' : ''}
              </button>
              <button className="ac-btn ac-btn--cream" disabled={game.players.length >= 4} onClick={() => onAddBot?.()}>
                🤖 添加 AI
              </button>
            </div>
            <p className="ac-lobby__hint">把房间码发给好友即可加入</p>
          </div>
        </div>
      )}

      {/* 连接 / 等待提示：贴顶居中，不挡操作 */}
      <div className="ac-banners">
        {connection === 'reconnecting' && <div className="ac-banner ac-banner--warn">⚡ 连接已断开，正在尝试重新连接…</div>}
        {netError && <div className="ac-banner ac-banner--danger">{netError}</div>}
        {!interactive && current && game.phase !== 'lobby' && game.phase !== 'game_over' && (
          <div className="ac-banner">
            {current.online ? `等待 ${current.name} 操作…` : `${current.name} 掉线了，稍后将自动托管…`}
          </div>
        )}
        {/* 选格态横幅：说清「现在点棋盘是选目标」，并留一个不依赖键盘的出口与被拒理由 */}
        {pick && (
          <div className="ac-banner ac-banner--warn">
            🎯 {pick.cells.length ? '在棋盘上点一格' : '在棋盘上点一个人'} · {pick.label}
            {pickHint && <span> · {pickHint}</span>}
            <button className="ac-btn ac-btn--cream ac-btn--sm" onClick={cancelPick}>
              取消 <span className="ac-sheet__esc">Esc</span>
            </button>
          </div>
        )}
      </div>

      {/* 手牌 / 道具的内联动作条：没有遮罩，棋盘始终看得见点得到，选格时绿环与这条同时在场 */}
      {handSel && ready && (
        <div
          className="ac-quick-anchor"
          style={quickBox ? { left: quickBox.left, width: quickBox.width, bottom: quickBox.bottom } : undefined}
        >
          <HandQuickBar
            game={game}
            entry={handSel}
            interactive={interactive}
            onAction={onAction}
            requestPick={requestPick}
            pickingKey={pick?.key ?? null}
            onDismiss={dismissHand}
          />
        </div>
      )}

      {active && (
        <div className="ac-sheet-scrim" onClick={forced ? undefined : () => setPanel(null)}>
          <div
            ref={modalRef}
            className={`ac-sheet ac-sheet--${PANEL_SIZE[active] ?? 'md'}`}
            role="dialog"
            aria-modal="true"
            aria-label={PANEL_TITLE[active] ?? active}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ac-sheet__hd">
              <span>{PANEL_TITLE[active] ?? active}</span>
              {!forced && (
                <button className="ac-btn ac-btn--cream ac-btn--sm" onClick={() => setPanel(null)}>
                  关闭 <span className="ac-sheet__esc">Esc</span>
                </button>
              )}
            </div>
            <div className="ac-sheet__bd">{panelBody}</div>
          </div>
        </div>
      )}
    </>
  );
}
