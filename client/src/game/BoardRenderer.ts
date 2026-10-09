import { Application, Container, Graphics, Text } from 'pixi.js';
import type { BoardCell, FacilityType, GameState, Player } from '@richman/shared';
import { getSettings, SETTINGS_CHANGED_EVENT } from './settings.js';

/** UI-09 速度设置：高/中/低三档映射为棋盘动画推进倍率 */
function animationSpeed(): number {
  switch (getSettings().gameSpeed) {
    case 'high':
      return 2;
    case 'low':
      return 0.5;
    default:
      return 1;
  }
}

/** 17×17 外圈 = 64 格（波 3 扩棋盘）；每边 16 步 + 4 个角 */
const GRID = 17;
const TILE_W = 64;
const TILE_H = 32;
const MOVE_SPEED_CELLS_PER_SEC = 6;

const GROUP_COLORS: Record<string, number> = {
  residential: 0x9ccc65,
  commercial: 0xffb74d,
  industrial: 0x90a4ae,
  tech: 0x4dd0e1,
  coastal: 0x64b5f6,
  financial: 0xba68c8,
};

/** 非地产格的示意图标（系统字体 emoji，无素材依赖） */
const CELL_ICONS: Partial<Record<BoardCell['type'], string>> = {
  start: '🏁',
  chance: '❓',
  tax: '🧾',
  hospital: '🏥',
  jail: '🚓',
  shop: '🛒',
  bank: '🏦',
  god: '⛩️',
  game: '🎮',
  'free-card': '🎴',
  points: '🎫',
  lottery: '🎰',
  magic: '🔮',
  treasure: '💰',
  news: '📰',
  company: '🏢',
};

const TYPE_COLORS: Partial<Record<BoardCell['type'], number>> = {
  start: 0xffe082,
  chance: 0xf48fb1,
  tax: 0xef9a9a,
  hospital: 0xf5f5f5,
  jail: 0xb0bec5,
  shop: 0xffcc80,
  bank: 0xa5d6a7,
  god: 0xb39ddb,
  commercial: 0xffe0b2,
  'free-card': 0xce93d8,
  points: 0xfff59d,
  lottery: 0xffab91,
  magic: 0xd1c4e9,
  treasure: 0xffd54f,
  news: 0xb0e0e6,
  company: 0xbcaaa4,
};

/** 商业设施徽章（EST-07：五种建设项目） */
const FACILITY_MARKS: Record<FacilityType, { icon: string; color: number }> = {
  park: { icon: '🌳', color: 0x81c784 },
  mall: { icon: '🛍️', color: 0xffb74d },
  hotel: { icon: '🏨', color: 0xf06292 },
  gas: { icon: '⛽', color: 0x90a4ae },
  lab: { icon: '🔬', color: 0x4dd0e1 },
};

/**
 * 外圈 64 格 → 等距网格坐标（顺时针）：
 * 0..16 底边右行（含右下角）→ 17..32 右边上行（含右上角）
 * → 33..48 顶边左行（含左上角）→ 49..63 左边下行。
 */
function perimeterGrid(index: number): { x: number; y: number } {
  const side = GRID - 1;
  if (index <= side) return { x: index, y: side };
  if (index <= side * 2) return { x: side, y: side - (index - side) };
  if (index <= side * 3) return { x: side - (index - side * 2), y: 0 };
  return { x: 0, y: index - side * 3 };
}

function cellColor(cell: BoardCell): number {
  if (cell.type === 'property' && cell.group) return GROUP_COLORS[cell.group] ?? 0xcfd8dc;
  return TYPE_COLORS[cell.type] ?? 0xcfd8dc;
}

function isLand(cell: BoardCell): boolean {
  return (cell.type === 'property' || cell.type === 'commercial') && cell.price !== undefined;
}

/** PixiJS 棋盘渲染器：只负责表现，不持有游戏规则 */
export class BoardRenderer {
  private app: Application | null = null;
  private world = new Container();
  private cellLayer = new Container();
  private overlayLayer = new Container();
  private tokenLayer = new Container();
  private cellPositions: { x: number; y: number }[] = [];
  private tokens = new Map<string, { container: Container; ring: Graphics; displayIndex: number; targetIndex: number }>();
  private board: BoardCell[];
  private container: HTMLElement;
  private destroyed = false;
  private elapsed = 0;
  private initializing = false;
  private initPromise: Promise<void> | null = null;
  private pendingGame: GameState | null = null;
  private boardBounds = { width: 0, height: 0 };
  /** UI-07：canvas 引用（解绑视口事件用） */
  private canvas: HTMLCanvasElement | null = null;
  /** UI-10：设置变更回调（解绑用） */
  private onSettingsChanged: (() => void) | null = null;
  /** UI-10 动画开关：随设置变化启停 ticker */
  private applyAnimationToggle(): void {
    if (!this.app) return;
    if (getSettings().animations) this.app.ticker.start();
    else this.app.ticker.stop();
  }

  /** UI-07 地图指令：用户缩放倍率（1 = 自适应满屏） */
  private viewZoom = 1;
  /** UI-07 地图指令：用户平移偏移（像素） */
  private viewPanX = 0;
  private viewPanY = 0;
  /** UI-07：拖拽平移状态 */
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginX = 0;
  private dragOriginY = 0;

  constructor(container: HTMLElement, board: BoardCell[]) {
    this.container = container;
    this.board = board;
  }

  async init(): Promise<void> {
    if (this.destroyed || this.initializing) return;
    if (!this.board.length) return;
    this.initializing = true;
    const app = new Application();
    await app.init({
      background: 0x121d16,
      antialias: true,
      resizeTo: this.container,
    });
    if (this.destroyed) {
      app.destroy(true, { children: true, texture: true });
      this.initializing = false;
      return;
    }
    this.app = app;
    this.container.appendChild(app.canvas);
    this.attachViewControls(app.canvas);

    app.stage.addChild(this.world);
    this.world.addChild(this.cellLayer);
    this.world.addChild(this.overlayLayer);
    this.world.addChild(this.tokenLayer);

    // 计算外圈格子的等距屏幕坐标（先以原点为中心，渲染时整体居中）
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.board.length; i++) {
      const g = perimeterGrid(i);
      const x = (g.x - g.y) * (TILE_W / 2);
      const y = (g.x + g.y) * (TILE_H / 2);
      this.cellPositions.push({ x, y });
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // 棋盘外接尺寸（含单格宽高），用于自适应缩放
    this.boardBounds = {
      width: maxX - minX + TILE_W,
      height: maxY - minY + TILE_H,
    };
    // 把世界原点移到棋盘几何中心，便于整体居中
    this.world.pivot.set((minX + maxX) / 2, (minY + maxY) / 2);

    for (let i = 0; i < this.board.length; i++) {
      this.drawCell(i);
    }

    // UI-09 速度设置：高/中/低三档作用于棋盘动画（行走、爆炸等）的推进速度
    app.ticker.add((ticker) => this.update(ticker.deltaMS * animationSpeed()));
    // UI-10 动画开关：关闭后 ticker 停止推进（静止棋盘）
    this.onSettingsChanged = () => this.applyAnimationToggle();
    window.addEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
    this.applyAnimationToggle();
    this.initializing = false;
  }

  setState(game: GameState): void {
    this.board = game.board;
    this.pendingGame = game;
    if (!this.app) {
      // 远程大厅阶段棋盘数据可能尚未同步，延迟到数据到达后再初始化
      if (this.board.length && !this.initializing) {
        this.initPromise = this.init().then(() => {
          if (this.pendingGame && this.app) {
            this.drawOwnershipOverlay(this.pendingGame);
            this.syncTokens(this.pendingGame);
          }
        });
      }
      return;
    }
    this.drawOwnershipOverlay(game);
    this.syncTokens(game);
  }

  /** UI-07：绑定滚轮缩放与拖拽平移，观察地图各角落 */
  private attachViewControls(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  private detachViewControls(): void {
    if (!this.canvas) return;
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas = null;
  }

  /** 恢复「自适应满屏」视图（UI-07 的「回到全图」按钮调用） */
  resetView(): void {
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(3, Math.max(1, this.viewZoom * factor));
    this.viewZoom = next;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragOriginX = this.viewPanX;
    this.dragOriginY = this.viewPanY;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.viewPanX = this.dragOriginX + (e.clientX - this.dragStartX);
    this.viewPanY = this.dragOriginY + (e.clientY - this.dragStartY);
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
  };

  destroy(): void {
    this.destroyed = true;
    this.detachViewControls();
    if (this.onSettingsChanged) {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
      this.onSettingsChanged = null;
    }
    if (this.app) {
      this.app.destroy(true, { children: true, texture: true });
      this.app = null;
    }
  }

  private drawCell(index: number): void {
    const cell = this.board[index]!;
    const pos = this.cellPositions[index]!;
    const tile = new Graphics();
    const halfW = TILE_W / 2;
    const halfH = TILE_H / 2;
    tile.poly([0, -halfH, halfW, 0, 0, halfH, -halfW, 0]);
    tile.fill({ color: cellColor(cell) });
    tile.stroke({ width: 1.5, color: 0x263238, alpha: 0.8 });
    tile.position.set(pos.x, pos.y);
    this.cellLayer.addChild(tile);

    const land = isLand(cell);
    const label = new Text({
      text: cell.name,
      style: {
        fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif',
        fontSize: cell.type === 'start' ? 12 : 9,
        fill: cell.type === 'start' ? 0x5d4037 : 0x263238,
        fontWeight: cell.type === 'start' ? '700' : '500',
      },
    });
    label.anchor.set(0.5);
    label.position.set(pos.x, pos.y - (land ? 5 : 0));
    this.cellLayer.addChild(label);

    const icon = CELL_ICONS[cell.type];
    if (icon) {
      const iconText = new Text({
        text: icon,
        style: { fontSize: 13 },
      });
      iconText.anchor.set(0.5);
      iconText.position.set(pos.x, pos.y + 6);
      this.cellLayer.addChild(iconText);
    }

    if (land) {
      const price = new Text({
        text: `¥${cell.price}`,
        style: { fontFamily: 'Consolas, monospace', fontSize: 8, fill: 0x455a64 },
      });
      price.anchor.set(0.5);
      price.position.set(pos.x, pos.y + 8);
      this.cellLayer.addChild(price);
    }
  }

  private drawOwnershipOverlay(game: GameState): void {
    this.overlayLayer.removeChildren();
    for (const player of game.players) {
      for (const prop of player.properties) {
        const pos = this.cellPositions[prop.cellId];
        if (!pos) continue;
        const cell = game.board[prop.cellId];
        const border = new Graphics();
        const halfW = TILE_W / 2 - 2;
        const halfH = TILE_H / 2 - 1;
        border.poly([0, -halfH, halfW, 0, 0, halfH, -halfW, 0]);
        border.stroke({ width: 3, color: player.color, alpha: 0.95 });
        border.position.set(pos.x, pos.y);
        this.overlayLayer.addChild(border);

        // 等级标记：最多 5 栋小屋（EST-02 扩至 5 级），间距随级数自适应
        const n = prop.grade;
        const step = n > 1 ? Math.min(16, 40 / (n - 1)) : 0;
        const totalW = step * (n - 1);
        for (let i = 0; i < n; i++) {
          const bx = pos.x - totalW / 2 + i * step;
          const house = new Graphics();
          house.rect(bx - 4, pos.y, 8, 5);
          house.fill({ color: 0xfff3e0 });
          house.stroke({ width: 1, color: 0x263238 });
          house.poly([bx - 5, pos.y, bx, pos.y - 6, bx + 5, pos.y]);
          house.fill({ color: player.color });
          house.stroke({ width: 1, color: 0x263238 });
          this.overlayLayer.addChild(house);
        }

        // 连锁店标记（EST-04）：改建卡改建而成的店面
        if (prop.chain) {
          const badge = new Text({
            text: '链',
            style: {
              fontFamily: 'Microsoft YaHei, sans-serif',
              fontSize: 9,
              fill: 0xffffff,
              fontWeight: '700',
            },
          });
          badge.anchor.set(0.5);
          const bg = new Graphics();
          bg.roundRect(pos.x - 7, pos.y - TILE_H / 2 - 8, 14, 12, 3);
          bg.fill({ color: player.color, alpha: 0.95 });
          bg.stroke({ width: 1, color: 0x263238 });
          badge.position.set(pos.x, pos.y - TILE_H / 2 - 2);
          this.overlayLayer.addChild(bg);
          this.overlayLayer.addChild(badge);
        }

        // 商业设施徽章（EST-07）
        if (cell?.type === 'commercial' && prop.facility) {
          const mark = FACILITY_MARKS[prop.facility];
          if (mark) {
            const badge = new Text({ text: mark.icon, style: { fontSize: 11 } });
            badge.anchor.set(0.5);
            const bg = new Graphics();
            bg.circle(pos.x + halfW - 6, pos.y + halfH - 4, 8);
            bg.fill({ color: mark.color });
            bg.stroke({ width: 1, color: 0x263238 });
            badge.position.set(pos.x + halfW - 6, pos.y + halfH - 4);
            this.overlayLayer.addChild(bg);
            this.overlayLayer.addChild(badge);
          }
        }
      }
    }

    // NPC 单位（波 8）：恶犬随机出没于棋盘；在押恶人显示在监狱格「牢」标记
    for (const npc of game.npcs) {
      const pos = this.cellPositions[npc.position];
      if (!pos) continue;
      const label = npc.kind === 'dog' ? '🐕' : npc.jailed ? '🔒' : '😈';
      const mark = new Text({
        text: label,
        style: { fontSize: 14 },
      });
      mark.anchor.set(0.5);
      mark.position.set(pos.x, pos.y - TILE_H / 2 - 4);
      this.overlayLayer.addChild(mark);
    }
  }

  private syncTokens(game: GameState): void {
    for (const player of game.players) {
      let token = this.tokens.get(player.id);
      if (!token) {
        token = this.createToken(player);
        this.tokens.set(player.id, token);
      }
      token.targetIndex = player.position;
      token.container.alpha = player.bankrupt ? 0.25 : 1;
      token.container.visible = true;
    }
    // 隐藏已不存在的玩家
    for (const [id, token] of this.tokens) {
      if (!game.players.some((p) => p.id === id)) token.container.visible = false;
    }

    const currentId = game.players[game.currentPlayerIndex]?.id;
    for (const [id, token] of this.tokens) {
      token.ring.visible = id === currentId && !(!currentId || game.phase === 'game_over');
    }
  }

  private createToken(player: Player): { container: Container; ring: Graphics; displayIndex: number; targetIndex: number } {
    const container = new Container();
    const circle = new Graphics();
    circle.circle(0, 0, 11);
    circle.fill({ color: 0x0d1512, alpha: 0.55 });
    circle.circle(0, 0, 9);
    circle.fill({ color: player.color });
    circle.stroke({ width: 2.5, color: 0xffffff });
    container.addChild(circle);

    const ring = new Graphics();
    ring.circle(0, 0, 14);
    ring.stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    ring.visible = false;
    container.addChild(ring);

    this.tokenLayer.addChild(container);
    return { container, ring, displayIndex: player.position, targetIndex: player.position };
  }

  private interpolatedPosition(displayIndex: number): { x: number; y: number } {
    const n = this.cellPositions.length;
    const i0 = Math.floor(displayIndex) % n;
    const i1 = (i0 + 1) % n;
    const t = displayIndex - Math.floor(displayIndex);
    const a = this.cellPositions[i0]!;
    const b = this.cellPositions[i1]!;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  private update(deltaMS: number): void {
    const app = this.app;
    if (!app) return;
    this.elapsed += deltaMS / 1000;

    // 棋盘居中 + 自适应缩放（64 格棋盘在窄容器里也能完整显示）
    // UI-07 地图指令：在此基础上叠加用户的缩放（wheel）与平移（拖拽）倍率
    const availW = Math.max(80, app.renderer.width - 24);
    const availH = Math.max(80, app.renderer.height - 96);
    const fitScale = Math.min(1, availW / this.boardBounds.width, availH / this.boardBounds.height);
    this.world.scale.set(fitScale * this.viewZoom);
    this.world.position.set(
      app.renderer.width / 2 + this.viewPanX,
      app.renderer.height / 2 + 12 + this.viewPanY,
    );

    const n = this.cellPositions.length || 1;
    const dt = deltaMS / 1000;
    for (const token of this.tokens.values()) {
      const forward = ((token.targetIndex - token.displayIndex) % n + n) % n;
      const backward = n - forward;
      // 走最短方向：顺时针路径更短向前，否则倒退（支持转向卡后的动画）
      const delta = forward <= backward ? forward : -backward;
      if (delta === 0) {
        token.displayIndex = ((token.displayIndex % n) + n) % n;
      } else {
        const move = Math.min(Math.abs(delta), dt * MOVE_SPEED_CELLS_PER_SEC) * Math.sign(delta);
        token.displayIndex = ((token.displayIndex + move) % n + n) % n;
      }
      const base = this.interpolatedPosition(token.displayIndex);
      token.container.position.set(base.x, base.y - 12);

      if (token.ring.visible) {
        const pulse = 1 + 0.18 * Math.sin(this.elapsed * 5);
        token.ring.scale.set(pulse);
      }
    }
  }
}