/**
 * 小地图：把 `hud.js` 里那套 canvas 画法收成一个纯函数模块。
 *
 * 为什么单独成文件而不是留在组件里：它是这套 HUD 唯一「每帧都画、但不进 React 状态」的东西。
 * 近景等距下玩家只剩这一块方位感，取景框每动一像素都要跟着重画 —— 走 `setState` 等于把
 * 60fps 的相机塞进 React 的调和队列。所以这里只接 canvas + 数据，画出结果，不产生渲染周期。
 *
 * 几何必须与 3D 场景同源：`view.layout` 是 shared 的 `boardLayout` 算出来的世界坐标，
 * 这里按同一个 `spacing` 定标。两处各算一次，取景框就会相对格子偏掉。
 */
import { miniColor, ringCells, type BoardCell, type BoardLayout } from '@richman/shared';

/** `cell` = 一格边长（CSS 像素），`scale` = 画布倍图，`spacing` 与世界层同口径 */
export const MINI = { cell: 6, pad: 7, scale: 2, spacing: 2 };

/** `D25World.cameraState()` 里取景框用得上的那几项（全部可选：world 没挂载时按 0 处理） */
export interface MiniCam {
  mode?: string;
  tx?: number;
  tz?: number;
  az?: number;
  /** 当前相机在地面上的可视宽度（世界单位） */
  view?: number;
  /** world 已夹过 ISO.maxAspect 的实际宽高比 */
  aspect?: number;
}

export interface MiniInput {
  board: readonly BoardCell[];
  layout: BoardLayout | null;
  owners: Record<number, string>;
  players: Array<{ id: string; position: number; color: number }>;
  treasureCellId: number | null;
  /** 镜头正在跟随的那位：给他一圈金环 */
  activePid: string | null;
  iso: boolean;
  cam: MiniCam;
  /** 舞台宽高比，只在 world 没报 `aspect` 时兜底 */
  stageAspect: number;
}

export interface MiniGeom {
  w: number;
  h: number;
  /** 世界单位 → 小地图像素 */
  k: number;
  at: (cellId: number) => [number, number];
  world: (tx: number, tz: number) => [number, number];
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/**
 * 有 `layout` 就按世界坐标铺（原版图：格数不等、形状不是正方形，画布边长现算）；
 * 没有就退回「外圈方环」—— 那是自建图没带坐标时的兜底，与 3D 层用的是同一个 `ringCells`。
 */
export function miniGeom(board: readonly BoardCell[], layout: BoardLayout | null): MiniGeom {
  const k = MINI.cell / MINI.spacing;
  const cells = layout?.cells;
  if (cells && cells.length === board.length) {
    const xs = cells.map((p) => p.x);
    const zs = cells.map((p) => p.z);
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const midZ = (Math.max(...zs) + Math.min(...zs)) / 2;
    const w = (Math.max(...xs) - Math.min(...xs)) * k + MINI.cell + MINI.pad * 2;
    const h = (Math.max(...zs) - Math.min(...zs)) * k + MINI.cell + MINI.pad * 2;
    const px = (x: number) => w / 2 + (x - midX) * k;
    const pz = (z: number) => h / 2 + (z - midZ) * k;
    return {
      w,
      h,
      k,
      at: (id) => {
        const c = cells[id];
        return c ? [px(c.x), pz(c.z)] : [w / 2, h / 2];
      },
      world: (tx, tz) => [px(tx), pz(tz)],
    };
  }
  const ring = ringCells(board);
  const L = Math.ceil(board.length / 4) + 1;
  const d = MINI.cell * L + MINI.pad * 2;
  /* 方环的世界原点：`world.js:ringPos()` 写的是 `(col - 9) * SPACING`（SPACING=2，与这里
     MINI.spacing 同口径），所以反函数必须是 `col = x/spacing + 9`。
     旧小地图在这一行用了 `+8` —— 取景框相对格子整整偏一格，因为近景下画面里本来就只露几格，
     偏一格的框看着仍然"差不多对"，只有拿坐标反算才看得出来。
     这里写成 (L+1)/2 而不是硬编码 9：64 格环上两者相同，但万一这张图没带坐标又不是 64 格，
     它跟着边长走，不会把格子排进负坐标。 */
  const origin = (L + 1) / 2;
  const atXY = (col: number, row: number): [number, number] => [
    MINI.pad + (col - 1) * MINI.cell + MINI.cell / 2,
    MINI.pad + (row - 1) * MINI.cell + MINI.cell / 2,
  ];
  return {
    w: d,
    h: d,
    k,
    at: (id) => {
      const r = ring[id];
      return r ? atXY(r.col, r.row) : [d / 2, d / 2];
    },
    world: (tx, tz) => atXY(tx / MINI.spacing + origin, tz / MINI.spacing + origin),
  };
}

/** 取景框那个长方形的补角：等距相机的俯角是固定值，纵向视野要按 cos 拉开 */
const ISO_ELEV = (Math.PI * 35.264) / 180;

/**
 * 画一整张。返回 `false` 表示拿不到 2D 上下文（canvas 未挂载或被隐藏），调用方不必重试。
 *
 * 尺寸由这里管：几何随快照变（换图 / 换局），但每帧 `resize` 会清空画布并抖动，
 * 所以只在算出来的边长真的变了才写 `width/height`。
 */
export function drawMinimap(cv: HTMLCanvasElement, input: MiniInput): boolean {
  const ctx = cv.getContext('2d');
  if (!ctx) return false;
  const g = miniGeom(input.board, input.layout);
  const wantW = Math.round(g.w * MINI.scale);
  const wantH = Math.round(g.h * MINI.scale);
  if (cv.width !== wantW || cv.height !== wantH) {
    cv.width = wantW;
    cv.height = wantH;
    /* 写 width/height 会把变换矩阵重置成单位阵，所以尺寸变化的那一帧必须连 CSS 尺寸一起重设 */
    cv.style.width = `${g.w}px`;
    cv.style.height = `${g.h}px`;
  }
  ctx.setTransform(MINI.scale, 0, 0, MINI.scale, 0, 0);
  ctx.clearRect(0, 0, g.w, g.h);

  ctx.fillStyle = 'rgba(255,253,246,.92)';
  ctx.strokeStyle = '#4a3652';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(1, 1, g.w - 2, g.h - 2, 8);
  else ctx.rect(1, 1, g.w - 2, g.h - 2);
  ctx.fill();
  ctx.stroke();

  for (const cell of input.board) {
    const [cx, cy] = g.at(cell.id);
    ctx.fillStyle = miniColor(cell);
    ctx.fillRect(cx - MINI.cell / 2, cy - MINI.cell / 2, MINI.cell, MINI.cell);
    const owner = input.owners[cell.id];
    if (owner) {
      const p = input.players.find((x) => x.id === owner);
      ctx.strokeStyle = p ? hex(p.color) : '#888';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - MINI.cell / 2 + 0.5, cy - MINI.cell / 2 + 0.5, MINI.cell - 1, MINI.cell - 1);
    }
  }

  /* 宝箱按月换格、踩到才结算 —— 不画出来的话，玩家只在播报里见过「冒出一只宝箱」，
     却看不出它此刻压在哪一格。画在格子下半部，避开棋子那圈圆心。 */
  const treasure = input.treasureCellId;
  if (treasure !== null && treasure !== undefined) {
    const [cx, cy] = g.at(treasure);
    ctx.fillStyle = '#ffc44d';
    ctx.fillRect(cx - 2.2, cy + 0.8, 4.4, 3.2);
    ctx.strokeStyle = '#e39c17';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(cx - 2.2, cy + 0.8, 4.4, 3.2);
  }

  if (input.iso) {
    /* 可视范围 ≈ 宽 × (高/cos 俯角)，再按方位角转一下。世界层报上来的 aspect 已经夹过
       近景上限，自己按舞台宽高比算会在超宽屏上画出一个比实际看得见更宽的框。 */
    const aspect = input.cam.aspect || input.stageAspect || 1.4;
    const view2 = input.cam.view || 10.4;
    const w = view2 * aspect * g.k;
    const l = (view2 / Math.cos(ISO_ELEV)) * g.k;
    const [tx, ty] = g.world(input.cam.tx ?? 0, input.cam.tz ?? 0);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(((input.cam.az ?? 0) * Math.PI) / 180);
    ctx.fillStyle = 'rgba(255,196,77,.18)';
    ctx.strokeStyle = '#e39c17';
    ctx.lineWidth = 1.6;
    ctx.fillRect(-w / 2, -l / 2, w, l);
    ctx.strokeRect(-w / 2, -l / 2, w, l);
    ctx.restore();
  }

  for (const p of input.players) {
    const [cx, cy] = g.at(p.position);
    ctx.beginPath();
    ctx.arc(cx, cy, 3.1, 0, 6.3);
    ctx.fillStyle = '#fffdf6';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.3, 0, 6.3);
    ctx.fillStyle = hex(p.color);
    ctx.fill();
    if (p.id === input.activePid) {
      ctx.beginPath();
      ctx.arc(cx, cy, 4.4, 0, 6.3);
      ctx.strokeStyle = '#e39c17';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
  }
  return true;
}
