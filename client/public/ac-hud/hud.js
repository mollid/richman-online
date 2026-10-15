/* 大富翁 Online · 动物森林 HUD（已并入 client：由真实 GameState 实时驱动）
 * 数据来源：宿主通过 AC_HUD.setHost().update(snapshot) 注入 { state, view }
 *          （client/src/game/acSnapshot.ts 用 @richman/shared 实时派生，取代原 snapshot.js）。
 * 动作：宿主通过 setHost({ dispatch }) 注入真实 PlayerAction 出口；未注入时才退回旧的「只做表现」。 */
(() => {
  'use strict';
  let S = globalThis.GAME_SNAPSHOT;
  if (!S) { console.error('[ac-hud] 缺少 GAME_SNAPSHOT，HUD 未挂载'); return; }
  let st, view, A, cur, me, RING;
  let hostApi = { dispatch: null, openPanel: null };
  const AC_ROOT_ID = 'ac-hud-root';
  /** 宿主换一局 / 推进一回合后调用：重新绑定派生量（RING / me / cur 都随 state 变） */
  function bindSnap(snap) {
    S = snap; st = S.state; view = S.view; A = view.actions;
    cur = st.players[st.currentPlayerIndex];
    me = st.players.find((p) => p.id === view.myPlayerId) || st.players[0];
    /* 方环示意（没有 WebGL 时的兜底棋盘）：边长按格数现算，64 格正好是 17×17 外圈。
       写死 17 的话，100+ 格的原版图会从这里开始往负坐标里排。 */
    const L = Math.ceil(st.board.length / 4) + 1;
    RING = st.board.map((cell, i) => {
      if (i < L - 1) return { cell, col: i + 1, row: 1, edge: 'top' };
      if (i < 2 * (L - 1)) return { cell, col: L, row: i - (L - 2), edge: 'right' };
      if (i < 3 * (L - 1)) return { cell, col: L - (i - 2 * (L - 1)), row: L, edge: 'bottom' };
      return { cell, col: 1, row: L - (i - 3 * (L - 1)), edge: 'left' };
    });
  }
  bindSnap(S);
  const money = (n) => Math.round(n).toLocaleString('zh-CN');
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const css = (color) => `#${color.toString(16).padStart(6, '0')}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* 头像取玩家身上的 `avatar`（由 shared 的角色表在开局时派生，见 `characters.ts`）。
     这里原先自带两张表：认得的 id 用固定动物、其余按座位序取一只。问题不是兜底不够，
     而是表现数据在一个不参与 typecheck 的静态脚本里又存了一份 —— 角色表一改名字或顺序，
     这边就静静地对不上。波 3 把它们收回角色表，本文件只认结构。 */
  const avaOf = (p) => p.avatar || '🧑‍🌾';
  const GROUP = {
    residential: '#8fd07a', commercial: '#7ec8ef', industrial: '#c9b48a',
    tech: '#b7a6e6', coastal: '#7fd8c8', financial: '#f0b96a',
  };
  const CELL = {
    start: ['🏁', '起点 · 经过领薪水'], property: ['🏠', '住宅用地'], commercial: ['🏬', '商业用地'],
    chance: ['🎋', '机会格'], news: ['📰', '新闻格'], 'free-card': ['🃏', '免费卡片格'],
    points: ['🎟️', '点券格'], lottery: ['🎰', '乐透行'], magic: ['🔮', '魔法屋'],
    tax: ['💼', '缴税格'], hospital: ['🏥', '医院'], jail: ['🚔', '监狱'],
    game: ['🎮', '游戏厅'], shop: ['🛍️', '商店'], bank: ['🏦', '银行'], god: ['⛩️', '神庙'], company: ['🏢', '公司企业'],
    blank: ['', '空白格 · 什么都不发生'],
  };
  const GOD_EMOJI = {
    'land-god': '🏮', 'big-wealth': '💰', 'small-wealth': '🪙', 'big-fortune': '🍀', 'small-fortune': '🌱',
    'big-poverty': '🕳️', 'small-poverty': '🧦', 'big-misfortune': '⚡', 'small-misfortune': '🌧️',
    angel: '😇', devil: '😈', death: '💀',
  };
  const NPC = { thief: '🗡️', protection: '🥊', robber: '🔨', 'rent-thief': '👺', dog: '🐕' };
  const NPC_CN = { thief: '小偷', protection: '保护费流氓', robber: '强盗', 'rent-thief': '收租恶霸' };
  const ITEM_EMOJI = {
    'robot-doll': '🤖', 'remote-dice-item': '🎛️', roadblock: '🚧', 'time-bomb': '💣', mine: '💥',
    'robot-worker': '👷', 'pass-card-item': '🎫', 'delay-paste-item': '🩹', 'winter-item': '❄️',
    'stamp-box': '📮', 'traffic-accident-item': '🚥', 'doublecard-deck-item': '🃏', 'farmer-item': '🚜',
  };

  const assetOf = (id) => view.assets.find((a) => a.playerId === id);
  const NAMED = new Set(['property', 'commercial', 'company']);
  const ownerColor = (cellId) => {
    const pid = view.owners[cellId];
    const p = st.players.find((x) => x.id === pid);
    return p ? css(p.color) : null;
  };
  let viewportPid = view.myPlayerId;
  const toasts = [];

  /* ---------------- 顶栏 ---------------- */
  function renderTop() {
    const p = st.players.find((x) => x.id === viewportPid) || me;
    const box = el('header', 'ac-hud hud-top');
    /* 日期段收在尾巴 .hud-when（挤不动吃省略号），回合/圈/岛历留在 .hud-stamp（保量）。
       早先「（例假日·股市休市）」也写在这行 —— 纯冗余，状态条的 🗓️ 与 🏖️ chip 已重述，删。 */
    box.innerHTML = `
      <div class="ac-hud__ava">${avaOf(p)}</div>
      <div class="ac-hud__who">
        <b>${esc(p.name)}</b>
        <small><span class="hud-stamp">${st.turn > 0 ? `第 ${st.turn} 回合 · 第 ${st.round} 圈 · 岛历第 ${view.date.dayIndex + 1} 天${st.maxDays ? ` / ${st.maxDays}` : ''}` : '等待开局'}</span><span class="hud-when"> · ${view.date.month}/${view.date.day} ${view.date.weekdayLabel}</span></small>
      </div>
      <div class="ac-hud__spacer"></div>
      <div class="hud-coin">
        <span class="ac-currency ${p.cash < 500 ? 'ac-currency--low' : ''}" title="现金：买地、认购原始股、缴费"><span class="ac-currency__coin ac-currency__coin--bell">🔔</span>${money(p.cash)}</span>
        <span class="ac-currency" title="存款：可被动扣缴、月末计息、买卖上市股只能用它"><span class="ac-currency__coin ac-currency__coin--mile">✈️</span>${money(p.deposit)}</span>
        <span class="ac-currency" title="点券：卡片与道具的唯一货币"><span class="ac-currency__coin ac-currency__coin--turnip">🥬</span>${money(p.points)}</span>
      </div>
      <div class="ac-hud__spacer"></div>
      <div class="hud-topbtns">
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-tab="岛民" aria-label="切到岛民页签">岛民</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-tab="岛况" aria-label="切到岛况页签">岛况</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-tab="股市" aria-label="切到股市页签">股市</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-tab="账本" aria-label="切到账本页签">账本</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-tab="播报" aria-label="切到播报页签">播报</button>
      </div>
      <span class="hud-proto" data-host-tag></span>
      <span class="hud-hosttools" data-host-tools></span>`;
    box.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
    /* 宿主注入的模式标与工具按钮（静音/帮助/设置/存档/退出…）—— 顶栏由 HUD 造，宿主只提供数据 */
    const tag = box.querySelector('[data-host-tag]');
    if (tag) tag.textContent = hostApi.tag || '';
    const tools = box.querySelector('[data-host-tools]');
    for (const t of (hostApi.tools || [])) {
      const b = el('button', 'ac-btn ac-btn--cream ac-btn--sm', t.label);
      if (t.title) b.title = t.title;
      if (typeof t.onClick === 'function') b.onclick = () => t.onClick();
      tools.appendChild(b);
    }
    return box;
  }

  /* ---------------- 状态条：一行不放回 —— 左：日期与全局态；中：可横滚的行情带；右：奖池 ---------------- */
  function renderStatus() {
    const bar = el('div', 'hud-status');
    const d = view.date;
    const left = [];
    left.push(`<span class="hud-chip hud-tip" data-tip="起始日 ${st.calendar.start.year}/${st.calendar.start.month}/${st.calendar.start.day} + 岛历 ${d.dayIndex} 天派生">🗓️ ${d.month}/${d.day} ${d.weekdayLabel} · 岛历 ${d.dayIndex + 1} 天${st.maxDays ? `/${st.maxDays}` : ''} · 月末 ${d.daysLeftInMonth} 天</span>`);
    if (d.isHoliday) left.push('<span class="hud-chip hud-chip--warn">🏖️ 例假日休市</span>');
    if (d.isDividendDay) left.push('<span class="hud-chip hud-chip--god">💵 今日分红</span>');
    if (d.isMonthEnd) left.push('<span class="hud-chip hud-chip--money">🏦 今日月末清算</span>');
    left.push(`<span class="hud-chip hud-tip" data-tip="物价指数 = 全体存活玩家总资产 ÷（单人初始资金 × 开局人数）；买地、升级、租金、事件金额都乘它">📊 物价 ×${view.priceIndex.toFixed(3)}</span>`);

    const mid = st.stockMarket.stocks.map((s) => {
      const halt = st.stockHalts.find((h) => h.stockId === s.id);
      const arrow = s.lastChangePct > 0 ? '▲' : s.lastChangePct < 0 ? '▼' : '＝';
      return `<span class="hud-chip hud-tip ${halt ? 'hud-chip--off' : ''}" data-tip="${esc(s.name)}｜现价 ${money(s.price)}｜流通股本 ${money(s.floatShares)} 股${halt ? `｜${halt.kind === 'up' ? '涨停' : halt.kind === 'down' ? '跌停' : '停牌'} 还剩 ${halt.daysLeft} 天` : ''}">${esc(s.name.replace('股', ''))} <b class="hud-num">${money(s.price)}</b> ${arrow}</span>`;
    }).join('');

    const right = [];
    if (st.stockHaltAllDays > 0) right.push(`<span class="hud-chip hud-chip--warn">🚧 全市场停牌 ${st.stockHaltAllDays} 天</span>`);
    if (st.loanBanDays > 0) right.push(`<span class="hud-chip hud-chip--warn">🏦 停止放款 ${st.loanBanDays} 天</span>`);
    right.push(`<span class="hud-chip hud-tip" data-tip="罚金与投注累加，每月 15 号开奖">🎰 奖池 ${money(st.lotteryPool)} · 在押 ${st.lotteryTickets.length} 单</span>`);

    bar.innerHTML = left.join('') +
      '<span class="hud-status__sep"></span>' +
      `<span class="hud-status__mkt" role="group" aria-label="六支上市股现价">${mid}</span>` +
      '<span class="hud-status__sep"></span>' + right.join('');
    return bar;
  }

  /* ---------------- 播报字幕条：引擎新写的每一条从棋盘上方滚过去 ----------------
   * 文案只取 `st.log`（引擎原句），表现层不另编一套，字幕与「播报」页签逐字一致。
   * 增量不能按长度差算：`log()` 有 200 条上限，会从头部剪掉 —— 所以从尾部回扫找上一次那条。
   * 位移用 rAF 自己推，不写 CSS 动画：`render()` 每来一份快照就把整壳重铺一遍，
   * 节点重新入 DOM 会把 CSS 动画从头再放一次，字幕会反复弹回右边。
   */
  const TICKER_PX_PER_SEC = 160;
  const TICKER_GAP = 60;
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let tickerEl = null, tickerTrack = null;
  let tickerSeenSig = null;    // 上一次看到的最后一条；null = 还没立基线（首帧 / 读档不刷屏）
  let tickerItems = [];        // [{node, x, w}]
  let tickerRaf = 0, tickerLast = 0;

  function ensureTicker() {
    if (tickerEl) return tickerEl;
    tickerEl = el('div', 'hud-ticker');
    tickerEl.setAttribute('role', 'status');
    tickerEl.setAttribute('aria-live', 'polite');
    tickerTrack = el('div', 'hud-ticker__track');
    tickerEl.appendChild(tickerTrack);
    return tickerEl;
  }

  function tickerTick(now) {
    tickerRaf = 0;
    const dt = tickerLast ? Math.min(0.25, (now - tickerLast) / 1000) : 0;
    tickerLast = now;
    tickerItems = tickerItems.filter((it) => {
      it.x -= TICKER_PX_PER_SEC * dt;
      if (it.x + it.w < -16) { it.node.remove(); return false; }
      it.node.style.transform = `translateX(${it.x}px)`;
      return true;
    });
    if (tickerItems.length) tickerRaf = requestAnimationFrame(tickerTick);
    else tickerLast = 0;
  }

  function pushTicker(text) {
    if (!tickerTrack) return;
    const node = el('span', 'hud-ticker__item', esc(text));
    if (REDUCED) {
      // 减弱动效：不滚，只把最新那条停在原位，读完就撤
      tickerItems.forEach((it) => it.node.remove());
      tickerItems = [];
      tickerTrack.replaceChildren(node);
      setTimeout(() => { if (node.parentNode) node.remove(); }, 4200);
      return;
    }
    tickerTrack.appendChild(node);
    const width = tickerEl.clientWidth || 600;
    const tail = tickerItems[tickerItems.length - 1];
    const it = { node, x: Math.max(width, tail ? tail.x + tail.w + TICKER_GAP : width), w: node.offsetWidth };
    node.style.transform = `translateX(${it.x}px)`;
    tickerItems.push(it);
    if (!tickerRaf) { tickerLast = 0; tickerRaf = requestAnimationFrame(tickerTick); }
  }

  function pumpTicker() {
    const log = st.log || [];
    const sig = (e) => `${e.turn}|${e.text}`;
    const last = log.length ? sig(log[log.length - 1]) : '';
    if (tickerSeenSig === null) { tickerSeenSig = last; return; }
    if (!log.length || last === tickerSeenSig) return;
    let i = log.length - 1;
    while (i >= 0 && sig(log[i]) !== tickerSeenSig) i--;
    // 一条都没找回：上一次那条已被 200 条上限剪掉，这时只补最近三条，不让整段历史滚一遍
    const fresh = i >= 0 ? log.slice(i + 1) : log.slice(-3);
    tickerSeenSig = last;
    for (const e of fresh) pushTicker(e.text);
  }

  /* ---------------- 棋盘：默认 2.5D（three.js 世界 + Pixi 叠加），?board=flat 回方环 ---------------- */
  const FLAT0 = /board=flat/.test(location.search) || /board=flat/.test(location.hash);
  let flatMode = FLAT0;
  const HAS_GL = !!globalThis.THREE && !!globalThis.PIXI && !!globalThis.D25World && !!globalThis.D25Overlay;
  let stage = null, tipEl = null, camChip = null, selCell = cur.position;
  /**
   * 选目标模式：宿主（React）进入「要在棋盘上点一格 / 点一个人」时把候选集推过来。
   * null = 不在选态，此时点击只是「查看这一格的详情」（原有行为）。
   *
   * W3 把这一层的视觉补齐了：合法格套绿环、其余格面连贴花一起压暗（world.js），
   * 候选玩家脚下套同款绿环，悬停直接引用引擎那句原话讲清「为什么不能选」。
   * 但**合法性仍然只在派单那一刻由引擎裁决** —— 包括「非法的东西也能被点」：
   * 表现层不复制第二套规则，否则两边迟早各说各话。
   */
  let pickCells = null;
  /** 被拒格的引擎原句（cellId → reason）：hover 时直接引用，表现层不另编一套说法 */
  let pickReasons = new Map();
  /** 选人模式（W3-d）：候选玩家 id + 被拒者的引擎原话，环与 tooltip 都读这一份 */
  let pickPlayers = [];
  let pickPlayerReasons = new Map();
  /** 棋盘是否处于「要在上面点东西」的状态（格或人任一） */
  const picking = () => !!pickCells || pickPlayers.length > 0;
  /**
   * 行囊里此刻被展开的那一格（id 由宿主从 `setBagFocus` 报回来）。
   * 只影响样式，不参与合法性 —— 但每次快照重建都要认它，否则动作条开着、下面的格子选中态会在
   * 下一帧消失（hud.js 的 render() 是把整壳重铺的）。
   */
  let bagFocusKey = null;
  /* ---------------- 相机系统接线：聚焦 → 跟随 → 解锁 ----------------
   * world.js 持有状态机与补间；这里只做三件事：
   *   1) 决定「该聚焦谁」（activePid）并在合适的时机调 D25World.focusPlayer()
   *   2) 把 locked 投影成界面禁用态（.hud-shell--locked + 捕获阶段拦截），
   *      让「视角停稳前不能操作、且操作确实点不动」既看得见也能被脚本量到
   *   3) 提供「镜头巡演」入口，把四位玩家各验一遍
   * 注意：巡演只动镜头、不改回合。动作位门控来自引擎快照 view.actions，
   * 原型里重算不了，所以绝不假装换了回合（见 README「只做表现、不跑规则」）。
   */
  let activePid = cur.id;
  let lastTurnPid = cur.id;    // 上一次看到的「回合指针」，用来识别换人（而不是比对 activePid）
  let HUD_LOCKED = false;
  let camFocused = false;

  /** 把「锁定中」刷到界面上：整壳置灰、提示条显隐、动作按钮真的 disabled */
  function applyCamLockUI() {
    const shell = document.querySelector('.hud-shell');
    if (shell) shell.classList.toggle('hud-shell--locked', HUD_LOCKED);
    document.querySelectorAll('[data-cam-lock]').forEach((n) => { n.hidden = !HUD_LOCKED; });
    /* 主操作、次操作、挂出、视角预设、棋盘切换 —— 除了巡演按钮，全都要真的 disabled。
     * 只写 .hud-dock 会漏掉舞台工具条里的「复位 / 正俯视 / 斜 45° / 低角度」，
     * 那几个按钮走的是 D25World.setView()，不经过 shell 的捕获拦截。 */
    document.querySelectorAll('.hud-dock .ac-btn, .hud-flatbar .ac-btn, .d25-bar .ac-btn')
      .forEach((n) => {
        if (n.hasAttribute('data-cam-mode')) return;   // 「近景等距」是纯镜头开关，锁定期间也放行
        n.disabled = HUD_LOCKED;
      });
  }

  function camLock(v) {
    const nv = !!v;
    const changed = nv !== HUD_LOCKED;
    HUD_LOCKED = nv;
    /* 锁上的瞬间把已展开的弹层收起 —— 否则弹出层会浮在灰壳上，看着仍可点 */
    if (changed && nv) document.querySelectorAll('.hud-pop--open').forEach((p) => p.classList.remove('hud-pop--open'));
    /* 解锁的瞬间补上演出期间攒下的换人聚焦（镜头入场时正好有人在跳） */
    if (changed && !nv) flushPendingFocus();
    applyCamLockUI();
  }

  /** 让相机聚焦到某位玩家（未启用 3D 时是空操作） */
  function scheduleFocus(pid, opts) {
    activePid = pid;
    const p = st.players.find((x) => x.id === pid);
    document.querySelectorAll('[data-cam-target]').forEach((n) => { n.textContent = p ? p.name : pid; });
    if (!flatMode && HAS_GL && globalThis.D25World) globalThis.D25World.focusPlayer(pid, opts);
  }

  /**
   * 自检钩子：把回合指针挪到第 i 位，走「换人 → 自动聚焦」这条真实路径（仅脚本用，界面无入口）。
   */
  globalThis.__setTurn = (i) => {
    st.currentPlayerIndex = ((i % st.players.length) + st.players.length) % st.players.length;
    render();
    return st.players[st.currentPlayerIndex].id;
  };

  /* ---------------- 镜头模式：全盘俯视 ↔ 近景等距 ----------------
   * 近景等距（参考《環島大富翁》）把棋盘放大到「人物站在格子上、周围只露 5 格左右」，
   * 代价是**看不见全盘**。所以近景必须配一块小地图，否则玩家会彻底失去方位感 —— 这不是装饰。
   */
  const isoMode = () => !!(globalThis.D25World && globalThis.D25World.camMode && globalThis.D25World.camMode() === 'iso');
  let lastMiniTick = -1;

  function toggleCamMode() {
    if (flatMode || !HAS_GL) { toast('方环示意下没有相机，切回 2.5D 再试。'); return; }
    const next = isoMode() ? 'top' : 'iso';
    globalThis.D25World.setCamMode(next, activePid);
    applyCamModeUI();
    toast(next === 'iso'
      ? '🔍 近景等距：正交投影 · 人物居中 · 只留周围几格 —— 方位感看右下小地图（顶部读数有实际格数）'
      : '🗺 回到全盘俯视', 'leaf');
  }

  function applyCamModeUI() {
    const iso = isoMode();
    const b = document.querySelector('[data-cam-mode]');
    if (b) {
      b.textContent = iso ? '🗺 回到全盘' : '🔍 近景等距';
      b.title = iso
        ? '回到全盘俯视'
        : '正交等距近景：人物居中，周围只露几格。近景下方位感看右下小地图';
      b.disabled = HUD_LOCKED;
    }
    document.querySelectorAll('[data-minimap]').forEach((n) => { n.hidden = !iso; });
  }

  /* ---------------- 小地图 ----------------
   * 64 格环 + 持有者着色 + 四名玩家圆点 + 近景取景框。画在一块 2 倍图 canvas 上。
   * 只在近景显示：全盘俯视时它纯属占地方。
   */
  const MINI = { cell: 6, pad: 7, scale: 2, spacing: 2 };

  /**
   * 小地图几何。自建图沿用 17×17 方环；原版图按 `view.layout` 铺 ——
   * 那是与 3D 场景**同一份**世界坐标（都由 shared 的 `boardLayout` 算出来）。
   * 取景框和格子必须同源，否则近景里看着框偏了一格。画布边长按包围盒现算。
   */
  function miniGeom() {
    const k = MINI.cell / MINI.spacing;              // 世界单位 → 小地图像素
    const L = view.layout;
    if (L && L.cells && L.cells.length === st.board.length) {
      const xs = L.cells.map((p) => p.x);
      const zs = L.cells.map((p) => p.z);
      const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
      const midZ = (Math.max(...zs) + Math.min(...zs)) / 2;
      const w = (Math.max(...xs) - Math.min(...xs)) * k + MINI.cell + MINI.pad * 2;
      const h = (Math.max(...zs) - Math.min(...zs)) * k + MINI.cell + MINI.pad * 2;
      const px = (x) => w / 2 + (x - midX) * k;
      const pz = (z) => h / 2 + (z - midZ) * k;
      return { w, h, k, at: (id) => [px(L.cells[id].x), pz(L.cells[id].z)], world: (tx, tz) => [px(tx), pz(tz)] };
    }
    const d = MINI.cell * 17 + MINI.pad * 2;
    const at = (col, row) => [MINI.pad + (col - 1) * MINI.cell + MINI.cell / 2, MINI.pad + (row - 1) * MINI.cell + MINI.cell / 2];
    return {
      w: d, h: d, k,
      at: (id) => { const r = RING[id]; return at(r.col, r.row); },
      world: (tx, tz) => [MINI.pad + (tx / MINI.spacing + 8) * MINI.cell + MINI.cell / 2,
        MINI.pad + (tz / MINI.spacing + 8) * MINI.cell + MINI.cell / 2],
    };
  }

  function drawMinimap() {
    const cv = document.querySelector('[data-minimap]');
    if (!cv || cv.hidden) return;
    const ctx = cv.getContext('2d');
    const g = miniGeom();
    if (cv.width !== Math.round(g.w * MINI.scale) || cv.height !== Math.round(g.h * MINI.scale)) {
      cv.width = Math.round(g.w * MINI.scale); cv.height = Math.round(g.h * MINI.scale);
    }
    ctx.setTransform(MINI.scale, 0, 0, MINI.scale, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    /* 底盘 */
    ctx.fillStyle = 'rgba(255,251,239,.9)';
    ctx.strokeStyle = 'rgba(122,101,71,.75)';
    ctx.lineWidth = 2;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(1, 1, g.w - 2, g.h - 2, 8); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(1, 1, g.w - 2, g.h - 2); ctx.strokeRect(1, 1, g.w - 2, g.h - 2); }
    /* 格环 */
    for (const cell of st.board) {
      const [cx, cy] = g.at(cell.id);
      const hex = cell.group && GROUP[cell.group] ? GROUP[cell.group] : (TYPE_MINI[cell.type] || '#fffbef');
      ctx.fillStyle = hex;
      ctx.fillRect(cx - MINI.cell / 2, cy - MINI.cell / 2, MINI.cell, MINI.cell);
      const owner = view.owners[cell.id];
      if (owner) {
        const p = st.players.find((x) => x.id === owner);
        ctx.strokeStyle = p ? css(p.color) : '#888';
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - MINI.cell / 2 + 0.5, cy - MINI.cell / 2 + 0.5, MINI.cell - 1, MINI.cell - 1);
      }
    }
    /* TILE-31 宝箱（驻留实体）：按月换一格、走到才结算 ⇒ 小地图上必须有它，否则玩家只在日志里
       见过「冒出一只宝箱」，却看不出它压在哪。画在格子下半部，避开玩家棋子那圈圆心。 */
    if (st.treasureCellId !== null && st.treasureCellId !== undefined) {
      const [cx, cy] = g.at(st.treasureCellId);
      ctx.fillStyle = '#d9a227';
      ctx.fillRect(cx - 2.2, cy + 0.8, 4.4, 3.2);
      ctx.strokeStyle = '#7a5410';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(cx - 2.2, cy + 0.8, 4.4, 3.2);
    }
    /* 近景取景框：正交相机在地面上的可视范围 ≈ 宽 × (高/cos el)，再按方位角转一下。
       画出来比任何文字都直观 —— 一眼看出「现在只看得到这一段」。 */
    const cs = globalThis.D25World.cameraState();
    if (isoMode()) {
      /* 世界单位 → 小地图像素的换算由 `miniGeom` 给（原版图的定标与方环不同源）。
         宽高比取 world 报上来的 aspect（已夹过 ISO.maxAspect）—— 自己算舞台宽高比的话，
         超宽屏下相机的横向视野被夹过，框却还按舞台铺满，画出来比实际看得见的范围宽一截。 */
      const aspectBox = cs.aspect || (cv.parentElement && cv.parentElement.clientHeight
        ? cv.parentElement.clientWidth / cv.parentElement.clientHeight : 1.4);
      const view2 = cs.view || 10.4;
      const w = (view2 * aspectBox) * g.k;
      const l = (view2 / Math.cos(Math.PI * 35.264 / 180)) * g.k;
      const [tx, ty] = g.world(cs.tx || 0, cs.tz || 0);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(((cs.az || 0) * Math.PI) / 180);
      ctx.fillStyle = 'rgba(245,167,66,.16)';
      ctx.strokeStyle = 'rgba(226,132,20,.95)';
      ctx.lineWidth = 1.6;
      ctx.fillRect(-w / 2, -l / 2, w, l);
      ctx.strokeRect(-w / 2, -l / 2, w, l);
      ctx.restore();
    }
    /* 四名玩家 */
    for (const p of st.players) {
      const cell = st.board[p.position];
      const [cx, cy] = g.at(cell.id);
      ctx.beginPath();
      ctx.arc(cx, cy, 3.1, 0, 6.3);
      ctx.fillStyle = '#fffbef';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 2.3, 0, 6.3);
      ctx.fillStyle = css(p.color);
      ctx.fill();
      if (p.id === activePid) {                       // 当前镜头目标加一圈金环
        ctx.beginPath();
        ctx.arc(cx, cy, 4.4, 0, 6.3);
        ctx.strokeStyle = '#e0a51f'; ctx.lineWidth = 1.8; ctx.stroke();
      }
    }
  }

  /* 图例色块直接取 world.js 的 GROUP_HEX，改皮肤时两边一起动，不再用 emoji 近似色 */
  /* 小地图的格子配色：有集团的格子取集团色，其余的按格类型给一个近似色。
     刻意比 3D 里的正式配色灰一档 —— 小地图是导航用的，不该跟棋盘抢注意力。 */
  const TYPE_MINI = {
    start: '#ffe08a', chance: '#ffd0e0', news: '#dfe9ff', 'free-card': '#e6e0ff',
    points: '#fff0b8', lottery: '#d6f2e6', magic: '#f0d9ff',
    tax: '#e8e2d2', hospital: '#ffe3e3', jail: '#e3e6ee', game: '#d9f0ff',
    shop: '#ffe6c8', bank: '#f2ead2', god: '#ffd9a8', company: '#d9c9a3',
  };

  const LEGEND_GROUPS = [
    ['#8fd07a', '住宅段'], ['#7ec8ef', '商业段'], ['#c9b48a', '工业段'],
    ['#b7a6e6', '科技段'], ['#7fd8c8', '临海段'], ['#f0b96a', '金融段'],
  ];
  const LEGEND = LEGEND_GROUPS.map(([c, n]) => `<span><i class="d25-sw" style="--c:${c}"></i>${n}</span>`).join('') +
    `<span><i class="d25-sw d25-sw--ring" style="--c:#f5a742"></i><em>描边 = 持有者色</em></span>` +
    `<span><i class="d25-sw d25-sw--dot" style="--c:#ffd45e"></i><em>金晕 = 神明驻留</em></span>` +
    /* 触发口径图例（W3-c）：这三种东西都画在格子上，但生效时机各不相同 —— 玩家要不要绕开、
       会不会连累自己，全看这一句。措辞与 shared 的触发点一致（路障经过截停、地雷踩中、炸弹按步计数）。 */
    `<span>🚧<em>路障＝经过就截停</em></span>` +
    `<span>💥<em>地雷＝踩中才炸，但不拦路（只有路障拦人）</em></span>` +
    `<span>💣<em>炸弹＝放上格，踩中才附身；附身后才倒数，撞到人才甩得出去</em></span>` +
    `<span>🥣<em>乞丐＝站上那一格必须施舍</em></span>`;

  /* 宽画面判定：图例在「棋盘下一条」与「右侧竖导轨」之间切换（见 hud.css .hud-board--wide） */
  const WIDE_MQ = typeof matchMedia === 'function' ? matchMedia('(min-aspect-ratio: 3/2)') : null;
  const isWide = () => !!(WIDE_MQ && WIDE_MQ.matches);

  /* 棋盘形态切换（方环示意）已移除：产品里只有 3D 棋盘一种形态，
     方环仅作为 three / pixi 载入失败时的兜底路径，不再提供手动入口。 */

  /* 悬停浮层：贴着指针走，只讲「这一格是什么」；点击把详情钉进 dock，不常驻挡棋盘。
     选格态下多问一句「这一格能不能选」—— 不能选时把引擎的原话贴出来，玩家不用点了才知道。 */
  function showTip(id) {
    if (id == null) { tipEl.style.opacity = '0'; return; }
    const bits = cellBits(id);
    if (pickCells) {
      bits.push(pickCells.includes(id) ? '✅ 可选为目标' : (pickReasons.get(id) ?? '不可选'));
    }
    /* 选人模式：把站在这格上的人逐个报出来，可选的给✅，不可选的引引擎那句原话
       （「阿福 不在视野内」），玩家才知道是「够不着」而不是「没这个人」 */
    if (pickPlayers.length) {
      for (const q of st.players) {
        if (q.position !== id || q.bankrupt) continue;
        bits.push(pickPlayers.includes(q.id) ? `✅ 可选「${q.name}」` : (pickPlayerReasons.get(q.id) ?? `「${q.name}」不可选`));
      }
    }
    const p = globalThis.D25World.lastPointer();
    tipEl.innerHTML = `<b>${esc(bits[0])}</b><br>${bits.slice(1).map(esc).join('<br>')}`;
    const w = tipEl.offsetWidth || 200, h = tipEl.offsetHeight || 60;
    tipEl.style.left = `${Math.max(8, Math.min(innerWidth - w - 14, p.x + 14))}px`;
    tipEl.style.top = `${Math.max(h / 2 + 8, Math.min(innerHeight - h / 2 - 8, p.y))}px`;
    tipEl.style.opacity = '1';
  }

  function ensureStage() {
    if (stage) return stage;
    stage = el('div', 'd25-stage');
    /* 舞台工具条只保留「近景等距 ↔ 回到全盘」这一个真实玩法开关。
       原型里的视角预设（复位/正俯视/斜45°/低角度）与「镜头巡演」是验收用的一次性入口，
       产品里不需要，已摘除；镜头读数也去掉了 fps / draw call 这类开发者指标。 */
    stage.innerHTML = `<div class="d25-bar">
        <span class="hud-chip d25-cam">🎥 初始化…</span>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-cam-mode type="button"
          title="正交等距近景：人物居中，周围只露几格。近景下方位感看右下小地图">🔍 近景等距</button>
      </div>
      <div class="d25-hint">拖拽 / 方向键转视角 · 滚轮推拉 · 悬停看格子 · 点击钉到下方操作台</div>
      <canvas class="d25-minimap" data-minimap hidden></canvas>
      <div class="d25-mininote" data-minimap hidden>小地图 · 近景取景框</div>`;
    camChip = stage.querySelector('.d25-cam');
    tipEl = el('div', 'd25-tip');
    document.body.appendChild(tipEl);
    stage.querySelector('[data-cam-mode]').onclick = () => toggleCamMode();
    globalThis.D25World.mount(stage, S, {
      onFrame: () => {
        globalThis.D25Overlay.tick();
        const c = globalThis.D25World.cameraState();
        /* 自愈：HUD 的锁定态只靠 onCameraLock 回调投影，一旦那次回调因为重建 / 异常漏掉，
           整个界面就会永久假死（所有按钮被捕获阶段拦掉）。这里每帧跟 world 的真实状态对一次，
           差了就纠正 —— 代价只是一次布尔比较，换掉「点哪儿都没反应」这种最难查的故障。 */
        if (HUD_LOCKED !== globalThis.D25World.isCameraLocked()) camLock(globalThis.D25World.isCameraLocked());
        /* 读数只报玩家看得懂的两件事：现在看的是全盘还是近景、镜头跟着谁。
           原型那版还带 fps / draw call / 相机距离与俯角 —— 那是开发指标，产品里不该出现。 */
        const who = c.pid ? (st.players.find((p) => p.id === c.pid)?.name || '') : '';
        const lens = c.mode === 'iso'
          ? `🔍 近景等距 · 周围 ${globalThis.D25World.visibleCells().count} 格`
          : '🗺 全盘';
        const camTag = c.state === 'intro' ? ' · 聚焦中' : c.state === 'follow' && who ? ` · 跟随 ${who}` : '';
        const txt = `${lens}${camTag}`;
        if (camChip.textContent !== txt) camChip.textContent = txt;
        /* 小地图按 ~15fps 重画就够：它是导航辅助，不需要跟满帧 */
        const tick = Math.floor(performance.now() / 66);
        if (tick !== lastMiniTick) { lastMiniTick = tick; drawMinimap(); }
      },
      onCameraMode: () => applyCamModeUI(),
      onHover: (id) => showTip(id),
      onSelect: (id) => {
        if (HUD_LOCKED) return;
        /* 选格态：把这一格原样交回宿主去判合法性并派单 —— 表现层不复制一套「能不能选」 */
        if (pickCells && hostApi.onPickCell) { hostApi.onPickCell(id); return; }
        if (id != null) { selCell = id; render(); }
      },
      /* 选人态（W3-d）：点到的棋子交回宿主，由它拿同一个谓词判定并派单；这里不拦、也不判 */
      onPickPlayer: (pid) => {
        if (HUD_LOCKED) return;
        if (pickPlayers.length && hostApi.onPickPlayer) hostApi.onPickPlayer(pid);
      },
      onLand: (pid, cellId, kind) => globalThis.D25Overlay.float(landLabel(cellId, kind), cellId, kind === 'transfer' ? 'bad' : 'gold'),
      /* 一次移动演出收尾：把攒下来的「换人聚焦」放出去（见 playMovement / syncStage） */
      onMoveSettled: () => flushPendingFocus(),
      /* 相机进场期间锁操作；视角停稳（补间跑完）才解锁 —— 这两条回调就是「屏蔽输入」的唯一开关 */
      onCameraLock: (v) => camLock(v),
      onCameraSettled: () => camLock(false),
    });
    globalThis.D25Overlay.mount(stage, S);
    return stage;
  }

  function renderBoard() {
    if (flatMode || !HAS_GL) {
      const w = renderFlatBoard();
      w.classList.add('hud-board--flat');
      if (!flatMode) w.insertBefore(el('div', 'hud-foot', 'three.js / pixi.js 没加载（vendor 缺件），已退回方环示意。'), w.firstChild);
      /* 方环铺满整列宽，四角都是格子，浮动按钮会压住格 —— 走一行独立工具条 */
      const bar = el('div', 'hud-flatbar');
      bar.appendChild(el('span', 'hud-chip hud-chip--off', '方环示意（可读性优先）'));
      w.appendChild(bar);
      return w;
    }
    const wrap = el('section', 'hud-board d25' + (isWide() ? ' hud-board--wide' : ''));
    const hostEl = el('div', 'd25-host');
    hostEl.appendChild(ensureStage());
    wrap.appendChild(hostEl);
    wrap.appendChild(el('div', 'd25-legend', LEGEND));
    return wrap;
  }

  /* ---------------- 移动演出：认引擎记下的路线 → 骰子 + 逐格跳 ----------------
   * 引擎把「掷骰 → 走 n 步 → 落格结算」压成一个原子动作，客户端每次拿到的都是走完之后的状态，
   * 中间那些格子只记在 `state.movePath` 里。这里认它、照着逐格跳。
   * 认不出路线的位移**一律不猜**：那是押送 / 传送 / 神明挪位，语义就是瞬移（见 `playMovement`）。
   * 纯表现：不参与任何规则判定，也不改写状态。
   */
  const HOP_MAX_CELLS = 8;    // 一次最多演 8 格（0.16 秒/格 ≈ 1.3 秒）；更长的行程只演最后 8 格
  let lastPos = null;         // Map<pid, cellId>；null = 还没基线（HUD 首帧不演）
  let spunDice = null;        // 已经摇过的那一手骰子（同一份点数不摇第二遍）
  let pendingTurnPid = null;  // 演出期间攒着的镜头交接对象（跳完才放）

  /** b 是不是 a 的邻格：原版图读 `neighbors`，自建图（不写这个字段）退回环上 ±1 */
  function isStep(a, b) {
    const n = st.board.length || 64;
    const c = st.board[a];
    if (c && c.neighbors) return c.neighbors.includes(b);
    return (b - a + n) % n === 1 || (a - b + n) % n === 1;
  }

  function playMovement() {
    const now = new Map(st.players.map((p) => [p.id, p.position]));
    const prev = lastPos;
    lastPos = now;
    if (!prev || flatMode || !HAS_GL) return false;
    if (!globalThis.D25World || !globalThis.D25World.playMove) return false;
    const moved = st.players.filter((p) => prev.has(p.id) && prev.get(p.id) !== p.position);
    // 只演「一个人沿圈走了几步」。多人同帧位移 = 换位卡那类，硬演会让人绕半个棋盘飘过去
    if (moved.length !== 1) return false;
    const p = moved[0];
    // heading 是邻接表下标：环上 0 = 逆时针、1 = 顺时针（引擎里 direction 的替身）
    const dir = p.heading === 0 ? -1 : 1;
    const from0 = prev.get(p.id);
    /* 认路线要过三道脸：① 有路线；② 尾巴不是这个人上一帧的脚下格（那说明这一段上一帧就演完了，
       这次位移是传送 / 押走，不是走路）；③ 第一格确实从他上一帧那一格出发 —— ②③ 也是「这条路线
       归不归他」的证据，`movePath` 是全队共用的一格，别人走过的路不能安到他头上。
       认不过就直接落位：押送进监狱 / 住院、传送机、神明挪位那类位移引擎从不写路线，
       旧写法按环上取模补走，看着就是「从反方向绕半个棋盘走过去」，距离越远越假。 */
    const rec = st.movePath;
    if (!rec || !rec.length || rec[rec.length - 1] === from0 || !isStep(from0, rec[0])) return false;
    const start = Math.max(0, rec.length - HOP_MAX_CELLS);
    const cells = rec.slice(start);
    const from = start > 0 ? rec[start - 1] : from0;
    const walk = cells.length;
    /* 走完这条路人却不在尾巴上 = 这一手还被押走 / 传送了一次：把真落点交出去，
       由 world 演第二段（停一拍让人读完播报，再瞬移到那一格）。 */
    const transfer = rec[rec.length - 1] !== p.position ? p.position : null;
    /* 骰子只在「这一手第一次出现」时摇：`state.dice` 如今留到下一手才被覆盖（回合推进不清），
       不认脸的话传送、神明挪位那些也会把上一手的点数又摇一遍。 */
    const dice = st.dice || [];
    const key = `${st.turn}:${dice.join('+')}`;
    const spin = dice.length > 0 && walk <= dice.reduce((a, b) => a + b, 0) && key !== spunDice;
    if (spin) spunDice = key;
    return globalThis.D25World.playMove({ pid: p.id, from, steps: walk, dir, cells, transfer, dice: spin ? dice : null });
  }

  /** 演出结束（或被取消）后把攒下的换人聚焦放出去 —— 「跳完才交接镜头」的那一刀 */
  function flushPendingFocus() {
    // 镜头还在入场补间里就先留着，由 camLock 解锁的那一侧补放，别让这次交接彻底丢掉
    if (!pendingTurnPid || HUD_LOCKED || flatMode || !HAS_GL) return;
    const pid = pendingTurnPid;
    pendingTurnPid = null;
    scheduleFocus(pid);
    if (globalThis.D25Overlay) globalThis.D25Overlay.rebuild();
    if (globalThis.D25World) globalThis.D25World.renderOnce();
  }

  /** 舞台进 DOM 之后再量尺寸：rAF 在后台标签页被冻结，所以这里同步出首帧 */
  function syncStage() {
    if (!stage || flatMode || !HAS_GL) return;
    globalThis.D25World.resize();
    // 先派发动画再 sync：sync 会把没在演出的棋子直接摆到真值格上
    playMovement();
    globalThis.D25World.sync(S);
    if (globalThis.D25Overlay.setSnapshot) globalThis.D25Overlay.setSnapshot(S);
    globalThis.D25World.paintOwners();

    /* 镜头目标的决定必须排在 Overlay.rebuild() 之前：
     * 名牌金底取的是「跟随中的那位」（world.tokenAnchors().cur），先 rebuild 再换目标，
     * 金底就会停在上一回合的玩家身上 —— 只差一帧，但那一帧之后没人再 rebuild，就一直是错的。 */
    if (!camFocused) {
      /* 首屏先让人看清全貌，再把镜头走向当前玩家 —— 一上来就怼近景会失去方位感 */
      camFocused = true;
      setTimeout(() => {
        if (flatMode || !HAS_GL || HUD_LOCKED) return;
        scheduleFocus(activePid);
        globalThis.D25Overlay.rebuild();
        globalThis.D25World.renderOnce();
      }, 420);
    } else {
      /* 回合「换人」时（引擎推进后快照刷新）自动把镜头交给新的当前玩家。
       * 判据必须是「回合指针是否变化」，不能用 activePid 比对 —— 一旦别处挪过 activePid，
       * 每次 render() 都会把镜头又拽回去。 */
      const turnPid = st.players[st.currentPlayerIndex].id;
      if (turnPid !== lastTurnPid) {
        lastTurnPid = turnPid;
        /* 上一位还在格子上跳 ⇒ 先记账，等他跳完再交镜头：状态是一次原子掷骰一起到的，
           镜头若此刻就甩向下一位，玩家看到的是「棋子腾空、画面已走」。 */
        if (globalThis.D25World.isHopping && globalThis.D25World.isHopping()) pendingTurnPid = turnPid;
        else if (!HUD_LOCKED) scheduleFocus(turnPid);
      }
    }

    globalThis.D25Overlay.rebuild();
    globalThis.D25World.renderOnce();
  }
  window.addEventListener('resize', () => requestAnimationFrame(syncStage));
  /* 横竖屏跨越 3:2 是整块重排（图例横排 ↔ 竖导轨），单靠 resize 改尺寸不够 */
  if (WIDE_MQ) {
    const onBreakpoint = () => { if (HAS_GL && !flatMode) render(); };
    if (WIDE_MQ.addEventListener) WIDE_MQ.addEventListener('change', onBreakpoint);
    else if (WIDE_MQ.addListener) WIDE_MQ.addListener(onBreakpoint);
  }

  /* ---------------- 格子明细：方环与 2.5D 共用一份文案 ---------------- */
  /* 一家公司可能占两格（原版图就是如此），所以「这格是不是公司」一律按 footprint 问。
     缺 footprint 的旧快照退回单格，不至于整张图认不出公司。 */
  const companyFootprint = (c) => (c.footprint && c.footprint.length ? c.footprint : [c.cellId]);
  const companyOnCell = (id) => st.companies.find((c) => companyFootprint(c).includes(id));

  function cellBits(id) {
    const cell = st.board[id];
    const typeName = CELL[cell.type][1];
    const corp = companyOnCell(id);
    const god = view.gods.find((g) => g.cellId === id);
    const bits = [`${cell.id} · ${cell.name} · ${typeName}`];
    if (corp) bits.push(`面值 🔔${money(corp.sharePrice)}（这家公司占 ${companyFootprint(corp).join('·')} 两格，踩到哪一格都能认购）`);
    else if (cell.price) bits.push(`地价 🔔${money(cell.price * view.priceIndex)}`);
    if (cell.baseRent) bits.push(`每级租金 🔔${money(cell.baseRent * view.priceIndex)}`);
    if (corp) {
      const held = Object.entries(corp.shares).map(([k, v]) => `${st.players.find((p) => p.id === k)?.name ?? k}×${v}`).join(' ') || '无人持股';
      bits.push(`盈余 🔔${money(corp.surplus)}｜${held}`);
      bits.push(`经营权：${corp.chairmanId ? st.players.find((p) => p.id === corp.chairmanId)?.name : '空缺'}`);
    }
    const own = view.owners[id];
    if (own) bits.push(`持有：${st.players.find((p) => p.id === own)?.name}`);
    const grade = st.players.flatMap((p) => p.properties).find((q) => q.cellId === id);
    if (grade) bits.push(`${grade.grade} 级${grade.facility ? ` · ${view.names.facilities[grade.facility]?.name ?? grade.facility}` : ''}`);
    if (god) bits.push(`神明驻留：${god.name}（剩 ${god.ttlDays} 天）· ${god.summary}`);
    if (st.treasureCellId === id) bits.push(`宝箱驻留：踩到这一格领 ${view.treasurePoints} 点券（路过不算，本月只此一只）`);
    return bits;
  }

  /* ---------------- 棋盘环（?board=flat） ---------------- */
  function renderFlatBoard() {
    const wrap = el('section', 'hud-board');
    const ring = el('div', 'hud-ring');
    const godAt = new Map(st.boardGods.map((g) => [g.cellId, g]));
    const companyAt = new Map(st.companies.flatMap((c) => companyFootprint(c).map((id) => [id, c])));

    for (const { cell, col, row } of RING) {
      const d = el('div', 'hud-cell hud-tip');
      d.style.gridColumn = String(col);
      d.style.gridRow = String(row);
      const [emoji] = CELL[cell.type];
      const owner = ownerColor(cell.id);
      const corp = companyAt.get(cell.id);
      if (NAMED.has(cell.type)) {
        d.classList.add('hud-cell--named');
        d.style.setProperty('--g', GROUP[cell.group] || '#e8d9b0');
      }
      if (owner) { d.classList.add('hud-cell--owned'); d.style.setProperty('--oc', owner); }
      if (cell.id === cur.position) d.classList.add('hud-cell--cur');
      if (godAt.has(cell.id)) d.classList.add('hud-cell--god');

      const mark = corp?.chairmanId ? '👑' : godAt.has(cell.id) ? (GOD_EMOJI[godAt.get(cell.id).godId] || '✨')
        : cell.id === st.treasureCellId ? '🎁' : cell.type === 'chance' ? '' : '';
      d.innerHTML = `<span class="hud-cell__e">${emoji}</span>` +
        (NAMED.has(cell.type) ? `<span class="hud-cell__n">${esc(cell.name)}</span>` : '') +
        (mark ? `<span class="hud-cell__mark">${mark}</span>` : '');

      d.dataset.tip = cellBits(cell.id).join('\n');
      ring.appendChild(d);
    }

    /* 玩家棋子：同一格挤在一起时挂进该格内部的 pips 容器 */
    const cellEls = new Map();
    [...ring.children].forEach((node, i) => { if (node.classList.contains('hud-cell')) cellEls.set(RING[i].cell.id, node); });
    const byCell = new Map();
    for (const p of st.players) {
      const list = byCell.get(p.position) || [];
      list.push(p);
      byCell.set(p.position, list);
    }
    for (const [cellId, list] of byCell) {
      const host = cellEls.get(cellId);
      if (!host) continue;
      const pips = el('div', 'hud-cell__pips');
      for (const p of list) {
        const pip = el('span', 'hud-pip');
        pip.style.setProperty('--pc', css(p.color));
        pip.title = `${p.name} · ${p.bankrupt ? '已破产' : `脚下「${cellName(p.position)}」`}`;
        pips.appendChild(pip);
      }
      host.appendChild(pips);
    }

    ring.appendChild(wrapCenter());
    wrap.appendChild(ring);
    return wrap;
  }

  /* 方环回退：环心里把「选中格」和「岛况」两块叠起来 */
  function wrapCenter() {
    const c = el('div', 'hud-center');
    const bd = el('div', 'ac-panel');
    bd.innerHTML = `<span class="ac-leaf tl"></span><span class="ac-leaf tr"></span><span class="ac-leaf bl"></span><span class="ac-leaf br"></span>
      <div class="ac-panel__hd">🍃 岛况</div><div class="ac-panel__bd" data-slot></div>`;
    const slot = bd.querySelector('[data-slot]');
    situationPanel(slot);
    c.append(tileBlock(), bd);
    return c;
  }

  /* ---------------- dock 左块：选中格（默认脚下格）明细 ---------------- */
  function tileBlock() {
    const id = selCell == null ? cur.position : selCell;
    const cell = st.board[id];
    const [emoji, typeName] = CELL[cell.type];
    const corp = companyOnCell(id);
    const owner = view.owners[id];
    const isCur = id === cur.position;
    const box = el('div', 'hud-tile');
    const rows = [];
    if (cell.price) rows.push(`<span>${corp ? '面值' : '售价'} <b class="hud-num">🔔${money(corp ? corp.sharePrice : Math.round(cell.price * view.priceIndex))}</b></span>`);
    if (cell.baseRent) rows.push(`<span>租金 <b class="hud-num">🔔${money(cell.baseRent * view.priceIndex)}</b>/级</span>`);
    rows.push(`<span>${owner ? '持有 <b>' + esc(st.players.find((p) => p.id === owner)?.name ?? '?') + '</b>' : '归属 <b>无主</b>'}</span>`);
    if (corp) rows.push(`<span>经营权 <b>${corp.chairmanId ? esc(st.players.find((p) => p.id === corp.chairmanId)?.name) : '空缺'}</b></span>`);
    box.innerHTML = `<div class="hud-tile__hd"><span>${emoji}</span>${isCur ? '脚下' : '选中'} · ${esc(cell.name)}
        <small style="font-weight:800;color:var(--ac-dim)">${typeName}</small></div>
      <div class="hud-tile__rows">${rows.join('')}</div>
      <div class="hud-tile__rows"><span>骰子 <b class="hud-num">${st.dice ? st.dice.join('+') + '=' + st.dice.reduce((a, b) => a + b, 0) : '未掷'}</b></span>
        <span>🍎骰力 <b class="hud-num">${cur.diceCount}</b></span></div>`;
    if (!isCur) {
      const back = el('button', 'ac-btn ac-btn--cream ac-btn--sm', '回到脚下');
      back.style.marginTop = '4px';
      back.onclick = () => { selCell = cur.position; render(); };
      box.appendChild(back);
    }
    return box;
  }

  /* ---------------- 岛况：状态 chips + 神明驻留 + 恶人 + 拍卖 + 女巫 ---------------- */
  function situationPanel(bd) {
    const chips = el('div', 'hud-chips');
    const d = view.date;
    if (d.isHoliday) chips.appendChild(el('span', 'hud-chip hud-chip--warn', '🏖️ 例假日：股市休市、银行不放款'));
    if (st.stockHaltAllDays > 0) chips.appendChild(el('span', 'hud-chip hud-chip--warn', `🚧 全市场停牌 ${st.stockHaltAllDays} 天`));
    if (st.loanBanDays > 0) chips.appendChild(el('span', 'hud-chip hud-chip--warn', `🏦 银行停止放款 ${st.loanBanDays} 天`));
    if (st.roadblocks.length) chips.appendChild(el('span', 'hud-chip', `🚧 路障 ${st.roadblocks.length} 个`));
    if (st.mines.length) chips.appendChild(el('span', 'hud-chip hud-chip--warn', `💥 地雷 ${st.mines.length} 个`));
    for (const b of st.bombs) chips.appendChild(el('span', 'hud-chip hud-chip--warn', `💣 ${esc(st.players.find((p) => p.id === b.playerId)?.name ?? b.playerId)} 身上剩 ${b.stepsLeft} 步`));
    for (const p of st.players) {
      if (p.skipTurns > 0) chips.appendChild(el('span', 'hud-chip', `⏸️ ${esc(p.name)} 停 ${p.skipTurns} 回合`));
      if (p.god) {
        const g = view.names.godList.find((x) => x.id === p.god.godId);
        const chip = el('span', 'hud-chip hud-chip--god hud-tip', `${GOD_EMOJI[p.god.godId] || '✨'} ${esc(g?.name ?? p.god.godId)} 附身 ${p.god.remainingDays} 天`);
        chip.dataset.tip = `附身：${g?.possession ?? ''}${g?.travel ? `｜出巡：${g.travel}` : ''}`;
        chips.appendChild(chip);
      }
      if (p.custody) chips.appendChild(el('span', 'hud-chip hud-chip--warn', `${p.custody.kind === 'jail' ? '🚔 在押' : '🏥 住院'} ${esc(p.name)} 剩 ${p.custody.daysLeft} 天`));
    }
    if (st.phase === 'awaiting_roll') chips.appendChild(el('span', 'hud-chip hud-chip--god', '🎲 等待掷骰'));
    // 落格窗开着时把「停在哪儿、还欠不欠一个决定」写进状态条：回合是自己走的，不是玩家按的
    if (st.phase === 'awaiting_action') chips.appendChild(el('span', 'hud-chip hud-chip--god', '📍 ' + phaseLabel()));
    bd.appendChild(chips.children.length ? chips : el('div', 'hud-foot', '此刻没有全局状态生效'));

    if (view.gods.length) {
      bd.appendChild(el('div', 'ac-divider', '<span class="ac-divider__mark">🍃 岛上驻留的神（经过即附身）</span>'));
      const row = el('div', 'hud-chips');
      row.style.gap = '10px';
      for (const g of view.gods) {
        const card = el('button', 'ac-card ac-card--smug');
        card.style.cssText = `width:112px;position:relative;background:${g.godId.includes('poverty') || g.godId.includes('misfortune') ? '#ffe9ef' : '#fffbe8'}`;
        card.innerHTML = `<div class="ac-card__art"><span class="ac-card__tag">驻 ${g.cellId} 格</span>${GOD_EMOJI[g.godId] || '✨'}</div>
          <div class="ac-card__name">${esc(g.name)}</div>
          <div class="ac-card__foot"><div class="ac-bar"><div class="ac-bar__fill ac-bar__fill--mile" style="width:${Math.min(100, g.ttlDays / 7 * 100)}%"></div></div></div>`;
        card.title = `${g.name}：${g.summary}（剩 ${g.ttlDays} 天，第 ${g.bornDay} 天现身）`;
        card.onclick = () => { selCell = g.cellId; render(); };
        row.appendChild(card);
      }
      bd.appendChild(row);
    }

    const jailed = st.npcs.filter((n) => n.jailed);
    if (jailed.length) {
      bd.appendChild(el('div', 'ac-divider', '<span class="ac-divider__mark">🚔 狱中恶人</span>'));
      const row = el('div', 'hud-chips');
      row.appendChild(el('span', 'hud-chip hud-chip--npc', `保释金 🥬${A.bailFee}（站上监狱门外才可办）`));
      for (const n of jailed) row.appendChild(el('span', 'hud-chip hud-chip--npc', `${NPC[n.kind]} ${NPC_CN[n.kind] ?? n.kind}`));
      bd.appendChild(row);
    }

    if (st.auction) {
      const a = st.auction;
      const p = el('div', 'ac-panel');
      p.innerHTML = `<div class="ac-panel__hd" style="background:var(--ac-orange)">🔨 拍卖会 · ${esc(st.board[a.cellId]?.name ?? '')}</div>
        <div class="ac-panel__bd"><div class="hud-tile__rows">
        <span>当前最高 <b class="hud-num">🔔${money(a.highestBid)}</b></span>
        <span>下次最低 <b class="hud-num">🔔${money(A.auctionMinBid)}</b></span>
        <span>在场竞买 <b>${a.bidders.length}</b></span></div>
        <div class="hud-chips">${a.bidders.map((b, i) => `<span class="hud-chip${i === a.turnIndex ? ' hud-chip--god' : ''}">${esc(st.players.find((p) => p.id === b)?.name ?? b)}${i === a.turnIndex ? ' ← 轮到他' : ''}</span>`).join('')}${a.withdrawn.map((b) => `<span class="hud-chip hud-chip--off">已弃权 ${esc(st.players.find((p) => p.id === b)?.name ?? b)}</span>`).join('')}</div></div>`;
      bd.appendChild(p);
    }
    if (A.magic) {
      const p = el('div', 'ac-panel');
      p.innerHTML = `<div class="ac-panel__hd" style="background:var(--ac-pink)">🔮 女巫的水晶球</div>
        <div class="ac-panel__bd"><div class="hud-tile__rows"><span>本局目标 <b>${esc(magicLabel(A.magic.condition))}</b></span><span>名单不公布 · 站上去才知道谁中招</span></div></div>`;
      bd.appendChild(p);
    }
  }

  /* ---------------- 侧栏 ---------------- */
  const TABS = ['岛民', '岛况', '股市', '账本', '播报', '公布栏'];
  let activeTab = '岛民';

  function badge(text, kind, tip) {
    return `<span class="hud-bg ${kind ? `hud-bg--${kind}` : ''} hud-tip" data-tip="${esc(tip || text)}">${text}</span>`;
  }
  function playerBadges(p) {
    const out = [];
    const day = view.date.dayIndex;
    if (p.god) {
      const g = view.names.godList.find((x) => x.id === p.god.godId);
      out.push(badge(`${GOD_EMOJI[p.god.godId] || '✨'}${g?.name ?? p.god.godId} ${p.god.remainingDays}天`, 'god', `附身：${g?.possession ?? ''}${g?.travel ? `｜出巡：${g.travel}` : ''}`));
    }
    if (p.custody) out.push(badge(p.custody.kind === 'jail' ? `🚔在押${p.custody.daysLeft}` : `🏥住院${p.custody.daysLeft}`, 'bad', '暂停行动并丧失收租权'));
    if (p.skipTurns > 0) out.push(badge(`⏸️停留${p.skipTurns}`, 'bad', '剩余跳过回合数'));
    if (p.holdTurns > 0) out.push(badge(`📍驻留${p.holdTurns}`, 'bad', '停留卡：下次前进停在原地'));
    if (p.rentBlockedTurns > 0) out.push(badge('🚫禁租' + p.rentBlockedTurns, 'bad', '丧失收租权剩余天数'));
    if (p.sleepwalkTurns > 0) out.push(badge('😴梦游' + p.sleepwalkTurns, 'bad', '丧失收租与买地权利'));
    if (p.turtleTurns > 0) out.push(badge('🐢乌龟' + p.turtleTurns, '', '一次只走一步'));
    if (p.bulldozerTurns > 0) out.push(badge('🚜工程车' + p.bulldozerTurns, '', '走到哪拆到哪'));
    if (p.abroadTurns > 0) out.push(badge('✈️出国' + p.abroadTurns, 'bad', '出国期间不能收租'));
    if (p.insurance) out.push(badge(`🛡️保险${p.insurance.daysLeft}`, 'money', '期间可理赔灾害损失'));
    if (p.alliance) out.push(badge(`🤝同盟${p.alliance.daysLeft}`, 'money', `与 ${esc(st.players.find((x) => x.id === p.alliance.with)?.name ?? p.alliance.with)} 互不收租`));
    if (p.research) out.push(badge(`🔬${esc(view.names.items[p.research.itemId]?.name ?? p.research.itemId)} ${p.research.remainDays}天`, 'money', '研究所研发中'));
    if (p.unlucky) out.push(badge(`🌧️霉运${p.unlucky.daysLeft}×${p.unlucky.multiplier}`, 'bad', '负面事件与租金按倍率放大'));
    if (p.diceCount > 1) out.push(badge(`🎲×${p.diceCount}`, '', '骰子个数'));
    if (p.financing > 0) out.push(badge(`💳融资 🔔${money(p.financing)}`, 'bad', '董事长特别融资未还额（期间存款不计息）'));
    if (p.loan) out.push(badge(`🏦贷款 🔔${money(p.loan.principal)}（剩 ${Math.max(0, p.loan.dueDayIndex - day)} 天）`, 'bad', '到期强制全额归还，无利息'));
    const chair = st.companies.filter((c) => c.chairmanId === p.id).length;
    if (chair) out.push(badge(`👑董事长×${chair}`, 'money', '握有经营权，停靠自家免付费'));
    const bomb = st.bombs.find((b) => b.playerId === p.id);
    if (bomb) out.push(badge(`💣剩 ${bomb.stepsLeft} 步`, 'bad', '定时炸弹：走满步数爆炸'));
    if (p.cards.length) out.push(badge(`🃏手牌 ${p.cards.length}/${15}`, '', '手牌额满须舍弃'));
    if (!p.online) out.push(badge('📴离线', 'bad', '掉线中，由托管代打'));
    if (p.bankrupt) out.push(badge('💀破产', 'bad', '已退出本局'));
    if (p.id.startsWith('bot-')) out.push(badge('🤖', '', 'AI 代打'));
    return out.join('');
  }

  /* 把 `awaiting_action` 这类实现枚举直接印进页脚，等于让玩家读代码。R4 之后落格窗还分
     「单步」与「会话（商店 / 银行）」两种出口，所以这里按 `A.landing` 说人话。 */
  const PHASE_CN = {
    lobby: '大厅等待开局',
    awaiting_roll: '等待掷骰',
    awaiting_action: '落格处理中',
    awaiting_pick: '小游戏中',
    awaiting_auction: '拍卖中',
    awaiting_discard: '手牌额满',
    game_over: '对局结束',
  };
  function phaseLabel() {
    const base = PHASE_CN[st.phase] ?? st.phase;
    if (st.phase !== 'awaiting_action' || !A.landing) return base;
    const name = cellName(A.landing.cellId);
    if (A.landing.venue === 'shop') return `在${name}购物`;
    if (A.landing.venue === 'bank') return `在${name}办事`;
    return `停在${name} · 处理完自动结束`;
  }

  const snapshotFoot = () =>
    `第 ${st.turn} 回合 · ${phaseLabel()} · 行动者 ${esc(cur.name)} · 物价 ×${view.priceIndex.toFixed(3)}`;

  function tabPanel() {
    const p = el('div', 'ac-panel');
    p.innerHTML = `<span class="ac-leaf tl"></span><span class="ac-leaf tr"></span><span class="ac-leaf bl"></span><span class="ac-leaf br"></span>
      <div class="ac-panel__hd" id="panelHd"></div><div class="ac-panel__bd" id="panelBd"></div>`;
    const hd = p.querySelector('#panelHd');
    const bd = p.querySelector('#panelBd');
    if (activeTab === '岛民') renderIslanders(hd, bd);
    else if (activeTab === '岛况') { hd.textContent = '🍃 岛况 · 全局状态与神鬼'; situationPanel(bd); }
    else if (activeTab === '股市') renderMarket(hd, bd);
    else if (activeTab === '账本') renderBooks(hd, bd);
    else if (activeTab === '播报') renderLog(hd, bd);
    else renderBoardListing(hd, bd);
    p.appendChild(el('div', 'hud-panelfoot', snapshotFoot()));
    return p;
  }

  function renderIslanders(hd, bd) {
    hd.textContent = `🏝️ 岛民 · 按总资产排`;
    const leader = view.assets[0]?.total || 1;
    const list = el('div', 'ac-list');
    for (const a of view.assets) {
      const p = st.players.find((x) => x.id === a.playerId);
      const item = el('div', 'ac-list__item hud-tip');
      const shares = Object.values(p.stocks).reduce((x, y) => x + y, 0);
      const items = Object.values(p.items).reduce((x, y) => x + y, 0);
      const pct = Math.max(3, Math.round(a.total / leader * 100));
      item.dataset.tip = `现金 🔔${money(a.cash)}｜存款 ✈️${money(a.deposit)}\n土地 ${money(a.landValue)}｜房屋 ${money(a.houseValue)}\n上市股 ${money(a.stockValue)}｜原始股 ${money(a.corpValue)}\n贷款 −${money(a.loan)}\n总计 🔔${money(a.total)}`;
      item.innerHTML = `<div class="ac-list__ic">${avaOf(p)}</div>
        <div class="ac-list__tx"><b>${esc(p.name)}${p.id === viewportPid ? '<span class="hud-you">你</span>' : ''}${p.id === cur.id ? '<span class="hud-cur">行动中</span>' : ''}
          <span class="hud-badges">${playerBadges(p)}</span></b>
          <small>🔔${money(p.cash)} · ✈️${money(p.deposit)} · 🥬${money(p.points)} · 🏠${p.properties.length} · 📈${shares} · 🧰${items}${p.properties.some((q) => q.facility) ? ` · 🏗️${p.properties.filter((q) => q.facility).length}` : ''}${p.properties.some((q) => q.chain) ? ` · 🏪${p.properties.filter((q) => q.chain).length}` : ''}</small></div>
        <span class="ac-list__val">🔔${money(a.total)}</span>
        <div class="hud-rank">
          <span class="hud-rank__track"><i class="hud-rank__fill" style="width:${pct}%"></i></span>
          <em>相对榜首 <b>${pct}%</b> · 脚下「${esc(st.board[p.position].name)}」</em>
        </div>`;
      item.onclick = () => { viewportPid = p.id; render(); };
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.setAttribute('aria-label', `以 ${p.name} 的视角查看钱包与清单`);
      item.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewportPid = p.id; render(); } };
      list.appendChild(item);
    }
    bd.appendChild(list);
    bd.appendChild(el('div', 'hud-foot', '点一名岛民 = 切换表现层视角（只看他的钱包与清单，回合归属不变）'));
  }

  function sparkline(stock) {
    const cs = stock.candles;
    if (!cs.length) return '<svg class="hud-kline"></svg>';
    /* viewBox 宽 320 ≈ 面板实宽（≈300），x 向拉伸≈1，蜡烛不会被拉扁；高 52 给影线留空间 */
    const w = 320, h = 52, pad = 3;
    const hi = Math.max(...cs.map((c) => c.high)), lo = Math.min(...cs.map((c) => c.low));
    const span = Math.max(1, hi - lo);
    const volMax = Math.max(...cs.map((c) => c.volume), 1);
    const step = (w - pad * 2) / cs.length;
    const y = (v) => pad + (h - pad * 2) * (1 - (v - lo) / span);
    let svg = `<svg class="hud-kline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`;
    cs.forEach((c, i) => {
      const x = pad + i * step + step / 2;
      const up = c.close >= c.open;
      svg += `<line class="wick" x1="${x.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(c.low).toFixed(1)}"/>`;
      const top = Math.min(y(c.open), y(c.close));
      const bh = Math.max(1.2, Math.abs(y(c.close) - y(c.open)));
      svg += `<rect class="${up ? 'up' : 'down'}" x="${(x - step * 0.32).toFixed(1)}" y="${top.toFixed(1)}" width="${(step * 0.64).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
      const vh = 11 * (c.volume / volMax);
      svg += `<rect class="${c.playerVolume > 0 ? 'play' : 'vol'}" x="${(x - step * 0.24).toFixed(1)}" y="${(h - 2 - vh).toFixed(1)}" width="${(step * 0.48).toFixed(1)}" height="${Math.max(1, vh).toFixed(1)}"/>`;
    });
    const last = cs.at(-1);
    svg += `<line class="now" x1="${pad}" y1="${y(last.close).toFixed(1)}" x2="${w - pad}" y2="${y(last.close).toFixed(1)}"/></svg>`;
    return svg;
  }

  function renderMarket(hd, bd) {
    hd.textContent = `📈 股市 · 日 K（近 30 根）`;
    if (st.stockHaltAllDays > 0) bd.appendChild(el('div', 'ac-toast ac-toast--danger', '<span class="ac-toast__ic">🚧</span><div><b>全市场停牌</b>还剩 ' + st.stockHaltAllDays + ' 天，此刻没有对手盘，卖不出去。</div>'));
    for (const s of st.stockMarket.stocks) {
      const halt = st.stockHalts.find((h) => h.stockId === s.id);
      const box = el('div', `hud-stock ${s.lastChangePct > 0 ? 'hud-stock--up' : s.lastChangePct < 0 ? 'hud-stock--down' : ''}`);
      const arrow = s.lastChangePct > 0 ? '▲' : s.lastChangePct < 0 ? '▼' : '＝';
      /* 标的/现价/涨跌固定第一行；停牌与流通量固定第二行 —— 早前混排会各自折行，每行高度不等 */
      const corpTag = s.id.startsWith('corp-') ? '<span class="hud-chip">公司</span>' : '';
      box.innerHTML = `<div class="hud-stock__hd"><b>${esc(s.name)}</b>${corpTag}<span class="p">🔔${money(s.price)}</span>
        <span class="c">${arrow} ${Math.abs(s.lastChangePct).toFixed(1)}%</span></div>
        <div class="hud-stock__meta">
        ${halt ? `<span class="hud-chip hud-chip--warn">${halt.kind === 'up' ? '涨停' : halt.kind === 'down' ? '跌停' : '停牌'} ${halt.daysLeft} 天</span>` : ''}
        <span class="hud-chip">${s.candles.length} 根</span>${s.floatShares > 0
          ? `<span class="hud-chip" title="流通股本 ${money(s.floatShares)} 张，还没被买走的 ${money(s.remainingShares ?? s.floatShares)} 张 —— 可以被买光">可买 ${money(s.remainingShares ?? s.floatShares)}/${money(s.floatShares)}</span>`
          : '<span class="hud-chip hud-chip--warn" title="股票表里这张票的流通量本来就是 0（中國石油）：行情与公司格两条渠道都拿不到它，不是被人买光了">无流通量</span>'}</div>${sparkline(s)}`;
      box.title = `开 ${s.price}｜当日成交含玩家 ${s.candles.at(-1)?.playerVolume ?? 0} 股\n吃单会把价格推离盘口（冲击成本），买得越多均价越高。`;
      bd.appendChild(box);
    }
    for (const p of st.players) {
      const sm = view.stocks.find((x) => x.playerId === p.id);
      if (!sm || (!sm.rows.length && !sm.corpRows.length)) continue;
      const rows = [];
      for (const r of sm.rows) rows.push(`<tr><td>${esc(r.stockName)}</td><td>${r.quantity} 股</td><td>🔔${money(r.marketValue)}</td><td>${r.profit >= 0 ? '▲' : '▼'}${money(Math.abs(r.profit))}</td></tr>`);
      for (const r of sm.corpRows) rows.push(`<tr><td>${esc(r.name)}<br><small>原始股 · 转手按市价</small></td><td>${r.quantity} 张<br><small>锁 ${r.locked} / 卖 ${r.sellable}</small></td><td>🔔${money(r.marketValue)}</td><td>${r.profit >= 0 ? '▲' : '▼'}${money(Math.abs(r.profit))}<br>${r.chairman ? '👑' : ''}${r.holdingPct}%</td></tr>`);
      const t = el('div', '');
      t.innerHTML = `<div class="ac-divider"><span class="ac-divider__mark">${avaOf(p)} ${esc(p.name)}</span></div>
        <div class="hud-tablewrap"><table class="ac-table"><thead><tr><th>标的</th><th>数量</th><th>现值</th><th>盈亏/占比</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
      bd.appendChild(t);
    }
    bd.appendChild(el('div', 'hud-foot', st.companies.length
      ? `上市股只能动用存款 ✈️；本图 ${st.companies.length} 家公司的原始股用现金 🔔 按面值认购、转手按市价卖回存款，认购当回合锁一手。`
      : '上市股只能动用存款 ✈️。这张图没有公司企业，也就没有原始股可认购。'));
  }

  function renderBooks(hd, bd) {
    hd.textContent = `📒 账本 · 资产清单`;
    /* 9 列要塞进 ~300px 的面板栏：表头压成「emoji + 一个字」，全表 nowrap + 外层可横滚兜底。
       早前用完整表头会竖排断成「存/款」「房/屋」两行，且右侧列直接裁掉。 */
    const head = '<tr><th>岛民</th><th title="现金">💰现</th><th title="存款">✈️存</th><th title="土地">🏠土</th>'
      + '<th title="房屋">🏗️房</th><th title="上市股">📈股</th><th title="原始股">🧾原</th>'
      + '<th title="贷款">🏦贷</th><th title="总资产">Σ总</th></tr>';
    const body = view.assets.map((a) => {
      const p = st.players.find((x) => x.id === a.playerId);
      return `<tr title="${esc(a.playerName)}"><td>${avaOf(p)}${a.bankrupt ? '💀' : ''}</td><td>${money(a.cash)}</td><td>${money(a.deposit)}</td>
        <td>${money(a.landValue)}</td><td>${money(a.houseValue)}</td><td>${money(a.stockValue)}</td><td>${money(a.corpValue)}</td>
        <td>${a.loan ? '−' + money(a.loan) : '0'}</td><td><b>${money(a.total)}</b></td></tr>`;
    }).join('');
    const wrap = el('div', 'hud-tablewrap');
    wrap.innerHTML = `<table class="ac-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    bd.appendChild(wrap);
    bd.appendChild(el('div', 'ac-divider', '<span class="ac-divider__mark">🏠 物价指数 ×' + view.priceIndex.toFixed(3) + '（买地/升级/租金都要乘它）</span>'));

    const p = st.players.find((x) => x.id === viewportPid);
    const groups = view.estates[p.id] || [];
    if (!groups.length) {
      bd.appendChild(el('div', 'ac-panel', `<div class="ac-empty"><div class="ac-empty__ic">🌱</div><div class="ac-empty__tt">${esc(p.name)} 还没有地</div>
        <div class="ac-empty__ds">走到无主地产当场买下一块，或去拍卖会捡漏。</div></div>`));
    }
    for (const g of groups) {
      const rows = g.rows.map((r) => `<div class="ac-list__item"><div class="ac-list__ic">${r.facility ? '🏗️' : r.isChain ? '🏪' : '🏠'}</div>
        <div class="ac-list__tx"><b>${esc(r.cellName)}<span class="hud-bg">${esc(r.gradeLabel)} · ${r.grade} 级</span>${r.facility ? `<span class="hud-bg hud-bg--money">${esc(r.facility)}</span>` : ''}</b>
        <small>地皮 ${money(r.landValue)} + 建筑 ${money(r.houseValue)}</small></div>
        <span class="ac-list__val">格 ${r.cellId}</span></div>`).join('');
      bd.appendChild(el('div', '', `<div class="ac-divider"><span class="ac-divider__mark">${esc(g.streetName)} 段 · 🔔${money(g.totalValue)}</span></div><div class="ac-list">${rows}</div>`));
    }
    const corp = st.companies.filter((c) => Object.keys(c.shares).length);
    if (corp.length) {
      const rows = corp.map((c) => {
        const held = Object.entries(c.shares).map(([k, v]) => `${esc(st.players.find((p) => p.id === k)?.name ?? k)} ${v} 张`).join('、');
        return `<tr><td>${esc(c.name || cellName(c.cellId))}<br><small>格 ${companyFootprint(c).join('·')}</small></td><td>🔔${money(c.sharePrice)}</td><td>${money(c.surplus)}</td>
          <td>${c.chairmanId ? '👑' + esc(st.players.find((p) => p.id === c.chairmanId)?.name ?? '') : '空缺'}</td><td>${esc(held)}</td></tr>`;
      }).join('');
      bd.appendChild(el('div', '', `<div class="ac-divider"><span class="ac-divider__mark">🏢 公司经营权（每月 15 号按持股比例分盈余）</span></div>
        <div class="hud-tablewrap"><table class="ac-table"><thead><tr><th>公司</th><th>面值</th><th>累积盈余</th><th>董事长</th><th>持股</th></tr></thead><tbody>${rows}</tbody></table></div>`));
    }
  }

  function cellName(id) { return st.board[id]?.name ?? `格 ${id}`; }
  /** 落点浮字：走路到站 / 被押走（监狱与医院分开说）/ 其余瞬移（传送机那类） */
  function landLabel(id, kind) {
    const name = cellName(id);
    if (kind !== 'transfer') return `来到「${name}」`;
    const type = st.board[id]?.type;
    if (type === 'jail') return `🚔 被押送至「${name}」`;
    if (type === 'hospital') return `🏥 被送往「${name}」`;
    return `✨ 瞬移到「${name}」`;
  }
  const priceAt = (id) => Math.round((st.board[id]?.price ?? 0) * view.priceIndex);

  function logTone(text) {
    if (/阵亡|破产|查封|怪病|住院|在押|罚款|遭|跌|倒霉|霉运|停|流标/.test(text)) return 'danger';
    if (/获得|收到|赚到|涨|分红|中奖|解锁|买下|建成|升为|夺回|保释成功/.test(text)) return 'bell';
    return '';
  }
  function logEmoji(text) {
    if (/^【新闻】/.test(text)) return '📰';
    if (/掷出|来到|路过|进入|经过/.test(text)) return '🎲';
    if (/买下|盖|升级|建设|动工/.test(text)) return '🏠';
    if (/租金|付|收|扣|卖|买|投注/.test(text)) return '🔔';
    if (/神|附身|显灵|驻留/.test(text)) return '✨';
    if (/拍卖|流拍|收锤/.test(text)) return '🔨';
    if (/股票|停牌|涨|跌/.test(text)) return '📈';
    return '🍃';
  }
  let logShown = 60;
  function renderLog(hd, bd) {
    hd.textContent = `📣 播报 · 第 ${st.turn} 回合 · 共 ${st.log.length} 条`;
    const list = el('div', 'ac-list');
    const slice = st.log.slice(-logShown);
    for (const e of slice) {
      const tone = logTone(e.text);
      const row = el('div', 'ac-toast ' + (tone === 'danger' ? 'ac-toast--danger' : tone === 'bell' ? 'ac-toast--bell' : ''));
      row.style.padding = '6px 9px';
      row.innerHTML = `<span class="ac-toast__ic">${logEmoji(e.text)}</span><div><b>${esc(e.text)}</b><small style="opacity:.7;font-weight:800">第 ${e.turn} 回合</small></div>`;
      list.appendChild(row);
    }
    bd.appendChild(list);
    if (st.log.length > logShown) {
      const more = el('button', 'ac-btn ac-btn--cream ac-btn--sm', `再看 ${Math.min(60, st.log.length - logShown)} 条`);
      more.onclick = () => { logShown += 60; render(); };
      bd.appendChild(more);
    }
  }

  function renderBoardListing(hd, bd) {
    hd.textContent = `📋 公布栏 · 公开挂牌`;
    const open = st.trades.filter((t) => !t.closed);
    if (!open.length) bd.appendChild(el('div', 'ac-empty', '<div class="ac-empty__ic">📭</div><div class="ac-empty__tt">此刻没人挂东西</div><div class="ac-empty__ds">土地 / 股票 / 卡片 / 道具都能挂，成交才扣款。</div>'));
    for (const t of open) {
      const row = el('div', 'ac-list__item');
      row.innerHTML = `<div class="ac-list__ic">${t.kind === 'land' ? '🏠' : t.kind === 'stock' ? '📈' : t.kind === 'card' ? '🃏' : '🧰'}</div>
        <div class="ac-list__tx"><b>${esc(t.targetId)}</b><small>${esc(st.players.find((p) => p.id === t.sellerId)?.name ?? t.sellerId)} · 第 ${t.postedTurn} 回合挂出</small></div>
        <span class="ac-list__val">🔔${money(t.price)}</span>`;
      bd.appendChild(el('div', 'ac-list', '')).appendChild(row);
    }
    const mine = A.tradableAssets;
    bd.appendChild(el('div', 'ac-divider', '<span class="ac-divider__mark">✋ 我可以挂出去的（' + mine.length + ' 项，建议价为引擎同源数）</span>'));
    const list = el('div', 'ac-list');
    for (const t of mine) {
      const row = el('div', 'ac-list__item hud-tip');
      row.dataset.tip = `${t.kind} · ${t.targetId}`;
      row.innerHTML = `<div class="ac-list__ic">${t.kind === 'land' ? '🏠' : t.kind === 'stock' ? '📈' : t.kind === 'card' ? '🃏' : '🧰'}</div>
        <div class="ac-list__tx"><b>${esc(t.label)}</b><small>建议价 🔔${money(t.suggestPrice)}</small></div>
        <span class="ac-list__val"><button class="ac-btn ac-btn--sm ac-btn--cream" data-post="${esc(t.label)}">挂出</button></span>`;
      list.appendChild(row);
    }
    bd.appendChild(list);
    bd.querySelectorAll('[data-post]').forEach((b) => b.onclick = () => fire({ __open: 'trade' }, `挂出「${b.dataset.post}」`));
  }

  /* ---------------- Dock：选中格 · 行囊 · 动作（主操作唯一，次操作与灰态折进弹层） ---------------- */
  /* 每行第 5 项是「点下去干什么」：
   *   { type:'...' }  → 交给宿主 dispatch 的真实 PlayerAction
   *   { __open:'x' }  → 宿主打开对应面板（需要选目标 / 填金额的动作）
   * 门控（第 2 项）仍与引擎 availableActions 同源。 */
  /* 魔法屋标语一律取 view.names.magicConditions（shared 是唯一出处）。
     本文件不参与 typecheck，规则文案一旦在这里各写各的，改模型时编译器一声都不会响。 */
  function magicLabel(cond) {
    return (view.names.magicConditions || {})[cond] || cond || '';
  }

  function actionSpec() {
    /* 股市入口的门控口径：自己回合 + 未破产就能打开。
       面板里是 17 支行情（6 支虚拟股 + 11 家公司挂进来的 `corp-*`，CORP-14），另有那张
       「原始股权益」表 —— 认购只能在地图上踩到公司格时发生（见下面的 🧾 按钮），
       拿 canTradeStock 当门户会让玩家在例假日彻底打不开面板、连转手都做不了。
       市场状态只用来决定面板内行情行的可用性。 */
    const stockOpenable = A.canTradeStock || !!view.canOpenStock;
    const stockWhy = A.canTradeStock
      ? '上市股只花存款'
      : st.stockHaltAllDays > 0
        ? `全市场停牌还剩 ${st.stockHaltAllDays} 天：上市股不能动，原始股照常认购`
        : view.date.isHoliday
          ? '例假日休市：上市股不能动，原始股照常认购'
          : '只有自己回合（掷骰前那一段）能开股市';
    return [
      ['🎲 掷骰', A.canRoll, 'ac-btn--green', '只有「等待掷骰」阶段能按，且必须有行动权', { type: 'ROLL_DICE' }],
      [`💰 买下「${cellName(cur.position)}」`, A.canBuy, 'ac-btn--green', '脚下是无主地产、现金够、且没在梦游（价格见左侧格块）', { type: 'BUY_LAND' }],
      ['🏗️ 加盖一层', A.canUpgrade, 'ac-btn--green', '脚下是自己的地，未达 5 级', { type: 'UPGRADE_LAND' }],
      ...A.buildableFacilities.map((f) => [`🏗️ 建「${view.names.facilities[f]?.name ?? f}」`, true, 'ac-btn--blue', '商业用地上可选的设施', { type: 'BUILD_FACILITY', facility: f }]),
      ...(A.canBuyShares ? [[`🧾 认购原始股 🔔${money(A.sharePrice)} ×${A.shareQuantityLimit}`, true, 'ac-btn--orange', '只有踩到公司格才开这个窗口：现金按面值，当回合锁定不能卖；转手在股市面板按市价、入存款', { type: 'BUY_SHARES', cellId: cur.position, quantity: A.shareQuantityLimit }]] : []),
      ['🏦 存款 / 取款', A.canDeposit || A.canWithdraw, 'ac-btn--blue', '月末计息，取出来才能付现钱', { __open: 'bank' }],
      ['💳 贷款 / 还款', A.canLoan || A.canRepayLoan, 'ac-btn--blue', '额度上限＝开局资金，3 个月到期必须还清', { __open: 'bank' }],
      ['🛍️ 进商店', A.canShop, 'ac-btn--blue', '脚下是商店格', { __open: 'shop' }],
      ['📈 开股市', stockOpenable, 'ac-btn--blue', stockWhy, { __open: 'stock' }],
      ['🎰 买乐透', A.canBuyLottery, 'ac-btn--orange', `一注 🔔${money(A.lotteryTicketCost)}，每月 15 号开奖`, { __open: 'lottery' }],
      ...A.bailableVillains.map((k) => [`🚔 保释${NPC_CN[k] ?? k} 🥬${A.bailFee}`, true, 'ac-btn--orange', '收编恶人，它去偷别人的钱，你抽成', { type: 'BAIL_PRISONER', npcKind: k }]),
      ...A.dischargeablePatients.map((id) => [`🏥 让 ${esc(st.players.find((p) => p.id === id)?.name ?? id)} 出院 🔔${money(A.dischargeFee)}`, true, 'ac-btn--orange', '替他垫钱，攒个人情', { type: 'DISCHARGE_PATIENT', targetPlayerId: id }]),
      ...(A.magic ? [[`🔮 施法（${esc(magicLabel(A.magic.condition))}）`, true, 'ac-btn--orange', '水晶球只报标语：谁对得上要自己判断，符合条件的人一个都跑不掉；落到谁头上由你选魔法决定', { __open: 'magic' }]] : []),
      ...(A.estateBuildCells.length ? [[`🏢 房地产公司加盖（${A.estateBuildCells.length} 处可选）`, true, 'ac-btn--orange', '董事长特权，施工费＝该地地价 ×50%', { __open: 'company' }]] : []),
      ...(A.canFinancing ? [[`💳 特别融资（剩 🔔${money(A.financingRemaining)}）`, true, 'ac-btn--orange', '企业银行董事长专属，期间存款不计息', { __open: 'company' }]] : []),
      ['🚩 认输投降', A.canSurrender, 'ac-btn--cream', '干净退出，但必须指定一人被死神附身 13 天', { __open: 'surrender' }],
    ];
  }

  /* R4：玩家手上没有常驻的「结束回合」。落格窗只给一个**情境出口**：
     - 会话型场所（商店 / 银行）⇒「离开商店 / 办完离开」，里面的动作可以反复办；
     - 单步格 ⇒ 一句「不…」的 decline（不买这块地 / 不加盖 / 不施法…），
       按下去 dispatch 的就是 `FINISH_LANDING` —— 什么都不做也要能把这一格交出去。
     标题取自窗口里此刻真正可办的那件事，所以不会出现「不保释」配着一个保释面板这种错位。 */
  function landingExit() {
    if (!A.canFinishLanding) return null;
    const venue = A.landing ? A.landing.venue : null;
    if (venue === 'shop') return ['🚪 离开商店', '买完再走：离开那一刻才把行动权交给下一个人'];
    if (venue === 'bank') return ['🚪 办完离开', '存取款与贷款可以接着办：离开那一刻才结束回合'];
    const label =
      A.canBuy ? '✋ 不买这块地'
        : A.canUpgrade ? '✋ 不加盖'
          : A.buildableFacilities.length ? '✋ 暂不建设'
            : A.researchableItems.length ? '✋ 暂不研发'
              : A.canBuyShares ? '✋ 不认购原始股'
                : A.bailableVillains.length ? '✋ 不保释'
                  : A.dischargeablePatients.length ? '✋ 不办理出院'
                    : A.canBuyLottery ? '✋ 不买乐透'
                      : A.magic ? '✋ 不施法'
                        : '✋ 这一格不做处理';
    return [label, '事件处理完就自动结束回合 —— 这一格没有别的事要办'];
  }

  /* 相机状态条：横向铺满 dock 顶部，把「镜头在干什么」与「现在能不能点」分开写清楚 */
  function renderCamBar() {
    const cam = el('div', 'hud-cambar');
    if (flatMode || !HAS_GL) {
      /* 方环兜底形态下没有相机：不摆一个假的「跟随 xx」，直接说清楚 */
      cam.innerHTML = `<span class="hud-camtag hud-camtag--hint">方环示意下没有相机系统</span>`;
      return cam;
    }
    cam.innerHTML =
      `<span class="hud-camtag hud-camtag--lock" data-cam-lock role="status" aria-live="polite" ${HUD_LOCKED ? '' : 'hidden'}>🔒 镜头聚焦中 · 操作已屏蔽</span>` +
      `<span class="hud-camtag">🎥 镜头跟随 <b data-cam-target>${esc(st.players.find((p) => p.id === activePid)?.name ?? activePid)}</b></span>` +
      `<span class="hud-camtag hud-camtag--hint">轮到谁操作，镜头就交给谁</span>`;
    return cam;
  }

  /**
   * 停留态（在押 / 住院 / 出国 / 其他停留）给 dock 换上的那句话：不给按钮，只说清「回合会自己走」。
   * 引擎那一侧同一条判据是 `stayRefusal`，这里只是把它翻成玩家看得见的一句话。
   */
  function stayChip() {
    if (!cur || cur.skipTurns <= 0) return null;
    const where = cur.custody
      ? (cur.custody.kind === 'jail' ? '🚔 在押' : '🏥 住院')
      : cur.abroadTurns > 0 ? '✈️ 出国' : '⏸️ 停留';
    return `${where}中 · 无法操作，回合自动跳过（剩 ${cur.skipTurns} 回合）`;
  }

  function renderDock() {
    const bar = el('footer', 'hud-dock');
    bar.appendChild(renderCamBar());
    bar.append(tileBlock(), renderBag());

    const spec = actionSpec();
    const stay = stayChip();
    const first = (re) => spec.find((row) => row[1] && re.test(row[0]));
    const primary = stay ? null : (first(/掷骰/) || first(/买下/) || first(/加盖一层/) || null);
    const exit = landingExit();
    const acts = el('div', 'hud-act');

    const more = el('div', 'hud-act__more');
    const secondary = spec.filter((row) => row !== primary && row[1]);

    if (secondary.length) {
      const btn = el('button', 'ac-btn ac-btn--cream', `⚙️ 更多动作 ${secondary.length}`);
      btn.setAttribute('aria-expanded', 'false');
      const pop = el('div', 'hud-pop');
      pop.innerHTML = `<div class="hud-pop__t">此刻可做的次操作（共 ${secondary.length}）</div>`;
      const grid = el('div', 'hud-pop__grid');
      for (const [label, , variant, why, act] of secondary) {
        const b = el('button', `ac-btn ${variant}`, label);
        if (why) b.title = why;      // 门控原因挂成悬浮说明，不再单开一个「被挡住」弹层
        b.onclick = () => fire(act, label);
        grid.appendChild(b);
      }
      pop.appendChild(grid);
      btn.onclick = () => togglePop(pop, btn);
      more.append(btn, pop);
    }

    if (stay) {
      // 联机时这条不是「你的」状态，点名才看得出是谁在牢里替谁跳过这一手
      const who = hostApi.interactive === false ? `${esc(cur.name)} ` : '';
      acts.append(more, el('span', 'hud-chip hud-chip--warn', `${who}${stay}`));
    } else if (primary) {
      const b = el('button', `ac-btn ${primary[2]} ac-btn--lg`, primary[0]);
      b.dataset.primary = '1';
      b.title = '回车键 = ' + primary[0];
      b.onclick = () => fire(primary[4], primary[0]);
      acts.append(more, b);
    } else if (hostApi.interactive === false) {
      acts.append(more, el('span', 'hud-chip hud-chip--off', '等待对方操作'));
    } else if (!secondary.length) {
      // 只有「真的什么都没有」才说这句：会话窗（银行 / 商店）没有主 CTA，
      // 但次操作与出口都在 —— 旧写法会在开着「办完离开」的同时写「此刻没有可执行的操作」
      acts.append(more, el('span', 'hud-chip hud-chip--off', '此刻没有可执行的操作'));
    } else {
      acts.appendChild(more);
    }
    /* 落格窗的那个出口：不是 CTA（它是「不做」），所以奶油色、排在主操作之后 */
    if (exit) {
      const e = el('button', 'ac-btn ac-btn--cream', exit[0]);
      e.title = exit[1];
      e.onclick = () => fire({ type: 'FINISH_LANDING' }, exit[0]);
      acts.appendChild(e);
    }
    bar.appendChild(acts);
    return bar;
  }

  function togglePop(pop, btn) {
    const open = pop.classList.toggle('hud-pop--open');
    btn.setAttribute('aria-expanded', String(open));
    document.querySelectorAll('.hud-pop--open').forEach((p) => { if (p !== pop) p.classList.remove('hud-pop--open'); });
  }

  /**
   * 行囊条（W-quick 第一行）：这一条**本身就是手牌清单**，不再另开模态面板。
   *
   * 每格带身份（`item:<id>` / `card:<id>:<下标>`）：宿主的手牌动作条要靠它把「展开的是哪一格」
   * 标回来（选中态），也要靠同一个 key 知道选格请求归谁。卡片名直接印在格子上 ——
   * 清单一旦去掉，🃏 这种「要 hover 才知道是什么」的图标就断了信息链。
   */
  function renderBag() {
    const bag = el('div', 'hud-bag');
    const usable = new Set(A.usableItems);
    const entries = Object.entries(me.items);
    const total = entries.reduce((n, [, q]) => n + q, 0);
    bag.innerHTML = `<div class="hud-bag__hd" title="卡片 ${me.cards.length}/15 · 道具 ${total}（每种上限 9）">🎒 ${esc(me.name)} 的行囊<span>卡片 ${me.cards.length}/15 · 道具 ${total}</span>
      ${me.research ? `<span class="hud-chip hud-chip--money">🔬 研发中：${esc(view.names.items[me.research.itemId]?.name ?? me.research.itemId)} · 剩 ${me.research.remainDays} 天</span>` : ''}</div>`;
    const row = el('div', 'hud-bag__row');
    if (!entries.length && !me.cards.length) {
      row.appendChild(el('span', 'hud-chip hud-chip--off', '空空如也：走到点券格/宝箱攒点券，去商店换卡片道具'));
    }
    for (const [id, qty] of entries) {
      const name = view.names.items[id]?.name ?? id;
      const cell = bagCell(`item:${id}`, ITEM_EMOJI[id] || '🧰', name, usable.has(id), 'ac-invgrid__cell--rare',
        view.names.items[id]?.desc ?? '', qty);
      // 不可用也展开：动作条会引引擎那句原话说明「为什么此刻不行」，
      // 落回 cosmetic() 只会蹦出「（原型）…」这种给旧演示用的话。
      cell.onclick = () => fire({ __open: 'hand', entry: { kind: 'item', id, i: 0 } }, `使用道具「${name}」`);
      row.appendChild(cell);
    }
    me.cards.forEach((cid, i) => {
      const can = A.usableCards.includes(cid);
      const name = view.names.cards[cid]?.name ?? cid;
      const cell = bagCell(`card:${cid}:${i}`, '🃏', name, can, 'ac-invgrid__cell--diy', view.names.cards[cid]?.desc ?? '', 1);
      cell.onclick = () => fire({ __open: 'hand', entry: { kind: 'card', id: cid, i } }, `使用卡片「${name}」`);
      row.appendChild(cell);
    });
    bag.appendChild(row);
    return bag;
  }

  function bagCell(key, emoji, name, usable, kindClass, desc, qty) {
    const cell = el('button', `ac-invgrid__cell ${kindClass} ${usable ? 'ac-invgrid__cell--ok' : 'ac-invgrid__cell--off'}${bagFocusKey === key ? ' ac-invgrid__cell--on' : ''}`);
    cell.dataset.key = key;
    cell.innerHTML = `<span class="ac-invgrid__face">${emoji}${qty > 1 ? `<span class="ac-invgrid__qty">${qty}</span>` : ''}</span>`
      + `<span class="ac-invgrid__cap">${esc(name)}</span>`;
    cell.setAttribute('aria-label', `${name}，${usable ? '此刻可用' : '此刻不可用'}`);
    cell.title = desc ? `${name}：${desc}` : name;
    return cell;
  }

  /* 真实动作出口：宿主注入了 dispatch 就走引擎，否则退回旧的「只做表现」。 */
  function fire(x, label) {
    if (HUD_LOCKED) { toast('🎥 镜头正在聚焦，等视角停稳再操作', 'bell'); return; }
    if (hostApi.interactive === false) { toast('还没轮到你行动', 'bell'); return; }
    if (x && typeof x === 'object') {
      if (x.__open) { if (typeof hostApi.openPanel === 'function') { hostApi.openPanel(x.__open, x); return; } }
      else if (typeof hostApi.dispatch === 'function') { hostApi.dispatch(x); return; }
    }
    cosmetic(label || '');
  }

  /* 只做表现：买地上色 + 吐司，其余按钮给一句解释。规则仍归引擎。 */
  function cosmetic(label) {
    /* 兜底：正常路径已被 shell 的捕获拦截挡住，这里防止从控制台/其它入口绕进来 */
    if (HUD_LOCKED) { toast('🎥 镜头正在聚焦，等视角停稳再操作', 'bell'); return; }
    if (/买下/.test(label)) {
      const cell = st.board[cur.position];
      view.owners[cell.id] = me.id;
      const mine = view.assets.find((a) => a.playerId === me.id);
      if (mine) mine.landValue += cell.price ?? 0;
      if (!flatMode && HAS_GL) {
        globalThis.D25World.paintOwners();
        globalThis.D25Overlay.float(`买下「${cell.name}」🔔${money(priceAt(cell.id))}`, cell.id, 'gold');
      }
      toast(`（原型）买下「${cell.name}」，地价 🔔${money(priceAt(cell.id))} —— 真实扣款与归属由引擎判定`, 'bell');
      render();
      return;
    }
    if (/离开|不做处理|不认购|不买|不加盖|不施法|不保释|不办理出院|暂不/.test(label)) { toast('（原型）走出落格窗要发 FINISH_LANDING 给引擎，这里不跑规则。想看不同视角点右侧岛民。'); return; }
    toast(`（原型）「${label}」只演示按钮的态与反馈，不落规则。`);
  }

  function toast(text, tone) {
    let host = document.querySelector('.hud-toasts');
    if (!host) {
      host = el('div', 'hud-toasts');
      host.setAttribute('aria-live', 'polite');
      host.setAttribute('role', 'status');
      document.body.appendChild(host);
    }
    const t = el('div', 'ac-toast' + (tone ? ` ac-toast--${tone}` : ''));
    t.innerHTML = `<span class="ac-toast__ic">${tone === 'danger' ? '🙅' : tone === 'bell' ? '🔔' : '🍃'}</span><div><b>${esc(text)}</b></div>`;
    host.appendChild(t);
    toasts.push(t);
    while (toasts.length > 3) toasts.shift().remove();
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 5200);
  }

  function switchTab(name) { activeTab = name; render(); }

  /* ---------------- 装配 ---------------- */
  function render() {
    const root = document.getElementById(AC_ROOT_ID);
    if (!root) return;          // 宿主容器已卸载（React 卸载中），静默跳过
    const shell = el('div', 'hud-shell');
    shell.appendChild(renderTop());
    shell.appendChild(renderStatus());
    shell.appendChild(ensureTicker());   // 字幕条节点常驻，重铺整壳时只是换个爹
    shell.appendChild(renderBoard());

    const side = el('aside', 'hud-side');
    const tabs = el('div', 'ac-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '对局信息页签');
    for (const t of TABS) {
      const tab = el('button', 'ac-tabs__tab' + (t === activeTab ? ' ac-tabs__tab--active' : ''), t);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(t === activeTab));
      tab.tabIndex = t === activeTab ? 0 : -1;
      tab.onclick = () => switchTab(t);
      tabs.appendChild(tab);
    }
    tabs.onkeydown = (e) => {
      if (HUD_LOCKED) return;
      const i = TABS.indexOf(activeTab);
      const n = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!n) return;
      e.preventDefault();
      const next = TABS[(i + n + TABS.length) % TABS.length];
      switchTab(next);
      shell.querySelector('.ac-tabs__tab--active').focus();
    };
    side.append(tabs, tabPanel());
    shell.appendChild(side);

    shell.appendChild(renderDock());
    root.replaceChildren(shell);
    // 字幕增量排在换爹之后取：`clientWidth` 要量的是这一份快照里的真实宽度
    pumpTicker();

    /* 输入闸门：捕获阶段拦掉整壳的点击。放在捕获阶段是为了连「键盘回车 → primary.click()」
     * 与 ac-btn 自己的 onclick 都拦得住 —— 只靠 cosmetic() 里判断会漏掉 tab / 挂出 / 商店这些旁路。
     * 唯一放行的是巡演按钮：它是用来驱动镜头的，被自己锁死就没法验收了。 */
    shell.addEventListener('click', (e) => {
      if (!HUD_LOCKED) return;
      const t = e.target instanceof Element ? e.target.closest('button, [role="button"], a') : null;
      if (t && t.hasAttribute('data-cam-mode')) return;   // 镜头开关是「调相机」用的，锁定期间也放行
      e.preventDefault();
      e.stopPropagation();
      if (t) toast('🎥 镜头正在聚焦，等视角停稳再操作', 'bell');
    }, true);

    applyCamLockUI();     // shell 是新造的，锁定态得重新刷上去
    applyCamModeUI();     // 同理：小地图显隐、切换按钮文案、预设置灰
    /* 非我方回合（联机时别人在操作）：dock 的动作整体置灰 —— 门控位仍读己方快照，
       不置灰的话会看着像「我能点」，点下去被服务端拒绝才是真正的坑 */
    if (hostApi.interactive === false) {
      shell.classList.add('hud-shell--waiting');
      shell.querySelectorAll('.hud-dock .ac-btn, .hud-flatbar .ac-btn').forEach((n) => {
        if (!n.hasAttribute('data-cam-mode')) n.disabled = true;
      });
    }
    syncStage();
  }

  /* 键盘：回车＝主操作，Esc＝关弹层（不抢系统快捷键） */
  document.addEventListener('keydown', (e) => {
    /* 宿主弹层（股市 / 银行 / 商店…）开着时不抢键盘：
       否则弹层里点完「买 10 张」顺手一个回车，会隔着遮罩把骰子掷了。
       Esc 也让给宿主 —— 由它决定这个弹层能不能关（强制流程弹层不给关）。 */
    if (hostApi.modalOpen) return;
    if (e.target instanceof Element && e.target.matches('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape') {
      document.querySelectorAll('.hud-pop--open').forEach((p) => p.classList.remove('hud-pop--open'));
      if (tipEl) tipEl.style.opacity = '0';
      return;
    }
    if (e.key === 'Enter' && !e.repeat) {
      const p = document.querySelector('[data-primary]');
      if (p && document.activeElement !== p) { e.preventDefault(); p.click(); }
    }
  });

  globalThis.AC_HUD = {
    /** 宿主推进/换局后调用：重新绑定派生量（RING / me / cur 随 state 变）并整壳重绘 */
    update(snap) {
      bindSnap(snap);
      /* 热座下「我」就是当前行动者：表现层视角跟着回合走（联机时锁在自己身上，不动用户手选） */
      if (hostApi.followCurrent) viewportPid = view.myPlayerId;
      else if (!st.players.some((p) => p.id === viewportPid)) viewportPid = view.myPlayerId;
      if (selCell == null || selCell >= st.board.length) selCell = cur.position;
      render();
      /* 注意：这里**不能**顺手把 activePid / lastTurnPid 归位 —— 换回合自动聚焦靠的正是
       * syncStage() 里「回合指针变了」这条判据，提前对齐等于把那次聚焦吞掉。 */
      /* 贴面上的地价随物价指数变，重挂一次贴图（仅换局/推进时，不在每次 render 里做） */
      if (!flatMode && HAS_GL && globalThis.D25World && globalThis.D25World.redrawLabels) {
        globalThis.D25World.redrawLabels();
        globalThis.D25World.renderOnce();
      }
    },
    /**
     * 移动演出是否已经落定（棋子逐格跳完、骰子停手）。
     * 宿主用它决定**什么时候把落格面板弹出来** —— 引擎把「掷骰 → 走 n 步 → 落格」压成
     * 一个原子动作，快照到达时棋子还在路上；这时糊一层面板，玩家看到的是上一格的镜头
     * 配下一格的决定。方环示意 / 没有 WebGL 时恒为「已落定」。
     */
    isSettled: () => !(globalThis.D25World && globalThis.D25World.isHopping && globalThis.D25World.isHopping()),
    /**
     * 进入 / 退出「在棋盘上点一格」模式（W2）。传 null 退出。
     *
     * `t.cells` 是引擎给的合法候选，本波只用来切手型光标与记账 —— 真正判合法性的是
     * 派单时的那一个谓词，所以这里就算拿到空集合也不拦点击（玩家点错要知道为什么，
     * 而不是「什么都点不动」）。淡出与高亮在 W3 接。
     */
    setPickTargets(t) {
      pickCells = t && Array.isArray(t.cells) ? t.cells : null;
      pickReasons = new Map(((t && t.rejected) || []).map((r) => [r.id, r.reason]));
      pickPlayers = t && Array.isArray(t.players) ? t.players : [];
      pickPlayerReasons = new Map(((t && t.playerRejected) || []).map((r) => [r.id, r.reason]));
      if (stage) stage.classList.toggle('d25-stage--pick', picking());
      /* 绿环与压暗交给世界层画（它才有格子 mesh）；方环兜底模式下没有 D25World，跳过视觉、通路仍通 */
      globalThis.D25World?.setPickHighlight?.(pickCells ?? []);
      globalThis.D25World?.setPickPlayers?.(pickPlayers);
    },
    /** 注入宿主能力：{ dispatch(action), openPanel(kind, payload) } */
    setHost(h) { hostApi = Object.assign(hostApi, h || {}); },
    /**
     * 行囊格里哪一格正展开着动作条（传 null 全收）。
     *
     * 只改样式、不判合法性；每次快照重铺壳时 `renderBag()` 会读同一个 `bagFocusKey`，
     * 所以宿主不必在每帧重报。
     */
    setBagFocus(key) {
      bagFocusKey = key || null;
      document.querySelectorAll('.ac-invgrid__cell[data-key]').forEach((c) => {
        const on = c.dataset.key === bagFocusKey;
        c.classList.toggle('ac-invgrid__cell--on', on);
        c.setAttribute('aria-expanded', String(on));
      });
    },
    toast,
    /** 卸载：停掉 WebGL / Pixi、清掉浮层。脚本本身留在内存，再次 update 即可重新挂载。 */
    destroy() {
      if (stage) {
        if (globalThis.D25Overlay) globalThis.D25Overlay.dispose();
        if (globalThis.D25World) globalThis.D25World.dispose();
        stage = null;
      }
      camFocused = false;
      lastPos = null;      // 重新挂载的第一帧不演动画：那之前的脚下格属于上一副棋盘
      spunDice = null;
      pendingTurnPid = null;
      if (tipEl) { tipEl.remove(); tipEl = null; }
      document.querySelectorAll('.hud-toasts').forEach((n) => n.remove());
      toasts.length = 0;
      const root = document.getElementById(AC_ROOT_ID);
      if (root) root.replaceChildren();
    },
  };
  render();
})();
