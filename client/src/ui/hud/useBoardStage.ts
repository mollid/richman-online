/**
 * 棋盘舞台挂载钩子：把 `hud.js` 里那套 vanilla 挂载契约原样搬进 React，只改「谁持有节点」。
 *
 * 三条必须守住的约束，都是实测踩出来的（改动这里前先读完再动手）：
 *
 * 1. **舞台节点不能被 React 卸载或替换。** `D25World.mount()` 里的 ResizeObserver 钉死在
 *    那一次 mount 收到的节点上；React 一旦重建这个 div（换 key、条件渲染、把舞台当 children），
 *    尺寸变化就再也进不到 world，画面停在最后一次 resize 的比例上。
 *    所以 host 是 React 的、空的，`.d25-stage` 由本钩子 `createElement` 出来塞进去，React 不再碰它。
 * 2. **React 的覆盖层必须是舞台的兄弟，不能是它的子女。** `world.dispose()` 是
 *    `host.innerHTML = ''`，`overlay.dispose()` 会把舞台里所有 canvas 删掉。取景读数与小地图
 *    都挂在 host 上，正好绕开这两把扫。
 * 3. **每帧不许 setState。** `onFrame` 是 60fps，读数和取景框走 canvas 与 ref，
 *    只有「相机模式 / 锁定态 / 跟随对象」真的变了才推进 React 一次。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AcSnapshot } from '../../game/acSnapshot.js';
import { drawMinimap } from './minimap.js';

/** 一次移动演出最多跳几格（0.16 秒/格 ≈ 1.3 秒）；更长的行程只演最后几格 */
const HOP_MAX_CELLS = 8;
/** 首屏先让人看清全貌，再走向当前玩家 —— 一上来就怼近景会失去方位感。
 *  「看清全貌」现在由小地图承担（它常驻），镜头仍然从默认近景起步。 */
const INTRO_DELAY = 420;
/** 小地图按 ~15fps 重画就够：它是导航辅助，不需要跟满帧 */
const MINI_TICK_MS = 66;

export interface StageCam {
  /** 相机状态机：入场补间 / 跟随 / 静止 */
  follow: 'intro' | 'follow' | 'idle';
  /** 镜头正跟着谁（名字，取自快照，world 只给 id） */
  target: string;
  /** 视野里实际看得见的格数（滚轮推拉会变） */
  visible: number;
  /** 相机补间期间锁操作 */
  locked: boolean;
}

export interface BoardStageOptions {
  /** 脚本（three / pixi / world / overlay）就位了才允许挂载 */
  enabled: boolean;
  snapshot: AcSnapshot;
  /** 热座为 true：视角跟着回合走。联机为 false：锁在自己身上，别抢用户手选的视角 */
  followCurrent: boolean;
  onPickCell: (cellId: number) => void;
  onPickPlayer: (pid: string) => void;
  /** 普通点击（不在选目标态）= 把这一格钉到底部卡片 */
  onSelectCell: (cellId: number) => void;
  /** 悬停：宿主负责把 cellId 翻成那句话 */
  onHover: (cellId: number | null) => void;
  /** 选目标态：候选集每次快照重推，回合一动就可能变（例如对手走出了视野） */
  pick: StagePick | null;
}

/**
 * 选目标态的候选集。
 * 合法性只在派单那一刻由引擎那一个谓词裁决，这里只负责把候选交给世界层画绿环与压暗，
 * 以及把「被拒的引擎原话」留着给 hover 引用 —— 表现层不复制第二套判断。
 */
export interface StagePick {
  cells: number[];
  players: string[];
  rejected: Array<{ id: number; reason: string }>;
  playerRejected: Array<{ id: string; reason: string }>;
}

/** 抛给宿主用的探针。AcHudLayer 靠 `isSettled` 决定什么时候把落格面板弹出来。 */
export interface StageApi {
  isSettled: () => boolean;
}

const CAM0: StageCam = { follow: 'idle', target: '', visible: 0, locked: false };

const sameCam = (a: StageCam, b: StageCam) =>
  a.follow === b.follow && a.target === b.target && a.visible === b.visible && a.locked === b.locked;

export function useBoardStage(opts: BoardStageOptions) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  /** 回调每次渲染重指，但挂载出去的 hooks 只有一份 —— 用 ref 让它们永远调到最新实现 */
  const o = useRef(opts);
  o.current = opts;

  const [cam, setCam] = useState<StageCam>(CAM0);
  const camRef = useRef<StageCam>(CAM0);
  /** 推一次读数：真的变了才惊动 React */
  const publishCam = useCallback((next: StageCam) => {
    if (sameCam(camRef.current, next)) return;
    camRef.current = next;
    setCam(next);
  }, []);

  /* 相机状态机的那些「上一次看到的东西」：全是表现层记账，不参与任何规则判定 */
  const lastPosRef = useRef<Map<string, number> | null>(null);
  const spunDiceRef = useRef<string | null>(null);
  const activePidRef = useRef<string | null>(null);
  const lastTurnPidRef = useRef<string | null>(null);
  const pendingTurnPidRef = useRef<string | null>(null);
  const camFocusedRef = useRef(false);
  const lockedRef = useRef(false);
  const lastMiniRef = useRef(-1);
  /** 入场那次延时聚焦的定时器句柄：卸载必须清，否则回调会对着已 dispose 的 world 再跑一次 */
  const introTimerRef = useRef(0);
  /** 上一次发出去的跟随对象（id 而不是名字）：查名字要遍历 players，不能每帧查 */
  const camPidRef = useRef<string | null>(null);
  /** 上一次的相机视野宽度：滚轮推拉只改它，不改 pid / follow */
  const camViewRef = useRef<number | null>(null);

  const W = () => globalThis.D25World;
  const OV = () => globalThis.D25Overlay;

  /** 让相机聚焦到某位玩家 */
  const scheduleFocus = useCallback((pid: string) => {
    activePidRef.current = pid;
    W()?.focusPlayer(pid);
    /* 这里**不**往 camRef 里写 target：那个字段是「名字」，而手上只有 id。
       读数由 onFrame 从快照里查名字后统一发，两处各写一个口径就会有一帧把 `local-0` 画到界面上。 */
  }, []);

  /** 演出结束（或被取消）后把攒下的换人聚焦放出去 —— 「跳完才交接镜头」的那一刀 */
  const flushPendingFocus = useCallback(() => {
    // 镜头还在入场补间里就先留着，由解锁那一侧补放，别让这次交接彻底丢掉
    const pid = pendingTurnPidRef.current;
    if (!pid || lockedRef.current) return;
    pendingTurnPidRef.current = null;
    scheduleFocus(pid);
    OV()?.rebuild();
    W()?.renderOnce();
  }, [scheduleFocus]);

  const setLocked = useCallback(
    (v: boolean) => {
      const nv = !!v;
      const changed = nv !== lockedRef.current;
      lockedRef.current = nv;
      /* 解锁的瞬间补上演出期间攒下的换人聚焦（镜头入场时正好有人在跳） */
      if (changed && !nv) flushPendingFocus();
      publishCam({ ...camRef.current, locked: nv });
    },
    [flushPendingFocus, publishCam],
  );

  /**
   * 认引擎记下的路线 → 骰子 + 逐格跳。
   * 认不出路线的位移**一律不猜**：那是押送 / 传送 / 神明挪位，语义就是瞬移。
   */
  const playMovement = useCallback(() => {
    const S = o.current.snapshot;
    const st = S.state;
    const now = new Map(st.players.map((p) => [p.id, p.position]));
    const prev = lastPosRef.current;
    lastPosRef.current = now;
    if (!prev) return false;
    const world = W();
    if (!world?.playMove) return false;
    const moved = st.players.filter((p) => prev.has(p.id) && prev.get(p.id) !== p.position);
    // 只演「一个人沿圈走了几步」。多人同帧位移 = 换位卡那类，硬演会让人绕半个棋盘飘过去
    const p = moved.length === 1 ? moved[0] : undefined;
    const from0 = p ? prev.get(p.id) : undefined;
    if (!p || from0 === undefined) return false;
    // heading 是邻接表下标：环上 0 = 逆时针、1 = 顺时针（引擎里 direction 的替身）
    const dir = p.heading === 0 ? -1 : 1;
    /* 认路线要过三道脸：① 有路线；② 尾巴不是这个人上一帧的脚下格；③ 第一格确实从他上一帧
       那一格出发。②③ 同时是「这条路线归不归他」的证据 —— movePath 是全队共用的一格，
       别人走过的路不能安到他头上。认不过就直接落位：旧写法按环上取模补走，
       看着就是「从反方向绕半个棋盘走过去」，距离越远越假。 */
    const rec = st.movePath;
    const isStep = (a: number, b: number) => {
      const n = st.board.length || 64;
      const c = st.board[a];
      if (c?.neighbors) return c.neighbors.includes(b);
      return (b - a + n) % n === 1 || (a - b + n) % n === 1;
    };
    const tail = rec?.[rec.length - 1];
    const head = rec?.[0];
    if (!rec?.length || tail === undefined || head === undefined || tail === from0 || !isStep(from0, head)) return false;
    const start = Math.max(0, rec.length - HOP_MAX_CELLS);
    const cells = rec.slice(start);
    const from = start > 0 ? (rec[start - 1] ?? from0) : from0;
    /* 走完这条路人却不在尾巴上 = 这一手还被押走 / 传送了一次：把真落点交出去，
       由 world 演第二段（停一拍让人读完播报，再瞬移到那一格）。 */
    const transfer = tail !== p.position ? p.position : null;
    /* 骰子只在「这一手第一次出现」时摇：state.dice 留到下一手才被覆盖，
       不认脸的话传送、神明挪位那些也会把上一手的点数又摇一遍。 */
    const dice = st.dice ?? [];
    const key = `${st.turn}:${dice.join('+')}`;
    const walk = cells.length;
    const spin = dice.length > 0 && walk <= dice.reduce((a, b) => a + b, 0) && key !== spunDiceRef.current;
    if (spin) spunDiceRef.current = key;
    return world.playMove({ pid: p.id, from, steps: walk, dir, cells, transfer, dice: spin ? dice : null });
  }, []);

  /** 快照到了：把棋子摆到真值、决定镜头要不要交接、重画名牌 */
  const syncStage = useCallback(() => {
    const world = W();
    if (!world || !stageRef.current) return;
    const S = o.current.snapshot;
    world.resize();
    // 先派发动画再 sync：sync 会把没在演出的棋子直接摆到真值格上
    playMovement();
    world.sync(S);
    OV()?.setSnapshot?.(S);
    world.paintOwners();

    /* 镜头目标的决定必须排在 Overlay.rebuild() 之前：名牌金底取的是「跟随中的那位」
       （world.tokenAnchors().cur），先 rebuild 再换目标，金底就停在上一回合的玩家身上 ——
       只差一帧，但那一帧之后没人再 rebuild，于是它一直是错的。 */
    if (!camFocusedRef.current) {
      camFocusedRef.current = true;
      if (!activePidRef.current) activePidRef.current = S.state.players[S.state.currentPlayerIndex]?.id ?? null;
      window.clearTimeout(introTimerRef.current);
      introTimerRef.current = window.setTimeout(() => {
        if (lockedRef.current) return;
        if (activePidRef.current) scheduleFocus(activePidRef.current);
        OV()?.rebuild();
        world.renderOnce();
      }, INTRO_DELAY);
    } else {
      /* 回合「换人」时自动把镜头交给新的当前玩家。判据必须是回合指针，
         不能拿 activePid 比对 —— 一旦别处挪过 activePid，每次快照都会把镜头又拽回去。 */
      const turnPid = S.state.players[S.state.currentPlayerIndex]?.id;
      if (turnPid && turnPid !== lastTurnPidRef.current) {
        lastTurnPidRef.current = turnPid;
        // 上一位还在格子上跳 ⇒ 先记账，等他跳完再交镜头：否则玩家看到「棋子腾空、画面已走」
        if (world.isHopping?.()) pendingTurnPidRef.current = turnPid;
        else if (!lockedRef.current) scheduleFocus(turnPid);
      }
    }

    OV()?.rebuild();
    world.renderOnce();
  }, [playMovement, scheduleFocus]);

  /* ---------------- 挂载 / 卸载（只跟 enabled 与「名单是否可画」走，不跟快照走） ---------------- */
  const mountable = opts.enabled && opts.snapshot.state.players.length > 0;
  const firstSnapRef = useRef(opts.snapshot);
  firstSnapRef.current = opts.snapshot;

  useEffect(() => {
    const host = hostRef.current;
    if (!mountable || !host) return;
    const world = globalThis.D25World;
    const overlay = globalThis.D25Overlay;
    if (!world || !overlay) return;

    /* 舞台由本钩子创建：React 只拥有 host，所以它重渲染、加读数、换小地图都碰不到这个节点。
       覆盖层一律做成舞台的**兄弟**，不做子女 —— world.dispose() 是 host.innerHTML=''，
       overlay.dispose() 会删掉舞台里所有 canvas，子女节点会被这两把扫一起带走。
       另外这也让按钮不会被 stage 的 setPointerCapture 抢走 click（见 world.js 的 isControl）。 */
    const stage = document.createElement('div');
    stage.className = 'mp-stage';
    host.appendChild(stage);
    stageRef.current = stage;

    world.mount(stage, firstSnapRef.current, {
      onFrame: () => {
        overlay.tick();
        const w = globalThis.D25World;
        if (!w) return;
        const c = w.cameraState();
        /* 自愈：锁定态只靠 onCameraLock 回调投影，一旦那次回调因为重建 / 异常漏掉，
           整块界面就会永久假死。每帧跟 world 的真实状态对一次，代价只是一次布尔比较。 */
        if (lockedRef.current !== w.isCameraLocked()) setLocked(w.isCameraLocked());
        const S = o.current.snapshot;
        /* 先比四把便宜的钥匙，全等就整段跳过 —— 名字要从 players 里 find、格数要调
           visibleCells()（它把所有棋子投影一遍），这两样都不该白付 60 次每秒。
           文件头第 3 条说的是「不许每帧 setState」，但真正的代价在这里：不进调和不等于不干活。 */
        const prev = camRef.current;
        /* `visible` 也是载荷的一部分，所以它必须进钥匙：滚轮推拉会改 world 的视野宽度，
           而 locked / follow / pid 三个都不动 —— 少这一把的话「周围 N 格」会冻在第一次
           进入近景时的数字，而它明明是 world 现算出来的。 */
        if (
          prev.locked !== lockedRef.current ||
          prev.follow !== c.state ||
          camPidRef.current !== c.pid ||
          camViewRef.current !== c.view
        ) {
          camPidRef.current = c.pid;
          camViewRef.current = c.view;
          const who = c.pid ? S.state.players.find((p) => p.id === c.pid)?.name ?? '' : '';
          publishCam({
            follow: c.state === 'intro' ? 'intro' : c.state === 'follow' ? 'follow' : 'idle',
            target: who,
            visible: w.visibleCells().count,
            locked: lockedRef.current,
          });
        }
        const cv = miniRef.current;
        if (cv && !cv.hidden) {
          const tick = Math.floor(performance.now() / MINI_TICK_MS);
          if (tick !== lastMiniRef.current) {
            lastMiniRef.current = tick;
            const v = S.view;
            drawMinimap(cv, {
              board: S.state.board,
              layout: v.layout,
              owners: v.owners,
              players: S.state.players.map((p) => ({ id: p.id, position: p.position, color: p.color })),
              treasureCellId: v.treasureCellId,
              activePid: activePidRef.current,
              /* 选目标时的可达格：近景一次只看得到周围几格，选十几格外的目标时高亮全在屏幕外，
                 只能靠小地图把这些格子标出来 —— 这不是加分项，是没有全盘视角之后的必需品。 */
              reachable: o.current.pick?.cells ?? [],
              cam: c,
              stageAspect: (host.clientWidth || 1) / (host.clientHeight || 1),
            });
          }
        }
      },
      /* 切模式后下一次 onFrame 会重报读数，这里不需要也不应该自己拼 */
      onHover: (id: number | null) => o.current.onHover(id),
      onSelect: (id: number | null) => {
        if (lockedRef.current || id == null) return;
        /* 只要处在选目标态，点棋盘就交回宿主 —— 判据是「有没有 pick」，不是「cells 非空」。
           选人态下 cells 是空数组，早先写成 `p?.cells.length` 会让点格子落回「钉住卡片」，
           于是宿主那条「玩家瞄的是人，不该因为指针偏两像素就失败」的兜底再也进不去。 */
        if (o.current.pick) o.current.onPickCell(id);
        else o.current.onSelectCell(id);
      },
      onPickPlayer: (pid: string) => {
        if (lockedRef.current || !o.current.pick?.players.length) return;
        o.current.onPickPlayer(pid);
      },
      onLand: (_pid: string, cellId: number, kind: string) => {
        const S = o.current.snapshot;
        const name = S.state.board[cellId]?.name ?? '';
        /* 文案与 hud.js 逐字一致：押送 / 住院 / 瞬移是三种不同的事，混成一句「来到」就丢了信息 */
        const label =
          kind !== 'transfer'
            ? `来到「${name}」`
            : S.state.board[cellId]?.type === 'jail'
              ? `被押送至「${name}」`
              : S.state.board[cellId]?.type === 'hospital'
                ? `被送往「${name}」`
                : `瞬移到「${name}」`;
        globalThis.D25Overlay?.float(label, cellId, kind === 'transfer' ? 'bad' : 'gold');
      },
      onMoveSettled: () => flushPendingFocus(),
      onCameraLock: (v: boolean) => setLocked(v),
      onCameraSettled: () => setLocked(false),
    });
    overlay.mount(stage, firstSnapRef.current);

    /* 舞台进 DOM 之后再量尺寸：rAF 在后台标签页被冻结，所以这里同步出首帧 */
    syncStage();

    const onResize = () => requestAnimationFrame(syncStage);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(introTimerRef.current);
      overlay.dispose();
      world.dispose();
      stage.remove();
      stageRef.current = null;
      camFocusedRef.current = false;
      lockedRef.current = false;
      lastPosRef.current = null; // 重新挂载的第一帧不演动画：之前的脚下格属于上一副棋盘
      spunDiceRef.current = null;
      pendingTurnPidRef.current = null;
      activePidRef.current = null;
      lastTurnPidRef.current = null;
      camPidRef.current = null;
      camViewRef.current = null;
      /* 刻意不再调 setLocked(false)：lockedRef 上面已经归零，再发一次只会把 setState 推到
         正在卸载的组件上（React 18 不报错，但那是一次没有接收方的渲染）。 */
    };
    /* 依赖表里这四个回调都是 useCallback 出来的稳定引用，所以本effect实际只跟 `mountable` 走。
       列全它们是为了不骗 eslint —— 任何一个变成不稳定，代价就是整个 WebGL 世界被拆了重建，
       而那正是文件头第 1 条约束要防的事。改这里之前先确认依赖仍然稳定。 */
  }, [mountable, flushPendingFocus, publishCam, setLocked, syncStage]);

  /* 快照推进：只喂数据，不重挂舞台 */
  useEffect(() => {
    if (!stageRef.current) return;
    syncStage();
    globalThis.D25World?.redrawLabels?.();
    globalThis.D25World?.renderOnce?.();
  }, [opts.snapshot, syncStage]);

  /* 选目标态：绿环与压暗交给世界层画（它才有格子 mesh） */
  useEffect(() => {
    const w = globalThis.D25World;
    if (!w || !stageRef.current) return;
    const cells = opts.pick?.cells ?? [];
    const players = opts.pick?.players ?? [];
    w.setPickHighlight?.(cells);
    w.setPickPlayers?.(players);
    /* 手型光标要的是「真的有待选对象」，不是「宿主传了个 pick 对象」——
       空集合也会把光标变成十字，玩家会去点棋盘却什么都点不到。与 hud.js 的 picking() 同判据。 */
    stageRef.current.classList.toggle('mp-stage--pick', cells.length > 0 || players.length > 0);
  }, [opts.pick]);

  /* 热座下视角跟着回合走；联机锁在自己身上（不抢用户手选的视角） */
  useEffect(() => {
    const S = opts.snapshot;
    const want = S.view.myPlayerId;
    if (!want) return;
    const known = S.state.players.some((p) => p.id === activePidRef.current);
    if (opts.followCurrent || !known) activePidRef.current = want;
  }, [opts.snapshot, opts.followCurrent]);

  const apiRef = useRef<StageApi>({ isSettled: () => !globalThis.D25World?.isHopping?.() });

  return { hostRef, stageRef, miniRef, cam, apiRef };
}
