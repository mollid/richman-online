import { Application, Container, Graphics, Text } from 'pixi.js';
import type { BoardCell, GameState, Player } from '@richman/shared';

const GRID = 11;
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
  neutral: '🌳',
};

const TYPE_COLORS: Partial<Record<BoardCell['type'], number>> = {
  start: 0xffe082,
  chance: 0xf48fb1,
  tax: 0xef9a9a,
  hospital: 0xf5f5f5,
  jail: 0xb0bec5,
  neutral: 0xd7ccc8,
  shop: 0xffcc80,
  bank: 0xa5d6a7,
  god: 0xb39ddb,
};

function perimeterGrid(index: number): { x: number; y: number } {
  if (index <= 10) return { x: index, y: GRID - 1 };
  if (index <= 20) return { x: GRID - 1, y: GRID - 1 - (index - 10) };
  if (index <= 30) return { x: GRID - 1 - (index - 20), y: 0 };
  return { x: 0, y: index - 30 };
}

function cellColor(cell: BoardCell): number {
  if (cell.type === 'property' && cell.group) return GROUP_COLORS[cell.group] ?? 0xcfd8dc;
  return TYPE_COLORS[cell.type] ?? 0xcfd8dc;
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

    app.stage.addChild(this.world);
    this.world.addChild(this.cellLayer);
    this.world.addChild(this.overlayLayer);
    this.world.addChild(this.tokenLayer);

    // 计算外圈格子的等距屏幕坐标（先以原点为中心，渲染时整体居中）
    for (let i = 0; i < this.board.length; i++) {
      const g = perimeterGrid(i);
      this.cellPositions.push({ x: (g.x - g.y) * (TILE_W / 2), y: (g.x + g.y) * (TILE_H / 2) });
    }

    for (let i = 0; i < this.board.length; i++) {
      this.drawCell(i);
    }

    app.ticker.add((ticker) => this.update(ticker.deltaMS));
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

  destroy(): void {
    this.destroyed = true;
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
    label.position.set(pos.x, pos.y - (cell.type === 'property' ? 5 : 0));
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

    if (cell.type === 'property' && cell.price !== undefined) {
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
        const border = new Graphics();
        const halfW = TILE_W / 2 - 2;
        const halfH = TILE_H / 2 - 1;
        border.poly([0, -halfH, halfW, 0, 0, halfH, -halfW, 0]);
        border.stroke({ width: 3, color: player.color, alpha: 0.95 });
        border.position.set(pos.x, pos.y);
        this.overlayLayer.addChild(border);

        // 等级标记：1~3 栋小屋（屋顶颜色 = 拥有者颜色）
        for (let i = 0; i < prop.grade; i++) {
          const bx = pos.x - (prop.grade - 1) * 8 + i * 16;
          const house = new Graphics();
          house.rect(bx - 4, pos.y, 8, 5);
          house.fill({ color: 0xfff3e0 });
          house.stroke({ width: 1, color: 0x263238 });
          house.poly([bx - 5, pos.y, bx, pos.y - 6, bx + 5, pos.y]);
          house.fill({ color: player.color });
          house.stroke({ width: 1, color: 0x263238 });
          this.overlayLayer.addChild(house);
        }
      }
    }
  }

  private syncTokens(game: GameState): void {
    const active = game.players.filter((p) => !p.bankrupt);
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
    void active;
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

    // 棋盘居中（窗口尺寸变化时保持居中）
    this.world.position.set(app.renderer.width / 2, app.renderer.height / 2 - 40);

    const n = this.cellPositions.length || 1;
    const dt = deltaMS / 1000;
    for (const token of this.tokens.values()) {
      let diff = ((token.targetIndex - token.displayIndex) % n + n) % n;
      if (diff < 0.001) {
        diff = 0;
      } else {
        token.displayIndex = (token.displayIndex + Math.min(diff, dt * MOVE_SPEED_CELLS_PER_SEC)) % n;
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



