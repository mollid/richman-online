/**
 * 马卡龙派对 HUD 的整壳。
 *
 * 版面（对照旧壳的删 / 并 / 收）：
 *
 *   ┌ 顶栏：资源区 · 状态胶囊（回合/行动者/物价 唯一一处）· 消息 · 更多 · 设置 ┐
 *   │ 舞台：棋盘 + 一句最新播报 + 近景切换 + 图例开关 + 小地图    │ 右导轨 │
 *   └ 底部：当前格卡片 · 行囊（角标）· 骰子（最大视觉权重）              ┘
 *
 * 与旧壳（`public/ac-hud/hud.js`）的关系：两者渲染进同一个 `#ac-hud-root`，用 `?hud=mp` 切换，
 * 好逐个对照。数据口径完全一致 —— 都只吃 `buildAcSnapshot()` 那份 `{ state, view }`；
 * 面板 / 选格 / 落格窗那套流程仍归 `AcHudLayer` 管，这里不复制第二份。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GROUP_CSS, logIcon } from '@richman/shared';
import type { AcSnapshot } from '../../game/acSnapshot.js';
import { Icon } from '../mp/Icon.js';
import { TopBar } from './TopBar.js';
import { Dock, buildActions, type ActRow } from './Dock.js';
import { DRAWER_TABS, DrawerBody, type DrawerTab } from './Drawer.js';
import { useBoardStage, type StageApi, type StagePick } from './useBoardStage.js';
import { useBubble } from './useGuidance.js';
import './hud.css';

const money = (n: number) => Math.round(n).toLocaleString('zh-CN');

/** 「更多」菜单：被收进去的低频入口，逐条对齐旧顶栏那 13 颗钮 */
const MENU: Array<{ kind: 'panel' | 'drawer'; id: string; label: string; icon: string }> = [
  { kind: 'panel', id: 'stock', label: '股市 · 行情与原始股', icon: 'i-chart' },
  { kind: 'panel', id: 'trade', label: '公布栏 · 挂牌与买入', icon: 'i-board' },
  { kind: 'panel', id: 'company', label: '公司企业', icon: 'i-office' },
  { kind: 'drawer', id: 'situation', label: '岛况 · 全局状态与神鬼', icon: 'i-globe' },
  { kind: 'drawer', id: 'books', label: '账本 · 资产清单', icon: 'i-book' },
  { kind: 'drawer', id: 'islanders', label: '岛民 · 按总资产排', icon: 'i-people' },
  { kind: 'drawer', id: 'log', label: '播报 · 引擎原句', icon: 'i-mega' },
];

export function MpHud({
  snap,
  ready,
  interactive,
  isRemote,
  followCurrent,
  myPlayerId,
  muted,
  connection,
  netError,
  pick,
  bagFocusKey,
  stageApiRef,
  pickLabel,
  pickHint,
  onCancelPick,
  onFire,
  onOpenPanel,
  onPickCell,
  onPickPlayer,
  onToggleMute,
  onOpenHelp,
  onOpenSettings,
  onSaveGame,
  onLoadGame,
  onExit,
}: {
  snap: AcSnapshot;
  ready: boolean;
  interactive: boolean;
  isRemote: boolean;
  followCurrent: boolean;
  myPlayerId: string | null;
  muted: boolean;
  connection: 'connected' | 'reconnecting' | 'closed' | 'kicked';
  netError: string;
  /** 选目标态：候选与「被拒的引擎原话」一起给，hover 才能引用原话而不是另编一句 */
  pick: StagePick | null;
  bagFocusKey: string | null;
  /** 宿主用它决定什么时候把落格面板弹出来（引擎把掷骰→走格→落格压成一个原子动作） */
  stageApiRef: React.MutableRefObject<StageApi | null>;
  /** 选格态横幅：说清「现在点棋盘是在选什么」，并留一个不依赖键盘的出口与被拒理由 */
  pickLabel: string;
  pickHint: string;
  onCancelPick: () => void;
  onFire: (act: ActRow['act'], label: string) => void;
  onOpenPanel: (kind: string, arg?: unknown) => void;
  onPickCell: (cellId: number) => void;
  onPickPlayer: (pid: string) => void;
  onToggleMute: () => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  onSaveGame?: () => void;
  onLoadGame?: () => void;
  onExit: () => void;
}) {
  const { state: st, view } = snap;
  const actor = st.players[st.currentPlayerIndex];
  const me = st.players.find((p) => p.id === (myPlayerId ?? actor?.id)) ?? st.players[0];

  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [selCell, setSelCell] = useState<number>(() => actor?.position ?? 0);
  const [viewportPid, setViewportPid] = useState<string>(() => myPlayerId ?? actor?.id ?? '');
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const [say, setSay] = useState('');

  /* 视角：热座跟着回合走；联机锁在自己身上（用户手选的视角不该被快照冲掉） */
  useEffect(() => {
    if (followCurrent) setViewportPid(me?.id ?? '');
    else setViewportPid((v) => (st.players.some((p) => p.id === v) ? v : (myPlayerId ?? '')));
  }, [followCurrent, me?.id, myPlayerId, st.players]);

  /* 换回合或换人时把钉住的卡片收回行动者脚下：留着上一回合那一格会让人读错当下 */
  useEffect(() => {
    if (actor) setSelCell(actor.position);
  }, [actor?.id, actor?.position, st.turn]);

  /* ---------------- 最新播报：只留一句，读完自己走 ----------------
     旧壳在棋盘上方铺一条横滚字幕带，密度没降还和 dock 抢注意力。掷骰 / 买地 / 收租那些
     结果仍要说句话（核心路径的第二步就是「看结果」），但只说最近那一条、4 秒后淡掉。 */
  const sayTimer = useRef(0);
  const saySigRef = useRef<string | null>(null);
  useEffect(() => {
    const log = st.log ?? [];
    const sig = (e: { turn: number; text: string }) => `${e.turn}|${e.text}`;
    const last = log.length ? sig(log[log.length - 1]!) : '';
    /* 基线：首帧不播（那是历史最后一条，不是刚发生的事），读档进来也不把整段重播一遍 */
    if (saySigRef.current === null) {
      saySigRef.current = last;
      return;
    }
    if (!log.length || last === saySigRef.current) return;
    /* 增量**不能按长度差算**：`log()` 有 200 条上限并从头部剪，长度钉在 200 之后差值恒为 0
       —— 早先用 `log.length <= prev + 1` 判新增，等于整局打满 200 条之后这条播报永久哑掉，
       连最普通的「只新增一条」都会被误判成没新增。改为从尾部回扫找上次看过的那条。 */
    let i = log.length - 1;
    while (i >= 0 && sig(log[i]!) !== saySigRef.current) i--;
    saySigRef.current = last;
    const fresh = i >= 0 ? log.slice(i + 1) : log.slice(-1);
    const text = fresh[fresh.length - 1]?.text;
    if (!text) return;
    setSay(text);
    window.clearTimeout(sayTimer.current);
    sayTimer.current = window.setTimeout(() => setSay(''), 4000);
  }, [st.log]);
  useEffect(() => () => window.clearTimeout(sayTimer.current), []);

  /* ---------------- 未读数：从尾部回扫找上次看过的那条 ----------------
     不能按长度差算：log() 有 200 条上限会从头部剪掉，长度差会把「剪掉几条」当成「新增几条」。 */
  const sigOf = (i: number) => {
    const e = st.log?.[i];
    return e ? `${e.turn}|${e.text}` : '';
  };
  const [seenSig, setSeenSig] = useState('');
  const seenOnce = useRef(false);
  useEffect(() => {
    if (seenOnce.current) return;
    seenOnce.current = true;
    setSeenSig(sigOf((st.log?.length ?? 0) - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const unread = useMemo(() => {
    const log = st.log ?? [];
    if (!log.length) return 0;
    /* seenSig 为空有两种来路：还没立基线（首帧 log 就是空的），或基线那条已被 200 条上限剪掉。
       前者该报「全是新的」—— 不报的话，空开局进来的人永远看不见未读角标，
       这条正是顶栏那颗消息钮唯一的反馈。 */
    if (!seenSig) return Math.min(3, log.length);
    let i = log.length - 1;
    while (i >= 0 && `${log[i]?.turn}|${log[i]?.text}` !== seenSig) i--;
    // 一条都没找回 = 上次那条已被上限剪掉，这时只报最近三条，不拿整段历史吓人
    return Math.max(0, i >= 0 ? log.length - 1 - i : Math.min(3, log.length));
    // 不列 sigOf：它是每次渲染新建的闭包，列进来会让这个 memo 永远不命中，而它的函数体根本没用它
  }, [st.log, seenSig]);

  const openDrawer = useCallback(
    (tab: DrawerTab | null) => {
      setDrawer(tab);
      setMoreOpen(false);
      if (tab === 'log') setSeenSig(sigOf((st.log?.length ?? 0) - 1));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [st.log],
  );

  /* 浮层抽屉的出口：Esc、点抽屉外任何地方、再点一次当前页签，三条都要通。
     没有遮罩（只读面板，压 scrim 会吃掉棋盘点击），所以不能靠「点外面关掉」的 scrim 兜底，
     得自己挂一个 outside 监听。导轨那一列要排除在外 —— 否则点页签会先被这里关掉、
     再被按钮的 onClick 打开，「再点一次收起」那条就永远不成立。 */
  const drawerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!drawer) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || drawerRef.current?.contains(t) || t.closest('.mp-rail')) return;
      setDrawer(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(null);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [drawer]);

  /* 「更多」菜单同样要能点外面关掉 —— 它是 fixed 悬浮件，没有遮罩兜底。
     触发那颗钮本身要排除，否则 mousedown 先关、click 再开，永远关不上。 */
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || menuRef.current?.contains(t) || t.closest('.mp-top__acts')) return;
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

  /* ---------------- 舞台（棋盘 + 相机 + 小地图） ---------------- */
  const onHover = useCallback(
    (id: number | null) => {
      if (id == null) {
        setTip(null);
        return;
      }
      const p = globalThis.D25World?.lastPointer?.() ?? { x: 0, y: 0 };
      setTip({ x: p.x, y: p.y, lines: cellBits(snap, id, pick) });
    },
    [snap, pick],
  );
  const stage = useBoardStage({
    enabled: ready,
    snapshot: snap,
    followCurrent,
    pick,
    onPickCell,
    onPickPlayer,
    onSelectCell: setSelCell,
    onHover,
  });
  useEffect(() => {
    stageApiRef.current = stage.apiRef.current;
    return () => {
      stageApiRef.current = null;
    };
  }, [stageApiRef, stage.apiRef]);

  /* ---------------- 一次性气泡：只在真的相关时烧掉那一次机会 ---------------- */
  const bagCount = useMemo(() => Object.values(me?.items ?? {}).reduce((a, b) => a + b, 0) + (me?.cards.length ?? 0), [me]);
  /* 收起来的东西确实存在才值得教：只剩一颗主按钮时「其余动作收在这里」是句空话 */
  const hasStowed = useMemo(() => buildActions(snap).filter((r) => r.enabled).length > 1, [snap]);
  const showBag = useBubble('bag', bagCount > 0 && drawer === null);
  const showMore = useBubble('more', hasStowed);
  const showCam = useBubble('cam', ready, 8000);

  const cam = stage.cam;
  const gamePhase = st.phase;
  const pickCells = pick?.cells ?? [];

  return (
    <div className="mp-shell">
      <TopBar
        snap={snap}
        viewportPid={viewportPid || me?.id || ''}
        onPickViewport={(pid) => {
          setViewportPid(pid);
          openDrawer('islanders');
        }}
        unread={unread}
        onOpenLog={() => openDrawer(drawer === 'log' ? null : 'log')}
        onOpenMore={() => setMoreOpen((v) => !v)}
        onOpenSettings={onOpenSettings}
        onOpenHelp={onOpenHelp}
        onToggleMute={onToggleMute}
        muted={muted}
        tag={isRemote ? '联机' : '热座'}
      />

      <main className="mp-main">
        <section className="mp-board">
          <div className="mp-stagebox" ref={stage.hostRef}>
            {/* 覆盖层做成舞台的兄弟：world.dispose() 的 innerHTML='' 与 overlay.dispose() 的
                「删掉舞台里所有 canvas」都扫不到这里，React 的节点也不会被它们带走。 */}
            <div className="mp-stagebar">
              <span className="mp-camread">
                <Icon id="i-cam" size="s" />
                {cam.iso ? `近景 · 周围 ${cam.visible} 格` : '全盘'}
                {cam.follow === 'intro' ? ' · 聚焦中' : cam.target ? ` · 跟随 ${cam.target}` : ''}
              </span>
              <button className="mp-btn mp-btn--sm mp-btn--ghost" type="button" onClick={stage.toggleCamMode} disabled={cam.locked}>
                <Icon id={cam.iso ? 'i-board' : 'i-search'} size="s" />
                {cam.iso ? '回到全盘' : '近景等距'}
              </button>
              <button
                className={`mp-btn mp-btn--sm mp-btn--ghost${legendOpen ? ' mp-btn--accent' : ''}`}
                type="button"
                aria-expanded={legendOpen}
                title="图例：配色与三种触发口径"
                onClick={() => setLegendOpen((v) => !v)}
              >
                <Icon id="i-deed" size="s" />
                图例
              </button>
            </div>

            {say && (
              <div className="mp-say" role="status" aria-live="polite">
                <Icon id={logIcon(say)} size="s" />
                {say}
              </div>
            )}

            {legendOpen && <Legend />}

            {/* 近景只露周围几格，方位感全靠这块 —— 不是装饰，所以跟着近景一起显隐 */}
            <canvas className="mp-mini" ref={stage.miniRef} width={120} height={120} hidden={!cam.iso} />
          </div>

          {showCam && <div className="mp-bubble mp-bubble--stage">拖拽转视角 · 滚轮推拉 · 悬停看格子 · 点击钉到下方卡片</div>}
        </section>

        <nav className="mp-rail" aria-label="数据页签">
          {DRAWER_TABS.map((t) => (
            <button
              key={t.id}
              className={`mp-rail__btn${drawer === t.id ? ' mp-rail__btn--on' : ''}`}
              type="button"
              title={t.label}
              aria-pressed={drawer === t.id}
              onClick={() => openDrawer(drawer === t.id ? null : t.id)}
            >
              <Icon id={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}
          <span className="mp-rail__sep" />
          <button className="mp-rail__btn" type="button" title="规则：这一格怎么办，鼠标指过来就有" onClick={onOpenHelp}>
            <Icon id="i-question" />
            <span>规则</span>
          </button>
          {!isRemote && onSaveGame && (
            <button className="mp-rail__btn" type="button" title="存档" onClick={onSaveGame}>
              <Icon id="i-save" />
              <span>存档</span>
            </button>
          )}
          {!isRemote && onLoadGame && (
            <button className="mp-rail__btn" type="button" title="读档" onClick={onLoadGame}>
              <Icon id="i-load" />
              <span>读档</span>
            </button>
          )}
          <button className="mp-rail__btn mp-rail__btn--quit" type="button" title="退出对局" onClick={onExit}>
            <Icon id="i-exit" />
            <span>退出</span>
          </button>
        </nav>

        {drawer && (
          <aside ref={drawerRef} className="mp-drawer mp-panel">
            <div className="mp-panel__hd">
              <Icon id={DRAWER_TABS.find((t) => t.id === drawer)?.icon ?? 'i-book'} size="s" />
              {DRAWER_TABS.find((t) => t.id === drawer)?.label}
              <button className="mp-dialog__x" type="button" aria-label="关闭抽屉" onClick={() => openDrawer(null)}>
                <Icon id="i-x" size="s" />
              </button>
            </div>
            <div className="mp-drawer__bd mp-scroll">
              <DrawerBody
                tab={drawer}
                snap={snap}
                viewportPid={viewportPid || me?.id || ''}
                onPick={setViewportPid}
                onJumpCell={(id) => {
                  setSelCell(id);
                  setDrawer(null);
                }}
              />
            </div>
          </aside>
        )}
      </main>

      <Dock
        snap={snap}
        interactive={interactive}
        camLocked={cam.locked}
        camTarget={cam.target}
        camIso={cam.iso}
        camVisible={cam.visible}
        selCell={selCell}
        onSelectCell={setSelCell}
        onFire={onFire}
        onOpenPanel={onOpenPanel}
        bagFocusKey={bagFocusKey}
        guidance={{ bag: showBag, more: showMore }}
      />

      {moreOpen && (
        <div ref={menuRef} className="mp-panel mp-menu" role="menu">
          <div className="mp-menu__t">全部功能入口</div>
          {MENU.map((m) => (
            <button
              key={m.id}
              className="mp-menu__item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMoreOpen(false);
                if (m.kind === 'panel') onOpenPanel(m.id);
                else openDrawer(m.id as DrawerTab);
              }}
            >
              <Icon id={m.icon} size="s" />
              {m.label}
            </button>
          ))}
          <span className="mp-rail__sep" />
          <button
            className="mp-menu__item"
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreOpen(false);
              onExit();
            }}
          >
            <Icon id="i-exit" size="s" />
            退出对局
          </button>
        </div>
      )}

      {tip && (
        <div className="mp-tip" style={{ left: tip.x + 16, top: tip.y }}>
          {tip.lines.map((l, i) => (
            <span key={i} className={i === 0 ? 'mp-tip__t' : ''}>
              {l}
            </span>
          ))}
        </div>
      )}

      {/* 连接 / 等待 / 选格三样都走这一条：贴顶居中、不常驻、不占版面 */}
      <div className="mp-banners">
        {connection === 'reconnecting' && <div className="mp-banner mp-banner--warn">连接已断开，正在尝试重新连接…</div>}
        {/* 收房 / 服务端重启都会走到这里：不出一条死信，画面就只剩一个再也点不动的大厅 */}
        {connection === 'closed' && <div className="mp-banner mp-banner--danger">房间已关闭（无人操作超时或服务端重启）· 点「退出」回大厅</div>}
        {netError && <div className="mp-banner mp-banner--danger">{netError}</div>}
        {!interactive && actor && gamePhase !== 'lobby' && gamePhase !== 'game_over' && (
          <div className="mp-banner">{actor.online ? `等待 ${actor.name} 操作…` : `${actor.name} 掉线了，稍后将自动托管…`}</div>
        )}
        {pick && (
          <div className="mp-banner mp-banner--warn">
            <Icon id="i-pin" size="s" />
            {pickCells.length ? '在棋盘上点一格' : '在棋盘上点一个人'} · {pickLabel}
            {pickHint && <span> · {pickHint}</span>}
            <button className="mp-btn mp-btn--sm mp-btn--ghost" type="button" onClick={onCancelPick}>
              取消 · Esc
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 图例：配色 + 三种触发口径。收在开关后面，不再常驻棋盘下方 */
function Legend() {
  const groups: Array<[keyof typeof GROUP_CSS, string]> = [
    ['residential', '住宅段'],
    ['commercial', '商业段'],
    ['industrial', '工业段'],
    ['tech', '科技段'],
    ['coastal', '临海段'],
    ['financial', '金融段'],
  ];
  return (
    <div className="mp-legend mp-panel">
      <div className="mp-legend__row">
        {groups.map(([k, n]) => (
          <span key={k}>
            <i style={{ background: GROUP_CSS[k] }} />
            {n}
          </span>
        ))}
        <span>
          <i className="mp-legend__ring" />
          描边 = 持有者色
        </span>
      </div>
      <div className="mp-legend__row mp-legend__row--meta">
        <span>
          <Icon id="i-cone" size="s" /> 路障＝经过就截停
        </span>
        <span>
          <Icon id="i-mine" size="s" /> 地雷＝踩中才炸，但不拦路（只有路障拦人）
        </span>
        <span>
          <Icon id="i-bomb" size="s" /> 炸弹＝放上格，踩中才附身；附身后才倒数，撞到人才甩得出去
        </span>
        <span>
          <Icon id="i-user" size="s" /> 乞丐＝站上那一格必须施舍
        </span>
      </div>
    </div>
  );
}

const TYPE_CN: Record<string, string> = {
  start: '起点',
  property: '住宅用地',
  commercial: '商业用地',
  chance: '机会格',
  news: '新闻格',
  'free-card': '免费卡片格',
  points: '点券格',
  lottery: '乐透行',
  magic: '魔法屋',
  tax: '缴税格',
  hospital: '医院',
  jail: '监狱',
  game: '游戏厅',
  shop: '商店',
  bank: '银行',
  god: '神庙',
  company: '公司企业',
  blank: '空白格',
};

/**
 * 悬停浮层：只讲「这一格是什么」。选目标态下多问一句能不能选，
 * 不能选时把引擎那句原话贴出来 —— 表现层不另编一套说法，也不用点了才知道。
 */
function cellBits(snap: AcSnapshot, id: number, pick: StagePick | null): string[] {
  const { state: st, view } = snap;
  const cell = st.board[id];
  if (!cell) return ['空白'];
  const footprint = (c: { footprint?: number[]; cellId: number }) => (c.footprint?.length ? c.footprint : [c.cellId]);
  const corp = st.companies.find((c) => footprint(c).includes(id));
  const god = view.gods.find((g) => g.cellId === id);
  const bits = [`${cell.id} · ${cell.name} · ${TYPE_CN[cell.type] ?? cell.type}`];
  if (corp) bits.push(`面值 ${money(corp.sharePrice)}（这家公司占 ${footprint(corp).join('·')} 格，踩到哪一格都能认购）`);
  else if (cell.price) bits.push(`地价 ${money(cell.price * view.priceIndex)}`);
  if (cell.baseRent) bits.push(`每级租金 ${money(cell.baseRent * view.priceIndex)}`);
  if (corp) {
    const held =
      Object.entries(corp.shares)
        .map(([k, v]) => `${st.players.find((p) => p.id === k)?.name ?? k}×${v}`)
        .join(' ') || '无人持股';
    bits.push(`盈余 ${money(corp.surplus)}｜${held}`);
    bits.push(`经营权：${corp.chairmanId ? st.players.find((p) => p.id === corp.chairmanId)?.name ?? '?' : '空缺'}`);
  }
  const own = view.owners[id];
  if (own) bits.push(`持有：${st.players.find((p) => p.id === own)?.name ?? '?'}`);
  const grade = st.players.flatMap((p) => p.properties).find((q) => q.cellId === id);
  if (grade) bits.push(`${grade.grade} 级${grade.facility ? ` · ${view.names.facilities[grade.facility]?.name ?? grade.facility}` : ''}`);
  if (god) bits.push(`神明驻留：${god.name}（剩 ${god.ttlDays} 天）· ${god.summary}`);
  if (view.treasureCellId === id) bits.push(`宝箱驻留：踩到这一格领 ${view.treasurePoints} 点券（路过不算，本月只此一只）`);

  const cells = pick?.cells ?? [];
  if (cells.length) bits.push(cells.includes(id) ? '可选为目标' : (pick?.rejected.find((r) => r.id === id)?.reason ?? '不可选'));
  const players = pick?.players ?? [];
  if (players.length) {
    for (const q of st.players) {
      if (q.position !== id || q.bankrupt) continue;
      bits.push(players.includes(q.id) ? `可选「${q.name}」` : (pick?.playerRejected.find((r) => r.id === q.id)?.reason ?? `「${q.name}」不可选`));
    }
  }
  return bits;
}
