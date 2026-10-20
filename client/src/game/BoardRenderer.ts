import { Assets, Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { boardLayout, BOARD_SKIN, CHARACTERS, skinColor } from '@richman/shared';
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

/** 格子几何：与对局盘同一份皮肤（`shared/src/boardSkin.ts`），改格子尺寸只改那里 */
const TILE_W = BOARD_SKIN.iso.tilePx;
const TILE_H = TILE_W / 2;
const MOVE_SPEED_CELLS_PER_SEC = 6;

/** 美术 v6：深棕描边（全项目统一轮廓色） */
const OUTLINE_COLOR = 0x4a3222;
/** 美术 v6：瓦片平台挤出厚度（像素） */
const TILE_DEPTH = BOARD_SKIN.iso.depthPx;

/** 美术 v6 贴图清单（client/public/art 下，构建时静态拷贝） */
const ART_BASE = '/art';
const ART_FILES: Record<string, string> = {
  house1: 'env_house_lv1@v6.png',
  house2: 'env_house_lv2@v6.png',
  house3: 'env_house_lv3@v6.png',
  house4: 'env_house_lv4@v6.png',
  house5: 'env_house_lv5@v6.png',
  start: 'env_start@v6.png',
  chance: 'env_chance@v6.png',
  tax: 'env_tax@v6.png',
  hospital: 'env_hospital@v6.png',
  jail: 'env_jail@v6.png',
  shop: 'env_shop@v6.png',
  bank: 'env_bank@v6.png',
  news: 'env_news@v6.png',
  park: 'env_park@v6.png',
  mall: 'env_mall@v6.png',
  hotel: 'env_hotel@v6.png',
  gas: 'env_gas@v6.png',
  lab: 'env_lab@v6.png',
};

/**
 * 角色棋子贴图按 `characters.ts` 的 id 生成（`char_<id>@v6.png`）：
 * 以前是 char0~char3 四张按座位取，角色表扩到 10 人后座位序与图序就错开了，
 * 而 id 才是稳定键 —— 加人、改名都不用回来动这里。
 */
for (const c of CHARACTERS) ART_FILES[`char_${c.id}`] = `char_${c.id}@v6.png`;

/** 非地产格的示意图标（系统字体 emoji，无素材依赖；已有贴图的格不再使用） */
const CELL_ICONS: Partial<Record<BoardCell['type'], string>> = {
  god: '⛩️',
  game: '🎮',
  'free-card': '🎴',
  points: '🎫',
  lottery: '🎰',
  magic: '🔮',
  company: '🏢',
};

/* 配色不再自带一份：回放盘原先用的是另一套 Material 色板（青柠 / 橙 / 蓝灰），
   与对局盘的马卡龙色完全对不上 —— 同一副棋盘，回放里是一个样、对局里是另一个样。
   现在统一读 shared 的 `skinColor()`（＝小地图那条「有集团取集团色，否则按格型」的口径）。 */

/** 商业设施徽章（EST-07：五种建设项目） */
/**
 * 驻留神明的示意图标（W2）：纯表现，读 `GameState.boardGods` 画在格角上，
 * 不参与任何判定。图标一律用通用符号，不描摹原版形象。
 */
const GOD_MARKS: Record<string, { icon: string; color: number }> = {
  'land-god': { icon: '🏡', color: 0xa1887f },
  'big-wealth': { icon: '💰', color: 0xffd54f },
  'small-wealth': { icon: '🪙', color: 0xffe082 },
  'big-fortune': { icon: '🎐', color: 0x4dd0e1 },
  'small-fortune': { icon: '🍀', color: 0x81c784 },
  'big-poverty': { icon: '🕳️', color: 0x8d6e63 },
  'small-poverty': { icon: '💸', color: 0xa1887f },
  'big-misfortune': { icon: '🌩️', color: 0x7986cb },
  'small-misfortune': { icon: '🌧️', color: 0x90a4ae },
  angel: { icon: '😇', color: 0xce93d8 },
  devil: { icon: '😈', color: 0xe57373 },
  death: { icon: '☠️', color: 0x455a64 },
};

const FACILITY_MARKS: Record<FacilityType, { icon: string; color: number }> = {
  park: { icon: '🌳', color: 0x81c784 },
  mall: { icon: '🛍️', color: 0xffb74d },
  hotel: { icon: '🏨', color: 0xf06292 },
  gas: { icon: '⛽', color: 0x90a4ae },
  lab: { icon: '🔬', color: 0x4dd0e1 },
};

/**
 * 棋盘落位一律取 shared 的 `boardLayout`（地图自带坐标，与 3D 对局盘、右下小地图同一份），
 * 本文件只做「世界坐标 → 2:1 等距屏幕」的投影。
 *
 * 这里以前排的是一个「64 格方环」：先自带一份 `perimeterGrid()`，后来又换成 shared 里的方环函数。
 * 两次都错在同一件事 —— 四张地图各有 103 / 144 / 110 / 118 格、形状是沿路线铺开的不规则网，
 * 把 144 个格号硬排成方环，回放里看到的棋盘跟实战完全不是一张图。
 *
 * 定标：`boardLayout` 默认 `spacing = 2`（相邻格世界距离 = 2），而等距投影里一格的屏幕位移是
 * (±TILE_W/2, ±TILE_H/2)。所以世界 1 单位 = TILE_W/(2·spacing) 个屏幕像素，两个方向同式。
 */
const LAYOUT_SPACING = BOARD_SKIN.cell.mapStep;
const ISO_A = TILE_W / (2 * LAYOUT_SPACING);
const ISO_B = TILE_H / (2 * LAYOUT_SPACING);

function isoOf(x: number, z: number): { x: number; y: number } {
  return { x: (x - z) * ISO_A, y: (x + z) * ISO_B };
}

function cellColor(cell: BoardCell): number {
  return skinColor(cell);
}

/** 颜色变暗（乘法系数），用于瓦片侧面挤出 */
function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
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
  private tokens = new Map<string, { container: Container; ring: Graphics; displayIndex: number; targetIndex: number; phase: number }>();
  private board: BoardCell[];
  private container: HTMLElement;
  private destroyed = false;
  /** 棋盘没有地图坐标：不再重试初始化，也不渲染（避免每次 setState 都刷一条警告） */
  private noLayout = false;
  private elapsed = 0;
  private initializing = false;
  private initPromise: Promise<void> | null = null;
  private pendingGame: GameState | null = null;
  private boardBounds = { width: 0, height: 0 };
  /** 美术 v6：已加载的贴图（url → texture） */
  private textures = new Map<string, Texture>();
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
    /* 没有地图坐标就不画棋盘：这里以前会排一个 64 格方环顶替，结果 144 格的图被排成假的形状。
       回放数据来自真实对局，一定有坐标；走不到这一支时宁可空着也不编一个棋盘出来。 */
    const layout = boardLayout(this.board, LAYOUT_SPACING);
    if (!layout) {
      this.noLayout = true;
      console.warn('[BoardRenderer] 这副棋盘没有坐标（boardLayout 返回 null），不渲染');
      return;
    }
    this.initializing = true;
    const app = new Application();
    await app.init({
      background: 0x2e9fd8,
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

    // 美术 v6：预载贴图（缺图时逐张回退到原有图形表现，不阻塞初始化）
    await Promise.all(
      Object.values(ART_FILES).map(async (file) => {
        const url = `${ART_BASE}/${file}`;
        try {
          this.textures.set(url, await Assets.load<Texture>(url));
        } catch {
          // 贴图缺失不视为致命错误
        }
      }),
    );

    app.stage.addChild(this.world);
    this.world.addChild(this.cellLayer);
    this.world.addChild(this.overlayLayer);
    this.world.addChild(this.tokenLayer);

    // 地图坐标 → 等距屏幕坐标（先以原点为中心，渲染时整体居中）
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.board.length; i++) {
      const p = layout.cells[i]!;
      const { x, y } = isoOf(p.x, p.z);
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
      if (this.board.length && !this.initializing && !this.noLayout) {
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

  /** 美术 v6：按 key 取贴图生成精灵，缩放到目标高度；缺图返回 null（调用方回退图形表现） */
  private artSprite(key: string, heightPx: number): Sprite | null {
    const file = ART_FILES[key];
    if (!file) return null;
    const tex = this.textures.get(`${ART_BASE}/${file}`);
    if (!tex) return null;
    const sprite = new Sprite(tex);
    sprite.scale.set(heightPx / tex.height);
    sprite.anchor.set(0.5, 1);
    return sprite;
  }

  private drawCell(index: number): void {
    const cell = this.board[index]!;
    const pos = this.cellPositions[index]!;
    const tile = new Graphics();
    const halfW = TILE_W / 2;
    const halfH = TILE_H / 2;
    const base = cellColor(cell);
    // 美术 v6：厚平台——先画挤出侧面，再画顶面，统一深棕描边
    tile.poly([-halfW, 0, 0, halfH, halfW, 0, halfW, TILE_DEPTH, 0, halfH + TILE_DEPTH, -halfW, TILE_DEPTH]);
    tile.fill({ color: shade(base, 0.7) });
    tile.stroke({ width: 1.5, color: OUTLINE_COLOR });
    tile.poly([0, -halfH, halfW, 0, 0, halfH, -halfW, 0]);
    tile.fill({ color: base });
    tile.stroke({ width: 1.5, color: OUTLINE_COLOR });
    tile.position.set(pos.x, pos.y);
    this.cellLayer.addChild(tile);

    // 建筑贴图：功能格直接贴对应建筑；地产格的建筑等级由所有权图层负责
    const building = this.artSprite(String(cell.type), 46);
    if (building) {
      building.position.set(pos.x, pos.y + 8);
      this.cellLayer.addChild(building);
    }

    const land = isLand(cell);
    const hasBuilding = !!building;
    const label = new Text({
      text: cell.name,
      style: {
        fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif',
        fontSize: cell.type === 'start' ? 12 : 9,
        fill: 0xffffff,
        stroke: { color: OUTLINE_COLOR, width: 3 },
        fontWeight: cell.type === 'start' ? '700' : '500',
      },
    });
    label.anchor.set(0.5);
    label.position.set(pos.x, pos.y - (hasBuilding ? 54 : 22));
    this.cellLayer.addChild(label);

    const icon = CELL_ICONS[cell.type];
    if (icon && !hasBuilding) {
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
        style: {
          fontFamily: 'Consolas, monospace',
          fontSize: 8,
          fill: 0xf2e6c8,
          stroke: { color: OUTLINE_COLOR, width: 2 },
        },
      });
      price.anchor.set(0.5);
      price.position.set(pos.x, pos.y + 13);
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

        // 美术 v6：等级标记——直接用对应等级的住宅贴图（1~5 级），连锁店/设施用对应建筑
        const spriteKey = prop.chain
          ? 'shop'
          : cell?.type === 'commercial' && prop.facility
            ? String(prop.facility)
            : `house${Math.min(5, Math.max(1, prop.grade))}`;
        const building = this.artSprite(spriteKey, prop.chain || prop.facility ? 40 : 32 + prop.grade * 4);
        if (building) {
          building.position.set(pos.x, pos.y + 8);
          this.overlayLayer.addChild(building);
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

        // 商业设施（EST-07）：设施建筑贴图已在上方按 prop.facility 绘制，此处不再叠 emoji 徽章
      }
    }

    // 神明现身驻留（W2）：日切随机现身、经过即附身，所以玩家必须看得见哪一格站着哪一尊。
    // 画得比 NPC 标记高一点，避免同格时两个图标叠在一起。
    for (const god of game.boardGods) {
      const pos = this.cellPositions[god.cellId];
      if (!pos) continue;
      const mark = GOD_MARKS[god.godId] ?? { icon: '✨', color: 0xb0bec5 };
      const bg = new Graphics();
      bg.circle(pos.x + TILE_W / 2 - 7, pos.y - TILE_H / 2 + 5, 9);
      bg.fill({ color: 0x1b2a26, alpha: 0.85 });
      bg.stroke({ width: 1.5, color: mark.color });
      const icon = new Text({ text: mark.icon, style: { fontSize: 13 } });
      icon.anchor.set(0.5);
      icon.position.set(pos.x + TILE_W / 2 - 7, pos.y - TILE_H / 2 + 5);
      this.overlayLayer.addChild(bg);
      this.overlayLayer.addChild(icon);
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

    // TILE-31 宝箱（R5 起是驻留实体，不再是固定格）：按月换一处、走到才结算，
    // 所以玩家必须看得见它此刻在哪一格。摆在格子下沿，与上沿的 NPC、左上角的神明错开。
    if (game.treasureCellId !== null) {
      const pos = this.cellPositions[game.treasureCellId];
      if (pos) {
        const mark = new Text({ text: '🎁', style: { fontSize: 14 } });
        mark.anchor.set(0.5);
        mark.position.set(pos.x, pos.y + TILE_H / 2 - 6);
        this.overlayLayer.addChild(mark);
      }
    }
  }

  private syncTokens(game: GameState): void {
    let seat = 0;
    for (const player of game.players) {
      let token = this.tokens.get(player.id);
      if (!token) {
        token = this.createToken(player, seat);
        this.tokens.set(player.id, token);
      }
      seat += 1;
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

  private createToken(player: Player, seat: number): { container: Container; ring: Graphics; displayIndex: number; targetIndex: number; phase: number } {
    const container = new Container();
    // 美术 v6：脚下投影 + 玩家色识别盘 + 角色纸片人贴图（只出朝向单方向，左向由引擎镜像，这里为正面）
    const shadow = new Graphics();
    shadow.ellipse(0, 2, 10, 4.5);
    shadow.fill({ color: 0x0d1512, alpha: 0.45 });
    container.addChild(shadow);

    const disc = new Graphics();
    disc.circle(0, 2, 5.5);
    disc.fill({ color: player.color });
    disc.stroke({ width: 1.5, color: 0xffffff });
    container.addChild(disc);

    const character = this.artSprite(`char_${player.characterId}`, 30);
    if (character) {
      character.position.set(0, 4);
      container.addChild(character);
    } else {
      const circle = new Graphics();
      circle.circle(0, -8, 9);
      circle.fill({ color: player.color });
      circle.stroke({ width: 2.5, color: 0xffffff });
      container.addChild(circle);
    }

    const ring = new Graphics();
    ring.circle(0, 2, 15);
    ring.stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    ring.visible = false;
    container.addChild(ring);

    this.tokenLayer.addChild(container);
    return { container, ring, displayIndex: player.position, targetIndex: player.position, phase: seat * 1.3 };
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
      // 美术 v6：待机上下浮动（sin 缓动 ±1.5px，相位按座次错开）
      token.container.position.set(base.x, base.y - 12 + Math.sin(this.elapsed * 3 + token.phase) * 1.5);

      if (token.ring.visible) {
        const pulse = 1 + 0.18 * Math.sin(this.elapsed * 5);
        token.ring.scale.set(pulse);
      }
    }
  }
}