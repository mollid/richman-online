/* 大富翁 Online · 动物森林 HUD 原型（纯表现层）
 * 数据来源：snapshot.js（由 tools/dump-snapshot.mts 从真实引擎导出的第 N 回合状态 + 派生视图）。
 * 本文件不含任何规则：动作位、金额、门控一律读快照；点击只做表现（吐司/上色/切视角）。 */
(() => {
  'use strict';
  const S = globalThis.GAME_SNAPSHOT;
  if (!S) { document.body.textContent = '缺少 snapshot.js，请先跑 tools/dump-snapshot.mts。'; return; }
  const st = S.state, view = S.view, A = view.actions;
  const money = (n) => Math.round(n).toLocaleString('zh-CN');
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const css = (color) => `#${color.toString(16).padStart(6, '0')}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const AVA = { 'bot-1': '🐸', 'bot-2': '🐬', 'bot-3': '🐻', 'bot-4': '🐷' };
  const GROUP = {
    residential: '#8fd07a', commercial: '#7ec8ef', industrial: '#c9b48a',
    tech: '#b7a6e6', coastal: '#7fd8c8', financial: '#f0b96a',
  };
  const CELL = {
    start: ['🏁', '起点 · 经过领薪水'], property: ['🏠', '住宅用地'], commercial: ['🏬', '商业用地'],
    chance: ['🎋', '机会格'], news: ['📰', '新闻格'], 'free-card': ['🃏', '免费卡片格'],
    points: ['🎟️', '点券格'], lottery: ['🎰', '乐透行'], magic: ['🔮', '魔法屋'],
    treasure: ['🎁', '宝箱'], tax: ['💼', '缴税格'], hospital: ['🏥', '医院'], jail: ['🚔', '监狱'],
    game: ['🎮', '游戏厅'], shop: ['🛍️', '商店'], bank: ['🏦', '银行'], god: ['⛩️', '神庙'], company: ['🏢', '公司企业'],
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

  /* 64 格 = 17×17 网格外圈（4×17−4）。四角落在格号 0 / 16 / 32 / 48，顺时针。 */
  const RING = st.board.map((cell, i) => {
    const L = 17;
    if (i < L - 1) return { cell, col: i + 1, row: 1, edge: 'top' };
    if (i < 2 * (L - 1)) return { cell, col: L, row: i - (L - 2), edge: 'right' };
    if (i < 3 * (L - 1)) return { cell, col: L - (i - 2 * (L - 1)), row: L, edge: 'bottom' };
    return { cell, col: 1, row: L - (i - 3 * (L - 1)), edge: 'left' };
  });

  const me = st.players.find((p) => p.id === view.myPlayerId);
  const cur = st.players[st.currentPlayerIndex];
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
    box.innerHTML = `
      <div class="ac-hud__ava">${AVA[p.id] || '🧑‍🌾'}</div>
      <div class="ac-hud__who">
        <b>${esc(p.name)}</b>
        <small>${st.turn > 0 ? `第 ${st.turn} 回合 · 第 ${st.round} 圈` : '等待开局'} ·
          ${view.date.month}/${view.date.day} ${view.date.weekdayLabel}${view.date.isHoliday ? '（例假日·股市休市）' : ''} ·
          岛历第 ${view.date.dayIndex + 1} 天${st.maxDays ? ` / ${st.maxDays}` : ''}</small>
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
      <span class="hud-proto">原型 · 无规则</span>`;
    box.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
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

  /* ---------------- 棋盘：默认 2.5D（three.js 世界 + Pixi 叠加），?board=flat 回方环 ---------------- */
  const FLAT0 = /board=flat/.test(location.search) || /board=flat/.test(location.hash);
  let flatMode = FLAT0;
  const HAS_GL = !!globalThis.THREE && !!globalThis.PIXI && !!globalThis.D25World && !!globalThis.D25Overlay;
  let stage = null, tipEl = null, camChip = null, selCell = cur.position;

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
    document.querySelectorAll('.hud-dock .ac-btn, .hud-flatbar .ac-btn, .hud-bswitch, .d25-bar .ac-btn')
      .forEach((n) => {
        if (n.hasAttribute('data-cam-demo')) return;                 // 巡演按钮：驱动镜头用的，永远放行
        /* 视角预设还要额外看模式：近景等距下它们本就无效，解锁后也不能变回可用 */
        n.disabled = HUD_LOCKED || (n.hasAttribute('data-view') && isoMode());
      });
  }

  function camLock(v) {
    const nv = !!v;
    const changed = nv !== HUD_LOCKED;
    HUD_LOCKED = nv;
    /* 锁上的瞬间把已展开的弹层收起 —— 否则弹出层会浮在灰壳上，看着仍可点 */
    if (changed && nv) document.querySelectorAll('.hud-pop--open').forEach((p) => p.classList.remove('hud-pop--open'));
    applyCamLockUI();
  }

  /** 让相机聚焦到某位玩家（未启用 3D 时是空操作） */
  function scheduleFocus(pid, opts) {
    activePid = pid;
    const p = st.players.find((x) => x.id === pid);
    document.querySelectorAll('[data-cam-target]').forEach((n) => { n.textContent = p ? p.name : pid; });
    if (!flatMode && HAS_GL && globalThis.D25World) globalThis.D25World.focusPlayer(pid, opts);
  }

  /** 镜头巡演：按环序把镜头交给下一位玩家，用于验收「聚焦 → 跟随 → 解锁」全流程 */
  function camTour(step) {
    if (flatMode || !HAS_GL) { toast('方环示意下没有相机，切回 2.5D 再试。'); return; }
    const n = st.players.length;
    const i = st.players.findIndex((p) => p.id === activePid);
    const next = st.players[(((i < 0 ? -1 : i) + (step || 1)) % n + n) % n];
    /* 显式给机位：巡演要验收的是「拉近 → 跟随 → 解锁」，只传 pid 的话俯视模式下机位不动，
       画面上只剩注视点平移，看着跟坏了没区别。focusView() 按当前模式返回该模式的聚焦机位。 */
    const mv = globalThis.D25World.focusView ? globalThis.D25World.focusView() : null;
    scheduleFocus(next.id, mv || undefined);
    toast(`🎥 镜头交给「${next.name}」：先平滑拉近，视角停稳后才放开操作`, 'leaf');
  }
  globalThis.__camTour = camTour;   // 自检钩子

  /**
   * 自检钩子：把回合指针挪到第 i 位，走「换人 → 自动聚焦」这条真实路径。
   * 刻意不做成界面按钮 —— 快照里的 view.actions 不会跟着重算，动作位仍是基准回合的，
   * 做成按钮会让人以为原型能推进回合（README 第一条就是「不跑规则」）。
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
    if (b) b.textContent = iso ? '🗺 回到全盘' : '🔍 近景等距';
    /* 4 个视角预设是「战略俯视」的机位，近景里没有意义 —— 置灰并写明原因，
       而不是留着让人点了发现视野怪怪的。 */
    document.querySelectorAll('.d25-bar [data-view]').forEach((n) => {
      n.disabled = iso || HUD_LOCKED;
      n.title = iso ? '近景等距下不可用 —— 先「回到全盘」' : '';
    });
    document.querySelectorAll('[data-minimap]').forEach((n) => { n.hidden = !iso; });
  }

  /* ---------------- 小地图 ----------------
   * 64 格环 + 持有者着色 + 四名玩家圆点 + 近景取景框。画在一块 2 倍图 canvas 上。
   * 只在近景显示：全盘俯视时它纯属占地方。
   */
  const MINI = { cell: 6, pad: 7, scale: 2 };
  function drawMinimap() {
    const cv = document.querySelector('[data-minimap]');
    if (!cv || cv.hidden) return;
    const ctx = cv.getContext('2d');
    const d = MINI.cell * 17 + MINI.pad * 2;
    if (cv.width !== d * MINI.scale) { cv.width = d * MINI.scale; cv.height = d * MINI.scale; }
    ctx.setTransform(MINI.scale, 0, 0, MINI.scale, 0, 0);
    ctx.clearRect(0, 0, d, d);
    const at = (col, row) => [MINI.pad + (col - 1) * MINI.cell + MINI.cell / 2, MINI.pad + (row - 1) * MINI.cell + MINI.cell / 2];
    /* 底盘 */
    ctx.fillStyle = 'rgba(255,251,239,.9)';
    ctx.strokeStyle = 'rgba(122,101,71,.75)';
    ctx.lineWidth = 2;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(1, 1, d - 2, d - 2, 8); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(1, 1, d - 2, d - 2); ctx.strokeRect(1, 1, d - 2, d - 2); }
    /* 格环 */
    for (const cell of st.board) {
      const r = RING[cell.id];
      const [cx, cy] = at(r.col, r.row);
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
    /* 近景取景框：正交相机在地面上的可视范围 ≈ 宽 × (高/cos el)，再按方位角转一下。
       画出来比任何文字都直观 —— 一眼看出「现在只看得到这一段」。 */
    const cs = globalThis.D25World.cameraState();
    if (isoMode()) {
      /* 世界单位 → 小地图像素：SPACING=2，一格 = MINI.cell 像素，所以 1 单位 = cell/2 像素。
         宽高比取 world 报上来的 aspect（已夹过 ISO.maxAspect）—— 自己算舞台宽高比的话，
         超宽屏下相机的横向视野被夹过，框却还按舞台铺满，画出来比实际看得见的范围宽一截。 */
      const aspectBox = cs.aspect || (cv.parentElement && cv.parentElement.clientHeight
        ? cv.parentElement.clientWidth / cv.parentElement.clientHeight : 1.4);
      const view = cs.view || 10.4;
      const w = (view * aspectBox) * MINI.cell / 2;
      const l = (view / Math.cos(Math.PI * 35.264 / 180)) * MINI.cell / 2;
      const tx = MINI.pad + ((cs.tx / 2) + 8) * MINI.cell + MINI.cell / 2;
      const ty = MINI.pad + ((cs.tz / 2) + 8) * MINI.cell + MINI.cell / 2;
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
      const r = RING[cell.id];
      const [cx, cy] = at(r.col, r.row);
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
    points: '#fff0b8', lottery: '#d6f2e6', magic: '#f0d9ff', treasure: '#ffe9a8',
    tax: '#e8e2d2', hospital: '#ffe3e3', jail: '#e3e6ee', game: '#d9f0ff',
    shop: '#ffe6c8', bank: '#f2ead2', god: '#ffd9a8', company: '#d9c9a3',
  };

  const LEGEND_GROUPS = [
    ['#8fd07a', '住宅段'], ['#7ec8ef', '商业段'], ['#c9b48a', '工业段'],
    ['#b7a6e6', '科技段'], ['#7fd8c8', '临海段'], ['#f0b96a', '金融段'],
  ];
  const LEGEND = LEGEND_GROUPS.map(([c, n]) => `<span><i class="d25-sw" style="--c:${c}"></i>${n}</span>`).join('') +
    `<span><i class="d25-sw d25-sw--ring" style="--c:#f5a742"></i><em>描边 = 持有者色</em></span>` +
    `<span><i class="d25-sw d25-sw--dot" style="--c:#ffd45e"></i><em>金晕 = 神明驻留</em></span>`;

  /* 宽画面判定：图例在「棋盘下一条」与「右侧竖导轨」之间切换（见 hud.css .hud-board--wide） */
  const WIDE_MQ = typeof matchMedia === 'function' ? matchMedia('(min-aspect-ratio: 3/2)') : null;
  const isWide = () => !!(WIDE_MQ && WIDE_MQ.matches);

  /* 棋盘形态切换：从状态条挪到棋盘右上角，两种形态位置一致，也不再抢行情带的宽度 */
  function boardSwitch() {
    const b = el('button', 'hud-bswitch', flatMode ? '🌐 切回 2.5D' : '🧊 切方环棋盘');
    b.type = 'button';
    b.setAttribute('aria-label', flatMode ? '切换为 2.5D 棋盘' : '切换为方环棋盘');
    b.setAttribute('aria-pressed', String(flatMode));
    b.onclick = () => {
      flatMode = !flatMode;
      if (globalThis.D25World) globalThis.D25World.setPaused(flatMode);
      render();
    };
    return b;
  }

  /* 悬停浮层：贴着指针走，只讲「这一格是什么」；点击把详情钉进 dock，不常驻挡棋盘 */
  function showTip(id) {
    if (id == null) { tipEl.style.opacity = '0'; return; }
    const bits = cellBits(id);
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
    stage.innerHTML = `<div class="d25-bar">
        <span class="hud-chip d25-cam">🎥 初始化…</span>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-view="reset">复位</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-view="top">正俯视</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-view="tilt">斜 45°</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-view="side">低角度</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-cam-mode type="button"
          title="正交等距近景：人物居中，周围只露几格。近景下方位感看右下小地图">🔍 近景等距</button>
        <button class="ac-btn ac-btn--cream ac-btn--sm" data-cam-demo type="button"
          title="把镜头依次交给四位玩家，验收「聚焦 → 跟随 → 解锁」">🎥 镜头巡演</button>
      </div>
      <div class="d25-hint">拖拽 / 方向键转视角 · 滚轮推拉 · 悬停看格子 · 点击钉到下方操作台</div>
      <canvas class="d25-minimap" data-minimap hidden></canvas>
      <div class="d25-mininote" data-minimap hidden>小地图 · 近景取景框</div>`;
    camChip = stage.querySelector('.d25-cam');
    tipEl = el('div', 'd25-tip');
    document.body.appendChild(tipEl);
    stage.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => globalThis.D25World.setView(b.dataset.view); });
    stage.querySelector('[data-cam-demo]').onclick = () => camTour(1);
    stage.querySelector('[data-cam-mode]').onclick = () => toggleCamMode();
    globalThis.D25World.mount(stage, S, {
      onFrame: () => {
        globalThis.D25Overlay.tick();
        const c = globalThis.D25World.cameraState();
        const s = globalThis.D25World.stats();
        /* 自愈：HUD 的锁定态只靠 onCameraLock 回调投影，一旦那次回调因为重建 / 异常漏掉，
           整个界面就会永久假死（所有按钮被捕获阶段拦掉）。这里每帧跟 world 的真实状态对一次，
           差了就纠正 —— 代价只是一次布尔比较，换掉「点哪儿都没反应」这种最难查的故障。 */
        if (HUD_LOCKED !== globalThis.D25World.isCameraLocked()) camLock(globalThis.D25World.isCameraLocked());
        const tag = c.state === 'intro' ? ' ▶ 聚焦中' : c.state === 'follow' ? ` 🎯 跟随 ${c.pid || ''}` : '';
        /* 近景与全盘的「距离」量纲不同（正交视野高度 vs 透视距离），单位要分开写，否则读数没意义。
           近景额外报「可视几格」：这个数随宽高比在 7~11 之间变，写死一个数字一定是错的
           （曾经写死「约 5 格」，实际方屏就是 7 格）。64 次投影只在 iso 下算，开销可忽略。 */
        const lens = c.mode === 'iso'
          ? `🔍 近景等距 · 可视 ${c.view.toFixed(1)}u·${globalThis.D25World.visibleCells().count}格`
          : `🗺 全盘 · 距离 ${Math.round(s.cam.dist)}`;
        const txt = `${s.fps} fps · ${s.calls} draw · ${lens} · 俯 ${Math.round(s.cam.el)}°${tag}`;
        if (camChip.textContent !== txt) camChip.textContent = txt;
        /* 小地图按 ~15fps 重画就够：它是导航辅助，不需要跟满帧 */
        const tick = Math.floor(performance.now() / 66);
        if (tick !== lastMiniTick) { lastMiniTick = tick; drawMinimap(); }
      },
      onCameraMode: () => applyCamModeUI(),
      onHover: (id) => showTip(id),
      onSelect: (id) => { if (HUD_LOCKED) return; if (id != null) { selCell = id; render(); } },
      onLand: (pid, cellId) => globalThis.D25Overlay.float(`来到「${cellName(cellId)}」`, cellId, 'gold'),
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
      bar.appendChild(boardSwitch());
      w.appendChild(bar);
      return w;
    }
    const wrap = el('section', 'hud-board d25' + (isWide() ? ' hud-board--wide' : ''));
    const hostEl = el('div', 'd25-host');
    hostEl.appendChild(ensureStage());
    wrap.appendChild(hostEl);
    wrap.appendChild(el('div', 'd25-legend', LEGEND));
    /* 2.5D 的舞台四角是留白底，浮动按钮不会压到格子 */
    wrap.appendChild(boardSwitch());
    return wrap;
  }

  /** 舞台进 DOM 之后再量尺寸：rAF 在后台标签页被冻结，所以这里同步出首帧 */
  function syncStage() {
    if (!stage || flatMode || !HAS_GL) return;
    globalThis.D25World.resize();
    globalThis.D25World.sync(S);
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
       * 判据必须是「回合指针是否变化」，不能用 activePid 比对 —— 巡演会把 activePid 挪到别人身上，
       * 那样每次 render() 都会把镜头从巡演目标拽回快照里的当前玩家。
       * 原型没有引擎回调，所以由 __camTour 手动驱动。 */
      const turnPid = st.players[st.currentPlayerIndex].id;
      if (turnPid !== lastTurnPid) {
        lastTurnPid = turnPid;
        if (!HUD_LOCKED) scheduleFocus(turnPid);
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
  function cellBits(id) {
    const cell = st.board[id];
    const typeName = CELL[cell.type][1];
    const corp = st.companies.find((c) => c.cellId === id);
    const god = view.gods.find((g) => g.cellId === id);
    const bits = [`${cell.id} · ${cell.name} · ${typeName}`];
    if (cell.price) bits.push(cell.type === 'company' ? `面值 🔔${money(corp?.sharePrice ?? cell.price)}` : `地价 🔔${money(cell.price * view.priceIndex)}`);
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
    return bits;
  }

  /* ---------------- 棋盘环（?board=flat） ---------------- */
  function renderFlatBoard() {
    const wrap = el('section', 'hud-board');
    const ring = el('div', 'hud-ring');
    const godAt = new Map(st.boardGods.map((g) => [g.cellId, g]));
    const companyAt = new Map(st.companies.map((c) => [c.cellId, c]));

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
        : cell.type === 'chance' ? '' : '';
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
    const corp = st.companies.find((x) => x.cellId === id);
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
      row.appendChild(el('span', 'hud-chip hud-chip--npc', `保释金 🔔${money(A.bailFee)}（站上监狱门外才可办）`));
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
      const m = A.magic;
      const p = el('div', 'ac-panel');
      p.innerHTML = `<div class="ac-panel__hd" style="background:var(--ac-pink)">🔮 女巫的水晶球</div>
        <div class="ac-panel__bd"><div class="hud-tile__rows"><span>可惩罚 <b>${m.candidateIds.length} 人</b></span><span>诅咒 <b>${esc(m.curse)}</b></span></div>
        <div class="hud-chips">${m.candidateIds.map((id) => `<span class="hud-chip">${esc(st.players.find((p) => p.id === id)?.name ?? id)}</span>`).join('')}</div></div>`;
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

  const snapshotFoot = () =>
    `第 ${st.turn} 回合 · ${st.phase} · 行动者 ${esc(cur.name)} · 物价 ×${view.priceIndex.toFixed(3)}（只读快照）`;

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
      item.innerHTML = `<div class="ac-list__ic">${AVA[p.id] || '🧑‍🌾'}</div>
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
      box.innerHTML = `<div class="hud-stock__hd"><b>${esc(s.name)}</b><span class="p">🔔${money(s.price)}</span>
        <span class="c">${arrow} ${Math.abs(s.lastChangePct).toFixed(1)}%</span></div>
        <div class="hud-stock__meta">
        ${halt ? `<span class="hud-chip hud-chip--warn">${halt.kind === 'up' ? '涨停' : halt.kind === 'down' ? '跌停' : '停牌'} ${halt.daysLeft} 天</span>` : ''}
        <span class="hud-chip">${s.candles.length} 根</span><span class="hud-chip">流通 ${money(s.floatShares)}</span></div>${sparkline(s)}`;
      box.title = `开 ${s.price}｜当日成交含玩家 ${s.candles.at(-1)?.playerVolume ?? 0} 股\n吃单会把价格推离盘口（冲击成本），买得越多均价越高。`;
      bd.appendChild(box);
    }
    for (const p of st.players) {
      const sm = view.stocks.find((x) => x.playerId === p.id);
      if (!sm || (!sm.rows.length && !sm.corpRows.length)) continue;
      const rows = [];
      for (const r of sm.rows) rows.push(`<tr><td>${esc(r.stockName)}</td><td>${r.quantity} 股</td><td>🔔${money(r.marketValue)}</td><td>${r.profit >= 0 ? '▲' : '▼'}${money(Math.abs(r.profit))}</td></tr>`);
      for (const r of sm.corpRows) rows.push(`<tr><td>${esc(r.name)}<br><small>原始股 · 面值定价</small></td><td>${r.quantity} 张<br><small>锁 ${r.locked} / 卖 ${r.sellable}</small></td><td>🔔${money(r.marketValue)}</td><td>${r.chairman ? '👑' : ''}${r.holdingPct}%</td></tr>`);
      const t = el('div', '');
      t.innerHTML = `<div class="ac-divider"><span class="ac-divider__mark">${AVA[p.id]} ${esc(p.name)}</span></div>
        <div class="hud-tablewrap"><table class="ac-table"><thead><tr><th>标的</th><th>数量</th><th>现值</th><th>盈亏/占比</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
      bd.appendChild(t);
    }
    bd.appendChild(el('div', 'hud-foot', '上市股只能动用存款 ✈️；地图 11 家公司的原始股用现金 🔔、按面值随时卖回、认购当回合锁一手。'));
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
      return `<tr title="${esc(a.playerName)}"><td>${AVA[p.id]}${a.bankrupt ? '💀' : ''}</td><td>${money(a.cash)}</td><td>${money(a.deposit)}</td>
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
        return `<tr><td>${esc(cellName(c.cellId))}<br><small>格 ${c.cellId}</small></td><td>🔔${money(c.sharePrice)}</td><td>${money(c.surplus)}</td>
          <td>${c.chairmanId ? '👑' + esc(st.players.find((p) => p.id === c.chairmanId)?.name ?? '') : '空缺'}</td><td>${esc(held)}</td></tr>`;
      }).join('');
      bd.appendChild(el('div', '', `<div class="ac-divider"><span class="ac-divider__mark">🏢 公司经营权（每月 15 号按持股比例分盈余）</span></div>
        <div class="hud-tablewrap"><table class="ac-table"><thead><tr><th>公司</th><th>面值</th><th>累积盈余</th><th>董事长</th><th>持股</th></tr></thead><tbody>${rows}</tbody></table></div>`));
    }
  }

  function cellName(id) { return st.board[id]?.name ?? `格 ${id}`; }
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
    bd.querySelectorAll('[data-post]').forEach((b) => b.onclick = () => toast(`（原型）已挂出「${b.dataset.post}」—— 真实挂牌要 POST_TRADE 给引擎`, 'bell'));
  }

  /* ---------------- Dock：选中格 · 行囊 · 动作（主操作唯一，次操作与灰态折进弹层） ---------------- */
  function actionSpec() {
    return [
      ['🎲 掷骰', A.canRoll, 'ac-btn--green', '只有「等待掷骰」阶段能按，且必须有行动权'],
      [`💰 买下「${cellName(cur.position)}」`, A.canBuy, 'ac-btn--green', '脚下是无主地产、现金够、且没在梦游（价格见左侧格块）'],
      ['🏗️ 加盖一层', A.canUpgrade, 'ac-btn--green', '脚下是自己的地，未达 5 级'],
      ...A.buildableFacilities.map((f) => [`🏗️ 建「${view.names.facilities[f]?.name ?? f}」`, true, 'ac-btn--blue', '商业用地上可选的设施']),
      ...(A.canBuyShares ? [[`🧾 认购原始股 🔔${money(A.sharePrice)} ×${A.shareQuantityLimit}`, true, 'ac-btn--orange', '一级市场按面值，当回合锁定不能卖']] : []),
      ['🏦 存款', A.canDeposit, 'ac-btn--blue', '月末计息，代价是钱不在手上'],
      ['🏧 取款', A.canWithdraw, 'ac-btn--blue', '取出来才能付现钱'],
      ['💳 贷款', A.canLoan, 'ac-btn--blue', '额度上限＝开局资金，3 个月到期必须还清'],
      ['↩️ 提前还款', A.canRepayLoan, 'ac-btn--blue', '还掉才腾出贷款额度、当月存款才计息'],
      ['🛍️ 进商店', A.canShop, 'ac-btn--blue', '脚下是商店格'],
      ['📈 开股市', A.canTradeStock, 'ac-btn--blue', st.stockHaltAllDays > 0 ? `全市场停牌还剩 ${st.stockHaltAllDays} 天` : view.date.isHoliday ? '例假日休市' : '上市股只花存款'],
      ['🎰 买乐透', A.canBuyLottery, 'ac-btn--orange', `一注 🔔${money(A.lotteryTicketCost)}，每月 15 号开奖`],
      ...A.bailableVillains.map((k) => [`🚔 保释${NPC_CN[k] ?? k} 🔔${money(A.bailFee)}`, true, 'ac-btn--orange', '收编恶人，它去偷别人的钱，你抽成']),
      ...A.dischargeablePatients.map((id) => [`🏥 让 ${esc(st.players.find((p) => p.id === id)?.name ?? id)} 出院 🔔${money(A.dischargeFee)}`, true, 'ac-btn--orange', '替他垫钱，攒个人情']),
      ...(A.magic ? [[`🔮 施法（${A.magic.candidateIds.length} 人可罚）`, true, 'ac-btn--orange', '女巫水晶球：降下 ' + A.magic.curse]] : []),
      ...(A.estateBuildCells.length ? [[`🏢 房地产公司加盖（${A.estateBuildCells.length} 处可选）`, true, 'ac-btn--orange', '董事长特权，施工费＝该地地价 ×50%']] : []),
      ...(A.canFinancing ? [[`💳 特别融资（剩 🔔${money(A.financingRemaining)}）`, true, 'ac-btn--orange', '企业银行董事长专属，期间存款不计息']] : []),
      ['🚩 认输投降', A.canSurrender, 'ac-btn--cream', '干净退出，但必须指定一人被死神附身 13 天'],
      ['✅ 结束回合', A.canEnd, 'ac-btn--green', '把行动权交给下一个人'],
    ];
  }

  /* 相机状态条：横向铺满 dock 顶部，把「镜头在干什么」与「现在能不能点」分开写清楚 */
  function renderCamBar() {
    const cam = el('div', 'hud-cambar');
    if (flatMode || !HAS_GL) {
      /* 方环形态下没有相机：不摆一个假的「跟随 xx」，直接说清楚 */
      cam.innerHTML =
        `<span class="hud-camtag hud-camtag--hint">🧊 方环示意下没有相机系统</span>` +
        `<button class="ac-btn ac-btn--cream ac-btn--sm" data-cam-demo type="button">🌐 切回 2.5D 看相机</button>`;
      cam.querySelector('[data-cam-demo]').onclick = () => { flatMode = false; if (globalThis.D25World) globalThis.D25World.setPaused(false); render(); };
      return cam;
    }
    cam.innerHTML =
      `<span class="hud-camtag hud-camtag--lock" data-cam-lock role="status" aria-live="polite" ${HUD_LOCKED ? '' : 'hidden'}>🔒 镜头聚焦中 · 操作已屏蔽</span>` +
      `<span class="hud-camtag">🎥 镜头跟随 <b data-cam-target>${esc(st.players.find((p) => p.id === activePid)?.name ?? activePid)}</b></span>` +
      `<span class="hud-camtag hud-camtag--hint">原型只动镜头 · 不改回合</span>` +
      `<button class="ac-btn ac-btn--cream ac-btn--sm" data-cam-demo type="button" ` +
      `title="把镜头依次交给四位玩家，验收「聚焦 → 跟随 → 解锁」">🎥 镜头巡演</button>`;
    cam.querySelector('[data-cam-demo]').onclick = () => camTour(1);
    return cam;
  }

  function renderDock() {
    const bar = el('footer', 'hud-dock');
    bar.appendChild(renderCamBar());
    bar.append(tileBlock(), renderBag());

    const spec = actionSpec();
    const first = (re) => spec.find((row) => row[1] && re.test(row[0]));
    const primary = first(/掷骰/) || first(/买下/) || first(/加盖一层/) || null;
    const endRow = spec.find((row) => row[1] && /结束回合/.test(row[0]) && row !== primary);
    const acts = el('div', 'hud-act');

    const more = el('div', 'hud-act__more');
    const secondary = spec.filter((row) => row !== primary && row !== endRow && row[1]);
    const blocked = spec.filter((row) => !row[1]);

    if (secondary.length) {
      const btn = el('button', 'ac-btn ac-btn--cream', `⚙️ 更多动作 ${secondary.length}`);
      btn.setAttribute('aria-expanded', 'false');
      const pop = el('div', 'hud-pop');
      pop.innerHTML = `<div class="hud-pop__t">此刻可做的次操作（共 ${secondary.length}）</div>`;
      const grid = el('div', 'hud-pop__grid');
      for (const [label, , variant] of secondary) {
        const b = el('button', `ac-btn ${variant}`, label);
        b.onclick = () => cosmetic(label);
        grid.appendChild(b);
      }
      pop.appendChild(grid);
      btn.onclick = () => togglePop(pop, btn);
      more.append(btn, pop);
    }

    if (blocked.length) {
      const btn2 = el('button', 'ac-btn ac-btn--cream', `🚫 被挡住 ${blocked.length}`);
      btn2.setAttribute('aria-expanded', 'false');
      const pop2 = el('div', 'hud-pop');
      pop2.innerHTML = `<div class="hud-pop__t">这些动作此刻不可用（门控与引擎同源）</div><div class="hud-pop__list">` +
        blocked.map(([label, , , why]) => `<div class="hud-pop__row"><b>${label}</b><span>${esc(why)}</span></div>`).join('') + '</div>';
      btn2.onclick = () => togglePop(pop2, btn2);
      more.append(btn2, pop2);
    }

    if (primary) {
      const b = el('button', `ac-btn ${primary[2]} ac-btn--lg`, primary[0]);
      b.dataset.primary = '1';
      b.title = '回车键 = ' + primary[0];
      b.onclick = () => cosmetic(primary[0]);
      acts.append(more, b);
    } else {
      acts.append(more, el('span', 'hud-chip hud-chip--off', '此刻轮不到你行动'));
    }
    /* 结束回合是流程控制，不是 CTA：常驻，免得每次翻弹层 */
    if (endRow) {
      const e = el('button', 'ac-btn ac-btn--cream', endRow[0]);
      e.title = endRow[3];
      e.onclick = () => cosmetic(endRow[0]);
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
      const cell = el('button', `ac-invgrid__cell ${usable.has(id) ? 'ac-invgrid__cell--rare' : ''}`);
      cell.innerHTML = `${ITEM_EMOJI[id] || '🧰'}${qty > 1 ? `<span class="ac-invgrid__qty">${qty}</span>` : ''}`;
      cell.setAttribute('aria-label', `${view.names.items[id]?.name ?? id}${usable.has(id) ? '，此刻可用' : '，此刻不可用'}`);
      cell.onclick = () => cosmetic(usable.has(id) ? `使用道具「${view.names.items[id]?.name ?? id}」` : `道具「${view.names.items[id]?.name ?? id}」此刻不可用`);
      row.appendChild(cell);
    }
    for (const cid of me.cards) {
      const can = A.usableCards.includes(cid);
      const cell = el('button', `ac-invgrid__cell ${can ? 'ac-invgrid__cell--diy' : ''}`);
      cell.innerHTML = '🃏';
      cell.setAttribute('aria-label', `${view.names.cards[cid]?.name ?? cid}${can ? '，此刻可用' : '，此刻不可用'}`);
      cell.onclick = () => cosmetic(can ? `使用卡片「${view.names.cards[cid]?.name ?? cid}」` : `卡片「${view.names.cards[cid]?.name ?? cid}」此刻不可用`);
      row.appendChild(cell);
    }
    bag.appendChild(row);
    return bag;
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
    if (/结束回合/.test(label)) { toast('（原型）回合推进要发 END_TURN 给引擎，这里不跑规则。想看不同视角点右侧岛民。'); return; }
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
    const root = document.getElementById('app');
    const shell = el('div', 'hud-shell');
    shell.appendChild(renderTop());
    shell.appendChild(renderStatus());
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

    /* 输入闸门：捕获阶段拦掉整壳的点击。放在捕获阶段是为了连「键盘回车 → primary.click()」
     * 与 ac-btn 自己的 onclick 都拦得住 —— 只靠 cosmetic() 里判断会漏掉 tab / 挂出 / 商店这些旁路。
     * 唯一放行的是巡演按钮：它是用来驱动镜头的，被自己锁死就没法验收了。 */
    shell.addEventListener('click', (e) => {
      if (!HUD_LOCKED) return;
      const t = e.target instanceof Element ? e.target.closest('button, [role="button"], a') : null;
      if (t && t.hasAttribute('data-cam-demo')) return;
      e.preventDefault();
      e.stopPropagation();
      if (t) toast('🎥 镜头正在聚焦，等视角停稳再操作', 'bell');
    }, true);

    applyCamLockUI();     // shell 是新造的，锁定态得重新刷上去
    applyCamModeUI();     // 同理：小地图显隐、切换按钮文案、预设置灰
    syncStage();
  }

  /* 键盘：回车＝主操作，Esc＝关弹层（不抢系统快捷键） */
  document.addEventListener('keydown', (e) => {
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

  render();
})();
