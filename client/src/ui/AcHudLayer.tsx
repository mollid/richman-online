/**
 * ac-HUD 挂载层：把 `client/public/ac-hud/` 的动物森林 HUD（three.js 2.5D 棋盘 + Pixi 名牌 + DOM 面板）
 * 接进 React。HUD 本体是 vanilla IIFE，通过全局 `window.AC_HUD` 暴露 update/setHost/destroy 三个口子。
 *
 * 数据流：App 的 `GameState` → `buildAcSnapshot()` → `window.GAME_SNAPSHOT` / `AC_HUD.update()`。
 * 动作流：HUD 的 dock 按钮 → `AC_HUD.setHost({ dispatch })` → 真实 `session.dispatch()`。
 * 需要选目标 / 填金额的动作（存取款、商店、股市、乐透、挂出、用法术…）走 `openPanel(kind)`，
 * 在本组件里用 ac 皮肤的弹层托管既有 React 面板 —— 这一步是「壳换皮、流程不丢」的临时桥，
 * 后续可把这些面板逐个重做进 ac 皮肤。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { HandPanel } from './HandPanel.js';
import './acHudClient.css';

type AcHostTool = { label: string; title?: string; onClick?: () => void };
type AcHostApi = {
  dispatch: ((a: PlayerAction) => void) | null;
  openPanel: ((kind: string) => void) | null;
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
  setHost: (h: Partial<AcHostApi>) => void;
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
  magic: '🔮 魔法屋 · 监狱保释',
  company: '🏢 公司企业',
  hand: '🎒 手牌与道具',
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
  hand: 'md',
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
  const [fontMode, setFontMode] = useState<FontMode>(readFontMode);

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

  const openPanel = useCallback((kind: string) => setPanel(kind), []);

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
      tag: isRemote ? '联机' : '热座',
      tools,
      interactive,
      /* 热座：一台机器轮流操作，「表现层视角」应跟着当前行动者走；联机：锁在自己身上 */
      followCurrent: !isRemote,
    });
    AC.update(snapshot);
  }, [ready, snapshot, dispatch, openPanel, tools, interactive, isRemote]);

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

  /* 踩到公司格就把认购窗弹出来（CORP-14：原始股只能在此刻、用现金认购，股市面板只做转手）。
   * 签名取「回合 + 行动者 + 脚下格」：同一个落点只弹一次，玩家关掉后不再骚扰；换人/挪开即失效。
   * 只收我们自己弹的那一次 —— dock 上「加盖 / 特别融资」也是开这个面板，不该替玩家关掉。 */
  const companyPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const actor = game.players[game.currentPlayerIndex];
    const cell = actor ? game.board[actor.position] : undefined;
    if (!(game.phase === 'awaiting_action' && cell?.type === 'company')) {
      if (companyPromptRef.current !== null) {
        companyPromptRef.current = null;
        if (panel === 'company') setPanel(null);
      }
      return;
    }
    if (!interactive) return; // 不是我方行动：别替别人弹窗
    const sig = `${game.turn}:${actor!.id}:${cell!.id}`;
    if (companyPromptRef.current === sig) return;
    companyPromptRef.current = sig;
    setPanel('company');
  }, [ready, interactive, panel, game]);

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
      case 'hand':
        return <HandPanel game={game} onAction={onAction} interactive={interactive} />;
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
      </div>

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
