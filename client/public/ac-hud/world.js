/* 2.5D 世界层（three.js UMD，file:// 可直接开）
 * 只画「场」：底座、64 格棋盘、岛上装饰、棋子、骰子、光影、镜头。
 * 文字与气泡交给 overlay.js（Pixi），面板留在 DOM。
 * 数据从 globalThis.GAME_SNAPSHOT 读，本文件不含规则。 */
(function () {
  'use strict';
  const THREE = globalThis.THREE;
  /* ---------- 格子外观：唯一出处在 shared/src/boardSkin.ts ----------
     本文件是 <script> 直挂的 vanilla、不能 import，所以由 React 层在加载它之前把
     `globalThis.RICHMAN_BOARD_SKIN` 挂上（`installBoardSkin()`，见 AcHudLayer）。
     下面这几份 FALLBACK 只在「file:// 直接打开」这种没有注入源的场景用，
     数值必须与 shared 逐项一致 —— board_skin.test.ts 拿源码比对，漂了就红。 */
  const FALLBACK_CELL = {
    mapStep: 2, spacing: 2.0, tile: 1.86, radius: 0.28, depth: 0.08, bevel: 0.025,
    padGrow: 0.12, padDepth: 0.12, padTop: 0.07, padRadius: 0.16, rimHeight: 0.06,
  };
  const FALLBACK_GROUP_HEX = {
    residential: 0x8fd07a, commercial: 0x7ec8ef, industrial: 0xc9b48a,
    tech: 0xb7a6e6, coastal: 0x7fd8c8, financial: 0xf0b96a,
  };
  const FALLBACK_TYPE_HEX = {
    start: 0xffe08a, chance: 0xffd0e0, news: 0xdfe9ff, 'free-card': 0xe6e0ff,
    points: 0xfff0b8, lottery: 0xd6f2e6, magic: 0xf0d9ff,
    tax: 0xe8e2d2, hospital: 0xffe3e3, jail: 0xe3e6ee, game: 0xd9f0ff,
    shop: 0xffe6c8, bank: 0xf2ead2, god: 0xffd9a8, company: 0xd9c9a3, blank: 0xe9e6dc,
  };
  const SKIN = globalThis.RICHMAN_BOARD_SKIN || null;
  const GEOM = (SKIN && SKIN.cell) || FALLBACK_CELL;
  const GROUP_HEX = (SKIN && SKIN.group) || FALLBACK_GROUP_HEX;
  const TYPE_HEX = (SKIN && SKIN.type) || FALLBACK_TYPE_HEX;
  /** 格面边长 / 格厚 */
  const TILE = GEOM.tile;
  const DEPTH = GEOM.depth;
  /** 地图坐标 → 世界单位的缩放。默认 spacing/mapStep = 1，改 spacing 才真的会铺开 */
  const K = GEOM.spacing / GEOM.mapStep;
  const EMOJI = {
    start: '🏁', property: '🏠', commercial: '🏬', chance: '🎋', news: '📰', 'free-card': '🃏',
    points: '🎟️', lottery: '🎰', magic: '🔮', tax: '💼', hospital: '🏥',
    jail: '🚔', game: '🎮', shop: '🛍️', bank: '🏦', god: '⛩️', company: '🏢', blank: '▫️',
  };

  let renderer, scene, camera, host, state, view, S;
  let orthoCam = null, keyLight = null;
  let tileMeshes = [], decalByCell = new Map(), tokenGroups = new Map(), rimGroup = null;
  /* 选格模式（W3）：合法格用一圈实例化的绿环标出，非法格把格面压暗 —— 一帧一次 draw call，
     不能给 64 格各挂一个 mesh（本文件里已经为这件事写过一次教训：软件渲染下 64 次绘制吃掉近一半帧）。 */
  let pickOverlay = null, pickIds = [];
  /* 选「人」模式（W3-d）：候选玩家脚下套一圈绿环。环挂在 tokenGroups 的组上，
     所以棋子移动 / 传送时环跟着走，不用每帧重新对位。 */
  let pickPids = [];
  const pickPlayerRings = new Map();
  let treasureMesh = null;           // TILE-31 宝箱（驻留实体），按帧跟随 view.treasureCellId
  let groundY = 0.6;                 // 草地实际顶面高度，buildWorld 里按几何实测
  let tileTop = 0.55;                // 格子实际顶面高度，同样实测（bevel 会把它抬到 depth 之上）
  let geoTile, geoDecal, geoBase, geoRim, geoPad, disposed = false, raf = 0, ro = null, paused = false;
  let hoverCell = null, selCell = null;
  const cam = { az: 0, el: 46, dist: 70 };
  const target = new THREE.Vector3(0, 0, 0);
  const clock = { last: performance.now(), fps: 0, frames: 0, at: performance.now() };
  let hooks = {};

  /* ---------- 几何 ---------- */
  function roundedRect(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  const extrude = (w, h, r, d, bevel, bev = 0.05) => {
    const g = new THREE.ExtrudeGeometry(roundedRect(w, h, r), {
      depth: d, bevelEnabled: !!bevel, bevelSize: bev, bevelThickness: bev, bevelSegments: 1, curveSegments: 4,
    });
    g.rotateX(-Math.PI / 2);
    return g;
  };

  /* 世界布局（`view.layout`）：由 shared 的 `boardLayout` 按地图自带坐标换算，四张图每张都有。
     没有它就说明这副棋盘没坐标（引擎里那份 64 格自建盘，单测夹具）—— 那时不摆格子，
     不再伪造一个方环出来。 */
  let LAYOUT = null;

  /** 格子 → 世界坐标。形状全在 shared，本文件不排任何形状；K 只按皮肤把地图坐标换算成世界单位 */
  function cellPos(i) {
    const p = LAYOUT && LAYOUT.cells[i];
    return p ? { x: p.x * K, z: p.z * K } : { x: 0, z: 0 };
  }

  /* 岛体那一摞（海 / 浅滩 / 浪花 / 沙底 / 草地 / 树）尺寸是按 64 格小盘写死的。
     原版图按邻距定标后半径能到 54，不跟着放大格子就铺到海面之外、悬在空上。
     棋盘坐标乘了 K 之后，岛的半径也得跟着乘 —— 否则把 spacing 调大，格子就跑到海里去了。 */
  function islandK() {
    return LAYOUT ? Math.max(1, (LAYOUT.radius * K) / 22.6) : 1;
  }

  /* ---------- 贴面文字纹理 ---------- */
  /* 单格在默认镜头下只有 ~40px，字太小就成噪点。所以：emoji 减 2px、名字加到 40px 并加粗描边、
     地价改成底部胶囊（浅底深字，比描边字更抗底噪）。 */
  function tileTexture(cell, sub) {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 160;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 160, 160);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '64px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui';
    g.fillText(EMOJI[cell.type] || '▫️', 80, 48);
    const name = cell.name;
    /* 名字不再截断：字数多就降一档字号，5 字（房地产公司那种）也能整名显示 */
    const fs = name.length >= 6 ? 28 : name.length >= 5 ? 33 : 40;
    g.font = `800 ${fs}px "M PLUS Rounded 1c","PingFang SC","Microsoft YaHei",system-ui`;
    g.lineWidth = 9; g.strokeStyle = 'rgba(255,251,239,.96)'; g.fillStyle = '#4a3c28';
    g.strokeText(name, 80, 98); g.fillText(name, 80, 98);
    if (sub) {
      g.font = '900 30px "Nunito","M PLUS Rounded 1c",system-ui';
      const pw = Math.min(152, g.measureText(sub).width + 26), ph = 38;
      g.fillStyle = 'rgba(255,251,239,.94)';
      /* y 从 122 提到 110：canvas 只有 160 高，原来 122+40=162 会出血被裁掉半边，
         战略俯视下看不出来，近景里就是胶囊被切了一刀、还压到格子外面。 */
      const x = 80 - pw / 2, y = 110;
      if (g.roundRect) { g.beginPath(); g.roundRect(x, y, pw, ph, ph / 2); g.fill(); }
      else g.fillRect(x, y, pw, ph);
      g.fillStyle = '#7a6547';
      g.fillText(sub, 80, y + ph / 2 + 1);
    }
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  function pipTexture(n) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#fffbef'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#7a6547';
    const P = { 1: [[64, 64]], 2: [[40, 40], [88, 88]], 3: [[40, 40], [64, 64], [88, 88]],
      4: [[40, 40], [88, 40], [40, 88], [88, 88]],
      5: [[40, 40], [88, 40], [64, 64], [40, 88], [88, 88]],
      6: [[40, 36], [88, 36], [40, 64], [88, 64], [40, 92], [88, 92]] }[n];
    for (const [x, y] of P) { g.beginPath(); g.arc(x, y, 11, 0, 6.3); g.fill(); }
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* ---------- 程序化地面纹理 ----------
   * 环内草地 / 环外沙地原来都是一整块纯色平面。战略俯视下无所谓（一格上才几个像素），
   * 但近景等距会把地面放大到「1 世界单位 ≈ 70 屏幕像素」—— 纯色立刻读成一块塑料板。
   * 这里用 canvas 撒确定性噪点做贴图：不引外部资源、file:// 能跑、每次渲染完全一致。
   *
   * UV 不用手工映射：ExtrudeGeometry 顶面的 UV 直接取形状坐标（单位 = 世界单位），
   * 所以贴图天然就是「1 世界单位铺 1 张」，128px 的贴图约等于近景下的屏幕像素密度，
   * 既不会糊也不会摩尔纹。唯一必须做的是把 wrap 设成 RepeatWrapping ——
   * 形状坐标有负值，不设的话负 UV 会被钳到边缘、拉成放射状条纹。
   */
  function groundTexture(base, dots, count, cell) {
    const S = cell || 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, S, S);
    /* 固定种子的线性同余 —— Math.random() 会让每次刷新长得不一样，前后对比截图就失去意义 */
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < count; i++) {
      g.globalAlpha = 0.12 + rnd() * 0.26;
      g.fillStyle = dots[(rnd() * dots.length) | 0];
      const x = rnd() * S, y = rnd() * S, r = 0.8 + rnd() * 2.4;
      g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
    }
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  /* ---------- 场景 ---------- */
  function mat(hex, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({ color: hex, roughness: 0.78, metalness: 0.02 }, opts || {}));
  }

  /* 大批量同材质小物件走实例化：64 个奶油台座要是各建一个 Mesh，光它们就是 64 次 draw call，
     软件渲染下帧率直接腰斩。InstancedMesh 把整批压成 1 次。 */
  function instanced(geo, material, list, castShadow) {
    const m = new THREE.InstancedMesh(geo, material, list.length);
    const o = new THREE.Object3D();
    list.forEach((it, i) => {
      o.position.set(it.x, it.y, it.z);
      o.rotation.set(it.rx || 0, it.ry || 0, it.rz || 0);
      const s = it.s == null ? 1 : it.s;
      if (Array.isArray(s)) o.scale.set(s[0], s[1], s[2]); else o.scale.setScalar(s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = !!castShadow;
    m.receiveShadow = true;
    /* 实例化后几何包围球不含实例位移，默认视锥剔除会把整批误杀；这批本来就常驻视野，直接关掉 */
    m.frustumCulled = false;
    scene.add(m);
    return m;
  }

  /* 一家公司可能占两格（原版图就是如此）：贴面按 footprint 认公司，两格都印出同一家的面值，
     否则只有一格带价、另一格会被读成空地。缺 footprint 的旧快照退回单格。 */
  const companyOnCell = (cellId) =>
    state.companies.find((c) => (c.footprint && c.footprint.length ? c.footprint : [c.cellId]).includes(cellId));

  function buildWorld(S) {
    state = S.state; view = S.view;
    LAYOUT = view.layout && view.layout.cells ? view.layout : null;
    const IK = islandK();
    /* 机位初始化到默认近景（az45 / el35.3 / 视野 9.6）。不再有「俯视距离随棋盘半径放大」
       那一段 —— 那是为了让全盘装得下，近景不关心棋盘多大，只看周围几格。
       这里用赋值而不是累乘：重新挂载（换局）时不会越缩越近。 */
    Object.assign(cam, { az: ISO.az, el: ISO.el, dist: ISO.view });
    /* 重新挂载（dispose 后再 mount）时清空上一轮的容器，否则贴面 / 棋子会逐轮累积 */
    tileMeshes = []; decalByCell = new Map(); tokenGroups = new Map(); rimGroup = null; focusRing = null;
    /* 光环也属于上一轮那个 scene：留着引用会把环画进一个已经不渲染的场景里 */
    hoverSkirt = null; selSkirt = null;
    treasureMesh = null;   // 上一轮场景已经重建，旧盒子留在变量里会把宝箱画在一个不存在的格上
    /* 选格 / 选人的高亮也一样：它们属于**上一轮那个 scene**，留着引用会把绿环画进
       一个已经不渲染的场景里（换局后「进选格态却什么都看不见」就是这么来的）。 */
    pickOverlay = null; pickIds = []; pickPlayerRings.clear();
    scene = new THREE.Scene();
    /* 只有一台正交相机（近景等距）。远裁剪 800 是为了海面：岛外那张水平面半边有 270 多，
       相机自己摆在 140 之外，留在 260 会在远处切出一条直边 —— 比露底更像穿模。
       近裁剪 0.1，深度比 8000，格面与贴花之间 0.012 的间隙绰绰有余。 */
    orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 800);
    camera = orthoCam;

    scene.add(new THREE.HemisphereLight(0xd8f0ff, 0xf0e0bd, 0.95));
    const key = new THREE.DirectionalLight(0xfff3d6, 1.25);
    key.position.set(16, 30, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -34 * IK; key.shadow.camera.right = 34 * IK;
    key.shadow.camera.top = 34 * IK; key.shadow.camera.bottom = -34 * IK;
    key.shadow.camera.far = 120; key.shadow.radius = 3; key.shadow.bias = -0.0008;
    keyLight = key;
    scene.add(key, key.target);
    scene.add(new THREE.DirectionalLight(0xbfd8ff, 0.25).translateX(-14).translateY(12).translateZ(-10));

    /* ---------- 海 → 浅滩 → 岛 ----------
     * 参考图里那块棋盘是「浮在海上的一座岛」，不是一个悬空的板子。
     * 三层：深海面（大平面）→ 浅滩（比底座大一圈的青色台）→ 沙色底座。
     * 三层的顶面高度必须严格递增，并且浅滩顶要低于底座顶，否则近景下会看到
     * 浅滩的平面「盖住」底座侧面，整座岛读成一张纸。
     */
    const seaMap = groundTexture('#5cbbe2', ['#4aa6cf', '#8ed8f2', '#ffffff'], 260);
    /* 海面和岛体都是「一屏铺满」的大面，软件渲染下是纯填充率的账。
       MeshLambert 比 MeshStandard 省掉整套 PBR 的分段计算，对这种哑光大色块肉眼看不出差别。
       ---------- 海面尺寸：按「能拉到的最大视野」反推 ----------
       这块面**必须**比任何一帧能看到的地面都大，否则断口外面露出的是画布背后的舞台底色
       （浅蓝/浅绿），整块面板看着像「海被切掉了」—— 曾经的「拉远穿模」就是这么来的。
       现在视野上限只有 24 单位（≈12 格进深），按理 96×IK 就够；但注视点会被拖到棋盘边角、
       宽屏下横向再乘 1.5，所以仍然留 4 倍（半边 273）。它只是一个平面，铺大点几乎不要钱，
       而算漏一次就是一条横穿屏幕的直边。
       相机远裁剪面 800 也是为它留的：海面自己在远处被切一条边，比露底更像穿模。
       贴图 repeat 跟着放大同样的倍数，水纹密度不变。 */
    const SEA_SPAN = 96 * IK * 4;
    seaMap.repeat.set(4, 4);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(SEA_SPAN, SEA_SPAN),
      new THREE.MeshLambertMaterial({ map: seaMap }));
    sea.rotation.x = -Math.PI / 2; sea.position.y = -0.88; sea.receiveShadow = true;
    scene.add(sea);
    const shoal = new THREE.Mesh(extrude(45 * IK, 45 * IK, 6 * IK, 0.5, true),
      new THREE.MeshLambertMaterial({ color: 0x9ee0f5 }));
    shoal.position.y = -1.10; shoal.receiveShadow = true;   // 顶面 ≈ −0.55
    scene.add(shoal);

    /* 环岛浪花：贴在浅滩上、比岛体大一圈的白色薄环。
       岛的轮廓正是靠这一圈白线在近景里「读出来」的 —— 没有它，沙色岛体和青色浅滩会连成一片。 */
    const foam = new THREE.Mesh(extrude(40.8 * IK, 40.8 * IK, 5 * IK, 0.12, false),
      new THREE.MeshBasicMaterial({ color: 0xf4fdff, transparent: true, opacity: 0.85 }));
    foam.position.y = -0.62;         // 顶面 −0.50，略高于浅滩，读成贴着岛的一圈浪
    scene.add(foam);

    /* 沙色底座：铺程序化细砂纹理。纯色在近景下会读成一块塑料板 */
    const sandMap = groundTexture('#f7ebc9', ['#e8d6a8', '#fff6dd'], 300);
    geoBase = extrude(39 * IK, 39 * IK, 5 * IK, 1.6, true);
    const base = new THREE.Mesh(geoBase, new THREE.MeshLambertMaterial({ map: sandMap }));
    base.position.y = -1.6; base.receiveShadow = true;
    scene.add(base);

    // 中央草地
    const grassMap = groundTexture('#9ad985', ['#7fbf68', '#b6e6a2'], 340);
    const grass = new THREE.Mesh(extrude(28.6 * IK, 28.6 * IK, 4 * IK, 0.55, true),
      new THREE.MeshLambertMaterial({ map: grassMap }));
    grass.position.y = -0.02; grass.receiveShadow = true;
    scene.add(grass);

    /* 中央岛心广场 —— 环内 28×28 原本是一整片空草地（约 60% 的台面没有信息）。
       加沙径外环 + 十字小径 + 木告示牌 + 骰盘，把中心变成「有东西可看」的区域。
       高度按几何实测顶面推 —— ExtrudeGeometry 的 bevel 会把实际顶面抬到 depth 之上，
       写死 0.53/0.54 会被草地盖住（实测就是这样丢的）。 */
    groundY = new THREE.Box3().setFromObject(grass).max.y;
    /* 原版图的路径会穿过岛的内陆，而草地台顶面是算出来的（实测 0.53），比格面高 ——
       实测潮汕有六成格子整块埋在草里，全盘看下去只剩沙带上零星几格。
       带自带坐标的图一律把草地降到「沙面之上、奶油台座面之下」这条窄缝里：
       内陆读成一块平的公园绿地，格子永远浮在草上面。
       必须在广场 / 小径 / 树之前做，它们的高度全是从 `groundY` 推的。
       ⚠️ 目标高度必须从皮肤推，不能写死数字：格子压扁到 depth 0.08 之后格面只有 0.105，
       老版本写死的 0.12 比格面还高，于是内陆格子又被整块埋掉 —— 近景只剩草地和树，
       一个格子都看不见（主子截图就是这个）。 */
    if (LAYOUT && groundY > 0.4) {
      /* 0.008：刚好低于奶油台座顶（0.07）而高于沙面（0.05）。
         从俯视角看，台座是看它的**顶面**，所以被草淹到 0.062 仍然露出完整一圈奶油边；
         格子只露顶上那 0.04 的厚度，读起来就是「画在地上的一格」。 */
      const grassTop = GEOM.padTop - 0.008;
      const sink = groundY - grassTop;
      if (sink > 0) { grass.position.y -= sink; groundY -= sink; }
    }
    /* ---------- 岛心装置：暂时留空 ----------
     * 这里原来是岛心广场（沙色圆台 + 外环）、四条十字小径、一块写着「中央岛 / 奖池」的木告示牌，
     * 以及岛内装饰。现在全部清掉，岛心就是一块平的草地 ——
     * 等按地图数据重新排（广场放哪、路怎么走、牌子立在哪，都该由地图决定）。
     *
     * 保留的只有地形本身：海 / 浅滩 / 浪花 / 沙底 / 草地，加上棋盘与棋子。
     * `groundY`（草地顶面的实测高度）仍然要算：桌上的骰盘、宝箱、棋子落位都从它推。
     *
     * 岛内装饰（树 / 灌木 / 草丛 / 民居 / 池塘 / 礁石）在上一版就整段删了：那套坐标是按
     * 「64 格环」这个假形状排的，换成自带坐标的原版图之后只会长在格子上。
     * 重画时注意两条（都是踩过的）：
     * - 装饰不许压在格子上：格子压扁后格面只有 0.105 高，树冠压上去就把名字价签吞了；
     * - 比格子宽的东西（池塘那类）必须最后放，且同时避开格子 / 已有的树 / 房子。
     */

    // 64 格
    geoTile = extrude(TILE, TILE, GEOM.radius, DEPTH, true, GEOM.bevel);
    geoTile.computeBoundingBox();
    tileTop = geoTile.boundingBox.max.y;   // 实测：bevel 让顶面高于 DEPTH（写死 DEPTH 会把贴面埋进格子里）
    /* 奶油台座：参考图里每格外围有一圈白边，格子像是坐在一只奶油小碟上 —— 近景下这圈白边
       是「棋盘」和「地面」之间唯一的视觉分隔，没有它，草地色的格子和草地会糊成一片。
       宽度上限由皮肤钉着：台座总宽（tile + padGrow）必须小于 spacing，
       否则邻格台座互相插进去。默认 1.86 + 0.12 = 1.98，留一条 0.02 的缝正好连成奶油线。
       高度上限：沙面在 y=0.05，台座顶抬到 padTop 就只露一条边，不会把格子架空。 */
    const PAD = Math.min(TILE + GEOM.padGrow, GEOM.spacing * 0.999);
    geoPad = extrude(PAD, PAD, GEOM.padRadius, GEOM.padDepth, true, GEOM.bevel);
    geoPad.computeBoundingBox();
    geoPad.translate(0, -geoPad.boundingBox.max.y + GEOM.padTop, 0);
    /* 持有者色环：贴在台座上沿的一圈彩色裙边（与台座同宽）。
       上限同样是 spacing —— 环再宽就会与邻格的环相撞。 */
    geoRim = new THREE.BoxGeometry(PAD, GEOM.rimHeight, PAD);
    geoDecal = new THREE.PlaneGeometry(TILE, TILE);
    geoDecal.rotateX(-Math.PI / 2);
    /* 台座 64 个同材质 → 实例化成 1 次 draw call（关键：软件渲染下 64 次会吃掉近一半帧） */
    instanced(geoPad, mat(0xfffbef, { roughness: 0.9 }),
      state.board.map((c) => { const p = cellPos(c.id); return { x: p.x, y: 0, z: p.z }; }), false);
    for (const cell of state.board) {
      const { x, z } = cellPos(cell.id);
      const hex = cell.group && GROUP_HEX[cell.group] !== undefined ? GROUP_HEX[cell.group] : (TYPE_HEX[cell.type] ?? 0xfffbef);
      const m = new THREE.Mesh(geoTile, mat(hex, { roughness: 0.7 }));
      m.position.set(x, 0, z);
      m.receiveShadow = true; m.castShadow = true;
      m.userData.cellId = cell.id;
      /* 记住本色：压暗 / 还原都以它为基准，否则第二次进选格态会在"已经暗掉的色"上再乘一次 */
      m.userData.baseHex = hex;
      scene.add(m); tileMeshes.push(m);

      const price = cell.price ? Math.round(cell.price * view.priceIndex) : 0;
      const corp = companyOnCell(cell.id);
      const sub = corp ? `🔔${corp.sharePrice}` : (cell.price ? `${price}` : '');
      const decal = new THREE.Mesh(geoDecal, new THREE.MeshBasicMaterial({
        map: tileTexture(cell, sub), transparent: true, depthWrite: false,
      }));
      decal.position.set(x, tileTop + 0.012, z);
      decal.renderOrder = 2;
      scene.add(decal); decalByCell.set(cell.id, decal);

      if (state.boardGods.some((g) => g.cellId === cell.id)) {
        /* 神明格的光晕：半径必须 < 半格（0.93），否则会在近景里漫出格面、盖住奶油台座。
           0.45·TILE = 0.837，留在格面之内，读成「这格有神」而又不夺走格面文字。 */
        const glow = new THREE.Mesh(new THREE.CircleGeometry(TILE * 0.45, 22),
          new THREE.MeshBasicMaterial({ color: 0xffd45e, transparent: true, opacity: 0.4 }));
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(x, tileTop + 0.006, z); glow.renderOrder = 1;
        scene.add(glow);
      }
    }
    paintOwners();
    buildSkirts();

    buildTokens();
    buildDice();
    buildFocusRing();
  }

  /* TILE-31 宝箱（R5 起是驻留实体，不再是某一格的格型）：按月换一处、走到才结算，
     所以它必须画在**当前那一格**上，而不是画死在棋盘里。场上没有宝箱就藏起来。 */
  function syncTreasure() {
    const cellId = view.treasureCellId;
    if (cellId === null || cellId === undefined) {
      if (treasureMesh) treasureMesh.visible = false;
      return;
    }
    if (!treasureMesh) {
      treasureMesh = new THREE.Mesh(
        new THREE.BoxGeometry(TILE * 0.44, TILE * 0.3, TILE * 0.34),
        new THREE.MeshLambertMaterial({ color: 0xd9a227 }),
      );
      treasureMesh.castShadow = true;
      scene.add(treasureMesh);
    }
    const { x, z } = cellPos(cellId);
    treasureMesh.position.set(x, tileTop + TILE * 0.15, z);
    treasureMesh.visible = true;
  }

  /* ---------------- 棋盘上的「会咬人的东西」（W3-c） ----------------
   * 路障 / 地雷 / 挂身炸弹 / 恶人 / 乞丐都不是地皮也不是玩家，但它们**占格、会被踩到**，
   * 玩家看不见它们就会做出完全错误的判断（往埋了雷的方向走、不知道谁身上挂着炸弹）。
   * 位置、主人、剩余步数全部来自快照的 `view.entities`（引擎真值），这里只决定怎么画。
   *
   * 三条口径：
   * - 圆盘描边 = **放置者 / 携带者色**，和地皮台座同一个语言：一眼看出「这东西是谁的」；
   * - 一图一材质太贵，纹理按 `emoji+副标+描边色` 缓存，同帧内重复的直接复用；
   * - 同一格上的多个实体用固定偏移散开，免得路障和乞丐叠成一坨。 */
  const ENT_EMOJI = {
    roadblock: '🚧', mine: '💥', bomb: '💣', beggar: '🥣',
    thief: '🗡️', protection: '🥊', robber: '🔨', 'rent-thief': '👺', dog: '🐕',
  };
  const ENT_OFF = [[0, 0], [0.56, 0], [0, 0.56], [-0.56, 0], [0, -0.56]];
  let entityGroup = null;
  const entTexCache = new Map();

  function entTexture(emoji, sub, ringCss) {
    const key = `${emoji}|${sub}|${ringCss}`;
    const hit = entTexCache.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = 160; c.height = 160;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 160, 160);
    g.beginPath(); g.arc(80, 72, 56, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,251,239,.95)'; g.fill();
    g.lineWidth = 9; g.strokeStyle = ringCss; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '60px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui';
    g.fillText(emoji, 80, sub ? 64 : 74);
    if (sub) {
      g.font = `800 ${sub.length >= 4 ? 24 : 30}px "M PLUS Rounded 1c","PingFang SC","Microsoft YaHei",system-ui`;
      g.lineWidth = 8; g.strokeStyle = 'rgba(255,251,239,.96)'; g.fillStyle = '#4a3c28';
      g.strokeText(sub, 80, 140); g.fillText(sub, 80, 140);
    }
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    entTexCache.set(key, t);
    return t;
  }

  function syncEntities() {
    if (entityGroup) { scene.remove(entityGroup); entityGroup = null; }
    const E = view.entities;
    if (!E) return;
    entityGroup = new THREE.Group();
    const seen = new Map();
    /** @param {number} lift 相对格面的高度：地上的东西贴着格，挂身炸弹要浮在名牌上方 */
    const put = (cellId, emoji, sub, ringCss, lift, size) => {
      if (cellId === null || cellId === undefined || cellId < 0) return;
      const n = seen.get(cellId) || 0;
      seen.set(cellId, n + 1);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: entTexture(emoji, sub, ringCss), transparent: true, depthWrite: false,
      }));
      const { x, z } = cellPos(cellId);
      const off = ENT_OFF[Math.min(n, ENT_OFF.length - 1)];
      sp.position.set(x + off[0], tileTop + lift, z + off[1]);
      sp.scale.set(TILE * size, TILE * size, 1);
      sp.renderOrder = 5;
      sp.userData.ent = { cellId, emoji, sub };
      entityGroup.add(sp);
    };
    for (const o of E.obstacles) put(o.cellId, ENT_EMOJI[o.kind], '', cssOf(o.ownerId), 0.62, 0.52);
    for (const b of E.bombs) put(b.cellId, ENT_EMOJI.bomb, `剩${b.stepsLeft}`, cssOf(b.playerId), 2.45, 0.46);
    for (const n of E.npcs) { if (!n.jailed) put(n.cellId, ENT_EMOJI[n.kind] ?? '❓', n.name, '#8b6a3c', 0.95, 0.56); }
    for (const q of E.beggars) put(q.cellId, ENT_EMOJI.beggar, q.name, cssOf(q.playerId), 0.9, 0.56);
    scene.add(entityGroup);
  }

  /* 持有者标色：早前把「着色块」放在 y=0.06 和「描边」放在 y=-0.03，都埋在格子体内，等于没画。
     改成在格子下半部套一圈更宽的彩色台座（plinth）—— 从外面能看见一圈持有者色的裙边。 */
  /* ---------- 互动裙边 ----------
   * 选中 / 悬停**不靠抬高格子，也不是浮在半空的环**：用和「持有者色裙边」同一套语言，
   * 在那格底下套一圈贴地的彩色带 —— 选中奶油金、悬停纯白。
   * 语义一致：占据这一格的东西（地主 / 光标 / 选中）都用「裙边」表达，位置也一致。
   *
   * 三个细节：
   * - 带宽与台座同宽（＝持有者裙边的宽度），横向只放大 0.8%：格距 2.0、台座 1.98，
   *   再宽就没有缝了，邻格的裙边会插进来。
   * - 高度就取 `rimHeight`，顶面刚好齐格面 —— 这是**上限**，不是随便挑的数。
   *   想靠「做高一点更显眼」会让顶面高过格面、把整格吞掉（名字与价签全被盖住），
   *   等于把「点击挡住格子信息」这个老毛病原样复发。显眼靠颜色与自发光，不靠长高。
   * - 高度从 `padTop` 起算，只比台座顶高一丁点 —— 它是一条裙边，不是一个盘子。
   * 早前那版是 `RingGeometry` 浮在格面之上，读起来像悬空的准星，与裙边语言不符。 */
  let hoverSkirt = null, selSkirt = null;

  function buildSkirts() {
    /* 与台座同宽的带宽：PAD 是 buildWorld 里的局部量，这里按同一口径重算一份，
       不引新常量（否则皮肤改了两处口径又要各改一次） */
    const w = Math.min(TILE + GEOM.padGrow, GEOM.spacing * 0.999);
    /* 几何与「可点格绿裙边」同规格：顶面齐格面，不许高过它（原因见上面那段） */
    const geoSkirt = new THREE.BoxGeometry(w, GEOM.rimHeight, w);
    const mk = (color, yOff) => {
      const m = new THREE.Mesh(geoSkirt, new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0 }));
      m.scale.set(1.008, 1, 1.008);
      m.userData.yOff = yOff;      // 两条互相让开一点，压在同一个高度会 z-fighting
      m.visible = false;
      scene.add(m);
      return m;
    };
    hoverSkirt = mk(0xffffff, 0.004);
    selSkirt = mk(0xffa726, 0.006);
    /* 悬停不做呼吸（鼠标一直在动，再脉动会晃眼），只给一档常亮，让它从奶油台座上跳出来 */
    hoverSkirt.material.emissiveIntensity = 0.5;
  }

  /** 把一条裙边挪到某一格；`id` 为 null 就藏起来 */
  function placeSkirt(skirt, id) {
    if (!skirt) return;
    if (id === null || id === undefined) { skirt.visible = false; return; }
    const p = cellPos(id);
    skirt.position.set(p.x, GEOM.padTop + (skirt.userData.yOff || 0.002), p.z);
    skirt.visible = true;
  }

  function paintOwners() {
    if (!rimGroup) { rimGroup = new THREE.Group(); scene.add(rimGroup); }
    rimGroup.clear();
    for (const cell of state.board) {
      const decal = decalByCell.get(cell.id);
      const pid = view.owners[cell.id];
      if (!pid) { if (decal) decal.position.y = tileTop + 0.012; continue; }
      const { x, z } = cellPos(cell.id);
      const plinth = new THREE.Mesh(geoRim, mat(new THREE.Color(cssOf(pid)), { roughness: 0.55 }));
      /* 裙边中心对齐台座顶面（而不是写死 0.085）—— 换了皮肤之后高度必须跟着走，
         否则格子一贴地，这道色环就会整条浮在半空。 */
      plinth.position.set(x, GEOM.padTop, z);
      plinth.castShadow = true;
      rimGroup.add(plinth);
      if (decal) decal.position.y = tileTop + 0.012;
    }
  }

  function cssOf(playerId) {
    const p = state.players.find((x) => x.id === playerId);
    return p ? `#${p.color.toString(16).padStart(6, '0')}` : '#888888';
  }

  /* ---------- 人物 ----------
   * 原来是「胶囊身体 + 白球头」，在战略俯视里只是个带色的点，够用。
   * 近景等距下它会占掉画面的很大一块，木桩感就很明显 —— 所以补成有辨识度的小人：
   * 腿 / 身体（玩家色）/ 手臂 / 头 / 眼睛 / 棒球帽 + 接触阴影。
   *
   * 面朝观众：整体 yaw 跟着 cam.az 走。局部 +Z 经过 yaw 旋转后正好映射到 (sin az, 0, cos az)，
   * 也就是「注视点 → 相机」的方向，所以无论用户把方位角转到哪，眼睛永远朝着屏幕。
   */
  /* 头部仰角：等距镜头俯视 35.264°，角色的脸法线（水平朝观众）与「角色→相机」方向正好差 35°，
     也就是说**正视的头在等距下只能看到头顶**。把头单独抬起来 ~20° 是让脸露出来的最小代价，
     再大就开始像在仰头看天。头/眼/嘴/帽装进一个 pivot 里一起转，脸就不会各转各的。
     注：R_x(θ) 作用在 +Z（脸的方向）上得到 (0, −sinθ, cosθ)，所以要抬头得用负角。 */
  const HEAD_TILT = -0.34;
  let figGeo = null;
  function figureGeometries() {
    if (figGeo) return figGeo;
    const R = 0.27, EYE_X = 0.094, MOUTH_Y = -0.10;
    /* 眼睛不能凭感觉给 z：球面上 y 偏移为 0 的那一圈半径就是 R，再由 x=±0.088 反解 z，
       才会正好贴在脸皮上往外鼓一点点。随手写小一点会把眼珠埋进球里、整张脸看不见。
       嘴在 y=−0.10 那一圈上，半径是 √(R²−0.10²)，同样反解。 */
    const EYE_Z = Math.sqrt(R * R - EYE_X * EYE_X);
    const MOUTH_Z = Math.sqrt(Math.max(0.0001, R * R - MOUTH_Y * MOUTH_Y));
    const headY = tileTop + 1.19;
    figGeo = {
      leg: new THREE.CapsuleGeometry(0.085, 0.15, 3, 8),
      hip: new THREE.CylinderGeometry(0.222, 0.205, 0.13, 14),
      body: new THREE.CapsuleGeometry(0.225, 0.24, 4, 12),
      arm: new THREE.CapsuleGeometry(0.066, 0.24, 3, 8),
      hand: new THREE.SphereGeometry(0.072, 10, 8),
      head: new THREE.SphereGeometry(R, 18, 14),
      eye: new THREE.SphereGeometry(0.058, 10, 8),
      mouth: new THREE.SphereGeometry(0.05, 10, 8),
      /* 半球当帽顶，半径比头大一点点才包得住，且整体上移 —— 压到眼睛高度就是一顶遮脸的钢盔 */
      cap: new THREE.SphereGeometry(R + 0.012, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.46),
      /* 帽檐：位置必须给到球外。原来放在 (0.125, 0.165)，到球心只有 0.207 < R=0.27，
         整个檐埋进头里 —— 帽顶就成了一颗光头。现在推到 z=0.275（前沿伸到头外 0.135），
         后半段仍埋在头/帽壳里，所以不会「悬空飘着一块板」。 */
      visor: new THREE.BoxGeometry(0.30, 0.030, 0.26),
      shadow: new THREE.CircleGeometry(0.34, 18),
      headY,
      eyeX: EYE_X, eyeY: 0, eyeZ: EYE_Z,
      mouthX: 0, mouthY: MOUTH_Y, mouthZ: MOUTH_Z,
      capY: 0.082, visorY: 0.115, visorZ: 0.275,
    };
    return figGeo;
  }

  function buildTokens() {
    const G = figureGeometries();
    const skin = mat(0xffe6c4, { roughness: 0.6 });
    const dark = mat(0x3b3026, { roughness: 0.45 });
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2 });
    /* 人偶身高（头顶到格顶）：广告牌贴图按这个值对齐，名牌锚点在 tileTop+1.8 */
    const TOKEN_H = 1.5;
    const OFFSETS = [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]];
    const byCell = new Map();
    for (const p of state.players) {
      const list = byCell.get(p.position) || [];
      list.push(p); byCell.set(p.position, list);
    }
    for (const p of state.players) {
      const g = new THREE.Group();
      /* 3D 人偶整体装进 puppet：贴图加载成功后把它整组隐藏，缺图时它继续当兜底表现 */
      const puppet = new THREE.Group();
      g.add(puppet);
      const cloth = mat(new THREE.Color(p.color), { roughness: 0.5 });
      /* 手臂用略深一档的玩家色：同色时手臂会和躯干糊成一整块，近景下看不出人形 */
      const clothDark = mat(new THREE.Color(p.color).multiplyScalar(0.86), { roughness: 0.55 });
      const put = (geo, material, x, y, z, rz) => {
        const m = new THREE.Mesh(geo, material);
        m.position.set(x, y, z);
        if (rz) m.rotation.z = rz;
        m.castShadow = true;
        puppet.add(m); return m;
      };
      for (const dx of [-0.115, 0.115]) put(G.leg, dark, dx, tileTop + 0.165, 0);
      put(G.hip, dark, 0, tileTop + 0.30, 0);
      put(G.body, cloth, 0, tileTop + 0.63, 0);
      for (const dx of [-0.235, 0.235]) {
        const rz = dx < 0 ? 0.13 : -0.13;
        /* 手臂压低到躯干中段、手落到髋部高度：原来手臂吊在胸口、手贴在臂中，
           近景下读成「两只朝外支着的桩」。现在是一双自然垂在身侧的手。 */
        put(G.arm, clothDark, dx, tileTop + 0.60, 0, rz);
        /* 手单独给肤色：手臂和身体同色时，整条胳膊会和躯干糊成一块，近景看不出人形 */
        put(G.hand, skin, dx + Math.sign(dx) * 0.013, tileTop + 0.40, 0, rz);
      }
      /* 头整组装进 pivot 一起抬头，脸才不会各转各的 */
      const pivot = new THREE.Group();
      pivot.position.set(0, G.headY, 0);
      pivot.rotation.x = HEAD_TILT;
      const hp = (geo, material, x, y, z) => {
        const m = new THREE.Mesh(geo, material);
        m.position.set(x, y, z);
        m.castShadow = true;
        pivot.add(m); return m;
      };
      hp(G.head, skin, 0, 0, 0);
      for (const dx of [-G.eyeX, G.eyeX]) hp(G.eye, dark, dx, G.eyeY, G.eyeZ);
      const mouth = hp(G.mouth, dark, G.mouthX, G.mouthY, G.mouthZ);
      mouth.scale.set(1.15, 0.42, 0.5);
      hp(G.cap, cloth, 0, G.capY, 0);
      const visor = hp(G.visor, cloth, 0, G.visorY, G.visorZ);
      visor.rotation.x = 0.14; visor.castShadow = false;
      puppet.add(pivot);

      const shadow = new THREE.Mesh(G.shadow, shadowMat);
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = tileTop + 0.018;
      g.add(shadow);

      /* 角色贴图广告牌（美术 v6 的 char_<id>@v6.png）：Sprite 恒正对相机，所以不吃
         `g.rotation.y` 的转身摆动。贴图到位才隐藏人偶；加载失败就把 Sprite 摘掉，
         人偶留下兜底 —— 这个文件不参与 typecheck，宁可退回旧表现也不能画出一个看不见的棋子。 */
      if (p.characterId) {
        const spMat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
        const sp = new THREE.Sprite(spMat);
        /* 交付是 256 方图且主体占满高度，所以宽高同值 = 主体正好 TOKEN_H 高、脚落在格顶 */
        sp.scale.set(TOKEN_H, TOKEN_H, 1);
        sp.position.set(0, tileTop + TOKEN_H / 2, 0);
        /* renderOrder 必须高于格子贴面（价格牌与房子图标是 2）：Sprite 不写深度，
           同层排序下它会先被画掉，接着贴面糊在人物身上 —— 低俯角时看着就像棋子穿进格子里。
           原来的 3D 人偶是不透明体、自己写深度，所以没这个问题；换广告牌时这层保护是丢掉的。
           6 也高于实体标记（NPC/乞丐 5），棋子永远压过它们。 */
        sp.renderOrder = 6;
        g.add(sp);
        g.userData.sprite = sp;   // 动画循环拿它做呼吸（人偶兜底时没有这个键）
        new THREE.TextureLoader().load(`/art/char_${p.characterId}@v6.png`, (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          spMat.map = t;
          spMat.needsUpdate = true;
          puppet.visible = false;
        }, undefined, () => { g.remove(sp); });
      }

      const list = byCell.get(p.position);
      const k = list.indexOf(p);
      const { x, z } = cellPos(p.position);
      const [ox, oz] = list.length > 1 ? OFFSETS[k % 4] : [0, 0];
      g.position.set(x + ox, 0, z + oz);
      g.userData.pid = p.id; g.userData.phase = k * 1.7;
      g.userData.yaw = THREE.MathUtils.degToRad(cam.az);
      g.rotation.y = g.userData.yaw;
      scene.add(g); tokenGroups.set(p.id, g);
    }
  }

  let diceGroup;
  /* 骰子边长。1.15 是「骰子搁在岛心骰盘里、镜头离得很远」时的尺寸；
     搬到角色脚边之后，近景把同样的尺寸放大三倍，一颗骰子就顶掉半格、把名字价签全遮住。
     0.5 约等于四分之一格宽（TILE 1.86）：一眼读得出点数，又不压住整格的名字价签。 */
  const DICE_SIZE = 0.5;
  /* 骰子相对角色所在格中心的偏移。0.5 + 半颗骰子(0.25) = 0.75，仍在半格(0.93)之内 ——
     偏出去就压到邻格的文字上了。方向取 +x/+z：等距投影下那是屏幕右下，正好是角色脚边的空处。 */
  const DICE_OFFSET = 0.5;
  /* 落定后停留多久收起来。这颗骰子从「岛心骰盘」搬到角色脚边之后，必然压住某一格的地价 ——
     棋盘沿路径紧密排列，格子周围没有空地可放。所以它只在「掷」的那一下出场：
     点数由底部操作条（DiceBar）常驻显示，不需要一颗静止的骰子留在场上占位。 */
  const DICE_HOLD_SEC = 0.9;
  let diceHold = 0;
  function buildDice() {
    diceGroup = new THREE.Group();
    fillDice(state.dice ? state.dice.length : 1, state.dice);
    /* 初始就摆在当前行动者脚边。这里曾经有只岛心正中偏南的沙色骰盘（把骰子搁在棋盘中间）——
       那套视角已经删了，盘永远落在近景视野之外，留着只是一块谁也看不见的圆片。
       没有盘之后「盘心」这个概念也不成立了，直接跟人走。 */
    const p = state.players[state.currentPlayerIndex] || state.players[0];
    const a = p ? cellPos(p.position) : { x: 0, z: 0 };
    diceGroup.position.set(a.x + DICE_OFFSET, tileTop, a.z + DICE_OFFSET);
    /* 开局不显示：这一步还没掷骰，场上摆一颗静止的骰子既没有含义，又占着一格的地方。 */
    diceGroup.visible = false;
    scene.add(diceGroup);
  }
  /**
   * 造 cnt 颗骰子摆进骰盘（`values` 已知就直接落定，未知只给个初始朝向）。
   * 骰子的垂直位置靠 group 的 y 抬：棋盘格顶面与广场草皮顶面不是一个高度，
   * 写死一个值会在近景里让骰子半埋进格子里。
   */
  function fillDice(cnt, values) {
    if (!diceGroup) return;
    const n = Math.max(1, cnt | 0);
    for (const cube of diceGroup.children.slice()) {
      cube.geometry.dispose();
      for (const m of cube.material) { if (m.map) m.map.dispose(); m.dispose(); }
      diceGroup.remove(cube);
    }
    for (let i = 0; i < n; i++) {
      const mats = [1, 6, 2, 5, 3, 4].map((v) => new THREE.MeshStandardMaterial({ map: pipTexture(v), roughness: 0.5 }));
      const cube = new THREE.Mesh(new THREE.BoxGeometry(DICE_SIZE, DICE_SIZE, DICE_SIZE), mats);
      cube.castShadow = true;
      cube.position.set((i - (n - 1) / 2) * DICE_SIZE * 1.3, DICE_SIZE / 2 + 0.06, 0);
      cube.userData.value = values ? (values[i] || 1) : 1;
      settle(cube, cube.userData.value);
      diceGroup.add(cube);
    }
  }
  /**
   * 把骰子甩出去：颗数按这次真的掷了几颗重建（骰力道具会把一颗变两三颗），
   * 旋转结束后翻向本次掷出的真实点数。
   * 落点是**行动者脚下那一格的旁边**：偏 +0.8/+0.8 是往镜头内侧让开半格，别把棋子压住。
   */
  function throwDice(values, from) {
    if (!diceGroup) return;
    const vals = (values && values.length ? values : [1]).slice(0, 4);
    if (diceGroup.children.length !== vals.length) fillDice(vals.length, null);
    const a = cellPos(from);
    diceGroup.position.set(a.x + DICE_OFFSET, tileTop, a.z + DICE_OFFSET);
    diceGroup.visible = true;
    diceHold = 0;
    const cubes = diceGroup.children;
    for (let i = 0; i < cubes.length; i++) {
      const cube = cubes[i];
      cube.userData.value = vals[i] || vals[vals.length - 1] || 1;
      cube.userData.spin = Math.max(0.2, DICE_ROLL_SEC - i * 0.14);   // 一颗接一颗落定
      cube.rotation.set(0.4 + i, 0.9 + i * 1.7, 0.2);                 // 起手先给个歪斜朝向，落定时才翻回真点数
    }
  }
  /* 单轴一次定转，把指定点数转到「朝上」。盒面序 +X=1 / -X=6 / +Y=2 / -Y=5 / +Z=3 / -Z=4
     （与 fillDice 里 mats 的顺序一一对应，对面之和恒为 7）。
     绕 X 转 −90° 把 +Z 抬朝上、绕 Z 转 +90° 把 +X 抬朝上 —— 轴选错就会把点数转到侧面去，
     屏幕上看到的就是「骰子显示 2 点、面板写着 1 点」。 */
  const FACE_ROT = { 1: [0, 0, Math.PI / 2], 2: [0, 0, 0], 3: [-Math.PI / 2, 0, 0], 4: [Math.PI / 2, 0, 0], 5: [Math.PI, 0, 0], 6: [0, 0, -Math.PI / 2] };
  function settle(cube, value) {
    const r = FACE_ROT[value] || FACE_ROT[1];
    cube.rotation.set(r[0], r[1], r[2]);
  }

  /* ---------- 一台镜头：近景等距 ----------
   * 这套 HUD 只有一种视角 —— 正交等距近景：看角色，周围只露几格。
   * 参考《環島大富翁》那种「人物站在棋盘上」的取景。
   *
   * 曾经还有一套透视俯视的「看全盘」（四档机位预设 + 一键切换）。已经删掉：
   * 看全局改由右下角的小地图承担，镜头只负责把当前这一步看清楚。
   * 两套并存时那些为「互切不跳」而生的换算（等效视野 / frameScale / 机位记忆）也一起删了 ——
   * 没有第二种视角，就没有「切过去」这件事。
   *
   * 为什么必须是正交：
   *   透视投影下越远越小，一张 5 格进深的画面里，近处格子和远处格子尺寸差得明显，
   *   等距菱形也会被扭歪（不是规则 2:1）。正交投影让所有格子一样大，这才是等距棋盘的观感。
   * 角度：az 45° / el 35.264°（= atan(1/√2)）是标准等距角，正方形格子在屏幕上正好投影成 2:1 菱形。
   * 距离：cam.dist 在这里的语义是「正交视野竖直覆盖多少世界单位」，不是退到多远。
   */
  const ISO = {
    az: 45, el: 35.264,
    view: 9.6,           // 竖直覆盖 9.6 世界单位；SPACING=2 → 约 4.8 格进深（“只显示几格”）
    /* 视野上下限。上限 24（≈12 格进深）是「退一步看周围」的从容值，不是全盘 ——
       全盘要 30 单位上下，那正是删掉的那种视角，不能从滚轮这里偷偷爬回来。
       它现在只受一件事约束：拉到 24 时岛外侧的海面仍要盖满四个角。 */
    viewMin: 7.0, viewMax: 24,
    depth: 140,          // 正交相机摆多远（平行投影下只影响裁剪，不影响成像）
    shadow: 13,          // 近景阴影相机半宽：收窄换清晰接触阴影
    /* 注视点抬高量。注视点钉在格面（y=0）时，角色的身体整个长在画面中心线**以上** ——
       近景里看着就是「人偏高、下方空一截」。把注视点连同相机一起抬 1.0（视线方向不变，
       正交投影下等价于整幅画面刚性下移），人物身体正好落回画面中心。
       必须「相机位姿 + 注视点」一起抬，只抬注视点会让相机仰起、方格子被压成非等距。 */
    aimY: 1.0,
    /* 横向可视范围的上限（相对竖直的倍数）。
       视野是按竖直短边定的，宽高比多大横向就铺多宽 —— 正常 16:10 下没问题，
       但用户那台是 1530×731 ≈ 2.09:1，实测一次铺开 **14 格**，
       「周围只显示几格」被稀释成一条长带。把横向夹到竖直的 1.5 倍，
       多出来的宽度交给海面填充，近景在任何宽高比下都还读得出「近景」。
       注意只夹横向：竖直视野不动，所以滚轮推到最近的 7 单位时也不会被横向放大反噬。 */
    maxAspect: 1.5,
  };

  /* 宽高比一律从舞台尺寸现算，不读 camera.aspect —— 写宽高比的那条路径只有 resize 一处，
     从这里读回来只会在「刚 resize 完还没 applyCam」的那一帧拿到旧值。 */
  const viewAspect = () => {
    const w = host ? host.clientWidth : 1, h = host ? host.clientHeight : 1;
    return h > 0 ? w / h : 1;
  };
  const orthoView = () => Math.min(ISO.viewMax, Math.max(ISO.viewMin, cam.dist));
  /* 近景实际生效的宽高比 = 舞台宽高比，但横向最多 ISO.maxAspect 倍（见 ISO.maxAspect 注释）。
     小地图的取景框必须用这个值而不是舞台宽高比，否则超宽屏下框会比实际视野宽一截。 */
  const isoAspect = () => Math.min(viewAspect(), ISO.maxAspect);
  /* 俯角只留 24°~62° 一段：再低格子的菱形被拉成长条、失去等距的规整感，
     再高就看不出「站在棋盘上」，退化成俯视图。 */
  const clampEl = (v) => Math.min(62, Math.max(24, v));

  function applyCam() {
    const el = THREE.MathUtils.degToRad(cam.el), az = THREE.MathUtils.degToRad(cam.az);
    const dx = Math.sin(az) * Math.cos(el), dy = Math.sin(el), dz = Math.cos(az) * Math.cos(el);
    const h = orthoView(), w = h * isoAspect();
    orthoCam.left = -w / 2; orthoCam.right = w / 2; orthoCam.top = h / 2; orthoCam.bottom = -h / 2;
    /* 注视点与相机位姿同步抬高 aimY：方向不变 ⇒ 正交投影下只是整幅画面刚性下移，
       等距菱形的角度一分不变。见 ISO.aimY 的注释。 */
    const ay = target.y + ISO.aimY;
    orthoCam.position.set(target.x + dx * ISO.depth, ay + dy * ISO.depth, target.z + dz * ISO.depth);
    orthoCam.updateProjectionMatrix();
    orthoCam.lookAt(target.x, ay, target.z);
    camera = orthoCam;                      // raycast / project 一直取这一台
    syncKeyLight();
  }

  /* 阴影相机跟随注视点：固定 ±13。近景只看得到局部，1024 的阴影图摊在 26 单位上约 39px/单位，
     接触阴影才清晰；按全盘（±34）铺就是 15px/单位，脚下那圈阴影会糊成一片。 */
  function syncKeyLight() {
    if (!keyLight) return;
    const ext = ISO.shadow;
    const sc = keyLight.shadow.camera;
    if (sc.right !== ext) {
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.updateProjectionMatrix();
    }
    keyLight.position.set(target.x + 16, target.y + 30, target.z + 12);
    keyLight.target.position.copy(target);
    keyLight.target.updateMatrixWorld();
  }

  /* ---------- 相机系统：回合聚焦 → 跟随 ----------
   * 状态机：
   *   idle    自由视角，完全由用户拖拽 / 旋转掌控
   *   intro   聚焦入场：注视点与镜头位姿从「当前值」补间到「该玩家脚下」，期间 locked=true 屏蔽输入
   *   follow  跟随：注视点以指数平滑追该玩家的棋子，棋子每跳一格都能立刻跟上且不抖
   *
   * 注视点为什么**不**夹取：近景的全部意义就是「人物站在棋盘上」，把注视点夹到离棋盘中心
   * 多少单位以内，反而会把角落里的角色推出画面。曾经为透视俯视写过一套夹取，那套视角已经删了，
   * 夹取也就没有存在的理由 —— 现在谁行动，镜头就对准谁。
   */
  const CAM = {
    introMs: 1150,        // 入场时长
    followHalfLife: 0.16, // 跟随平滑半衰期（秒）
  };
  let camState = 'idle';        // idle | intro | follow
  let followPid = null;
  let camTween = null;
  let locked = false;           // 输入闸门：intro 期间为 true
  let focusRing = null;

  const easeInOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const lerp = (a, b, k) => a + (b - a) * k;

  /* 调用方只给 pid 时，focusPlayer 会落到这套默认机位：标准等距角 + 默认近景视野。
     不继承用户手调的角度 —— 换回合要把「谁在行动」交代清楚，机位回到标准角最好认。
     用户随后拖拽 / 滚轮调的机位照样有效，只是下一次聚焦会重新对齐。 */
  function modeView() {
    return { el: ISO.el, dist: ISO.view, az: ISO.az };
  }

  function setLocked(v) {
    const nv = !!v;
    if (nv === locked) return;
    locked = nv;
    if (locked) { drag = null; setHover(null); }   // 入场瞬间掐断正在进行的拖拽
    hooks.onCameraLock && hooks.onCameraLock(locked);
  }

  function buildFocusRing() {
    focusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.9, 44),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    );
    focusRing.rotation.x = -Math.PI / 2;
    focusRing.renderOrder = 3;
    focusRing.visible = false;
    scene.add(focusRing);
  }

  /** 高亮环跟着棋子走（含跳格动画期间），颜色取玩家色 */
  function updateFocusRing(pid) {
    if (!focusRing) return;
    const g = tokenGroups.get(pid);
    if (!g) { focusRing.visible = false; return; }
    focusRing.material.color.set(cssOf(pid));
    focusRing.position.set(g.position.x, tileTop + 0.02, g.position.z);
    focusRing.visible = true;
  }

  /**
   * 选格模式的视觉（W3）：合法格套一圈绿环，其余格面压暗；传空数组 = 退出选格态、全部还原。
   *
   * 三条刻意的取舍：
   * - **只按引擎给的合法性着色**，不按镜头或"离玩家几格"自己判 —— 飞弹 / 核弹的候选是全图，
   *   若按视野淡出就会把能打的格子说成不能打；
   * - 环用 `InstancedMesh` 一次画完（64 个 mesh 的代价本文件已经记过一次教训）；
   * - 压暗以 `userData.baseHex` 为基准，不进位到"暗色的再乘一次"。
   */
  function setPickHighlight(ids) {
    pickIds = ids || [];
    const on = pickIds.length > 0;
    const legal = new Set(pickIds);
    for (const m of tileMeshes) {
      const dim = on && !legal.has(m.userData.cellId);
      m.material.color.set(m.userData.baseHex);
      if (dim) m.material.color.multiplyScalar(0.55);
      /* 格面贴花（emoji / 名字 / 价签）是不吃光照的 basic 材质，只压格身的话非法格上那圈
         奶油色描字还是亮的，淡出读不出来 —— 同一档系数把它一起压。 */
      const decal = decalByCell.get(m.userData.cellId);
      if (decal) decal.material.color.setScalar(dim ? 0.55 : 1);
    }
    if (!pickOverlay) {
      /* 与选中/悬停同一套语言：一条贴地的绿裙边，而不是浮在格面之上的准星环 ——
         环会压在名字上，而且和「裙边=占据这一格」的读法打架。 */
      const geo = new THREE.BoxGeometry(TILE + GEOM.padGrow, GEOM.rimHeight, TILE + GEOM.padGrow);
      pickOverlay = new THREE.InstancedMesh(geo,
        new THREE.MeshLambertMaterial({ color: 0x4fc9a4, emissive: 0x2e9e7c, emissiveIntensity: 0.35 }),
        Math.max(1, tileMeshes.length));
      pickOverlay.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      pickOverlay.renderOrder = 4;
      pickOverlay.visible = false;
      scene.add(pickOverlay);
    }
    /* 比选中裙边再高一点点、再大一点点：选格态下「选中」和「可点」可能落在同一格 */
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    const scl = new THREE.Vector3(1.008, 1.1, 1.008);
    for (let i = 0; i < pickIds.length; i++) {
      const p = cellPos(pickIds[i]);
      pos.set(p.x, GEOM.padTop + 0.005, p.z);
      mat4.compose(pos, rot, scl);
      pickOverlay.setMatrixAt(i, mat4);
    }
    pickOverlay.count = pickIds.length;
    pickOverlay.instanceMatrix.needsUpdate = true;
    pickOverlay.visible = on;
  }

  /**
   * 轮到 pid 操作：把镜头对到他脚下，随后进入跟随。
   * @param {string} pid
   * @param {{immediate?:boolean, el?:number, dist?:number, az?:number, dur?:number}} [opts]
   *        immediate 用于首帧 / 无动效偏好；不传 el/dist/az 就落到默认近景机位。
   */
  function focusPlayer(pid, opts) {
    const o = opts || {};
    const g = tokenGroups.get(pid);
    if (!g || !camera) return;
    const mv = modeView();
    followPid = pid;
    updateFocusRing(pid);
    const toEl = o.el != null ? o.el : mv.el;
    const toDist = o.dist != null ? o.dist : mv.dist;
    const toAz = o.az != null ? o.az : mv.az;
    if (o.immediate || REDUCED) {
      cam.el = toEl; cam.dist = toDist; cam.az = toAz;
      target.set(g.position.x, target.y, g.position.z);
      camTween = null; camState = 'follow';
      applyCam();
      setLocked(false);
      hooks.onCameraSettled && hooks.onCameraSettled(pid);
      return;
    }
    /* az 也进补间：方位角从当前值平滑转到 45°（等距方位），不是硬切。
       走最短弧 —— 直接 lerp 会在 350°→10° 时反向绕一整圈。 */
    const dAz = (((toAz - cam.az) % 360) + 540) % 360 - 180;
    camTween = {
      t: 0, dur: Math.max(0.15, (o.dur != null ? o.dur : CAM.introMs) / 1000),
      /* 用户手调过机位时（拖过、滚过），换人只该挪注视点，不该把俯角/距离一起拽回默认值 ——
         那会让人觉得自己调好的角度每次换回合都被抹掉。 */
      use: { el: o.el != null, dist: o.dist != null, az: o.az != null },
      from: { tx: target.x, tz: target.z, el: cam.el, dist: cam.dist, az: 0 },
      to: { tx: g.position.x, tz: g.position.z, el: toEl, dist: toDist, az: dAz },
    };
    camState = 'intro';
    setLocked(true);
    applyCam();
  }

  /** 释放跟随、回自由视角（复位按钮 / 手动接管时用） */
  function releaseFollow() {
    followPid = null;
    camTween = null;
    camState = 'idle';
    if (focusRing) focusRing.visible = false;
    setLocked(false);
  }

  function stepCamera(dt, t) {
    if (camTween) {
      camTween.t += dt;
      const k = Math.min(1, camTween.t / camTween.dur);
      const e = easeInOutCubic(k);
      const f = camTween.from, to = camTween.to;
      target.x = lerp(f.tx, to.tx, e);
      target.z = lerp(f.tz, to.tz, e);
      cam.el = lerp(f.el, to.el, e);
      cam.dist = lerp(f.dist, to.dist, e);
      cam.az += to.az * (e - (camTween.eAz || 0));
      camTween.eAz = e;
      applyCam();
      if (k >= 1) {
        camTween = null;
        camState = 'follow';
        setLocked(false);                       // 视角完全停稳才解锁
        hooks.onCameraSettled && hooks.onCameraSettled(followPid);
      }
    } else if (camState === 'follow' && followPid) {
      const g = tokenGroups.get(followPid);
      if (g) {
        const k = 1 - Math.pow(0.5, dt / CAM.followHalfLife);
        target.x += (g.position.x - target.x) * k;
        target.z += (g.position.z - target.z) * k;
        applyCam();
      }
    }
    if (focusRing && focusRing.visible) {
      const g = followPid ? tokenGroups.get(followPid) : null;
      if (g) focusRing.position.set(g.position.x, tileTop + 0.02, g.position.z);
      const pulse = 1 + Math.sin(t * 3.1) * 0.08;
      focusRing.scale.setScalar(pulse);
      focusRing.material.opacity = 0.5 + Math.sin(t * 3.1) * 0.3;
    }
  }

  /* ---------- 交互 ---------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let drag = null;
  let lastPointer = { x: 0, y: 0 };
  const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function pick(cx, cy) {
    const r = host.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(tileMeshes, false)[0];
    return hit ? hit.object.userData.cellId : null;
  }

  /**
   * 选「人」模式（W3-d）：候选玩家脚下套一圈绿环，与选格的绿环同一套语言（能点的东西才亮）。
   * 环挂在 token 组上，所以棋子移动 / 被传送时环自然跟着走，不必每帧重新对位。
   */
  function setPickPlayers(pids) {
    pickPids = pids || [];
    const want = new Set(pickPids);
    for (const [pid, ring] of pickPlayerRings) {
      if (want.has(pid)) continue;
      if (ring.parent) ring.parent.remove(ring);
      ring.geometry.dispose(); ring.material.dispose();
      pickPlayerRings.delete(pid);
    }
    for (const pid of want) {
      if (pickPlayerRings.has(pid)) continue;
      const g = tokenGroups.get(pid);
      if (!g) continue;                       // 这一帧还没有这个人的棋子（新玩家 / 刚重挂载）
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(TILE * 0.40, TILE * 0.52, 26),
        new THREE.MeshBasicMaterial({ color: 0x7fe07a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = tileTop + 0.03;
      ring.renderOrder = 4;
      g.add(ring);
      pickPlayerRings.set(pid, ring);
    }
  }

  /** 指针下是不是一个「此刻可选」的棋子 —— 选人才按人命中，其余情况照旧按格命中 */
  function pickPlayer(cx, cy) {
    if (!pickPids.length) return null;
    const r = host.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const gs = pickPids.map((pid) => tokenGroups.get(pid)).filter(Boolean);
    const hit = ray.intersectObjects(gs, true)[0];
    if (!hit) return null;
    let o = hit.object;
    while (o && !o.userData.pid) o = o.parent;
    return o ? o.userData.pid : null;
  }

  /* 悬停只换一条贴地的白裙边，不再把格子纵向拉伸 1.5 倍 —— 那个动作会让格子在近景里
     鼓成一个立体的墩子，并且把贴面文字顶歪。 */
  function setHover(id) {
    if (hoverCell === id) return;
    hoverCell = id;
    /* 已经选中的那一格由金裙边负责，悬停裙边让位，免得两条叠成一条 */
    placeSkirt(hoverSkirt, id !== null && id === selCell ? null : id);
    hooks.onHover && hooks.onHover(id);
  }

  /* 交互控件判定。**这个判断是必需的，不是优化**：
     mount() 收到的 el 就是 .d25-stage，而舞台工具条（复位 / 正俯视 / 斜 45° / 低角度 /
     近景等距 / 镜头巡演）全都长在这个 stage 里面。工具条上的 pointerdown 会冒泡到 host，
     若照样执行 setPointerCapture，指针就被 stage 抢走 —— 随后的 mouseup / click
     全部被重定向到 stage，按钮自己的 onclick 永远不触发。
     实测（真鼠标点「斜 45°」）：
       pointerdown → BUTTON / mousedown → BUTTON
       mouseup     → DIV.d25-stage / click → DIV.d25-stage   ← click 丢了
     极其阴险的地方在于：脚本里 element.click() 走的是 DOM 直调、不过命中测试，
     所以「自动化全绿、真人全废」。第一轮起就存在，第三轮才被用户点出来。 */
  const isControl = (t) => t instanceof Element
    && !!t.closest('button, a, input, select, textarea, label, [role="button"], .d25-bar');

  function bindEvents() {
    /* 输入闸门：聚焦入场期间一律不响应 —— 拖拽 / 缩放 / 方向键 / 悬停 / 选格全部关掉，
       避免用户在镜头还在飞的时候把视角拽走、或误选到格子。 */
    host.addEventListener('pointerdown', (e) => {
      if (locked) return;
      if (isControl(e.target)) return;      // 起点在控件上：不接管指针，把 click 留给按钮
      lastPointer = { x: e.clientX, y: e.clientY };
      drag = { x: e.clientX, y: e.clientY, az: cam.az, el: cam.el, moved: 0 };
      host.setPointerCapture(e.pointerId);
    });
    host.addEventListener('pointermove', (e) => {
      if (locked) return;
      lastPointer = { x: e.clientX, y: e.clientY };
      /* 指针在工具条上时不做悬停拾取：否则鼠标划过按钮，背后那片格子会莫名其妙亮起来 */
      if (isControl(e.target)) { if (!drag) setHover(null); return; }
      if (!drag) { setHover(pick(e.clientX, e.clientY)); return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      cam.az = drag.az - dx * 0.32;
      cam.el = clampEl(drag.el + dy * 0.26);
      applyCam();
    });
    const up = (e) => {
      if (locked) { drag = null; return; }
      if (drag && drag.moved < 5) {
        /* 选人模式优先按棋子命中：环是套在人物脚下的，点人和点格用的是同一只手，
           但要交给宿主的是两种目标（targetPlayerId / cellId）。 */
        const pid = pickPlayer(e.clientX, e.clientY);
        if (pid) { hooks.onPickPlayer && hooks.onPickPlayer(pid); drag = null; return; }
        const id = pick(e.clientX, e.clientY);
        selCell = id;
        /* 选中改成在那格底下套一条金裙边：格子本身一动不动，视线里不会多出一块飞起来的板子 */
        placeSkirt(selSkirt, id);
        if (hoverCell != null && hoverCell === id) placeSkirt(hoverSkirt, null);
        hooks.onSelect && hooks.onSelect(id);
      }
      drag = null;
    };
    host.addEventListener('pointerup', up);
    host.addEventListener('pointerleave', () => { drag = null; setHover(null); });
    host.addEventListener('wheel', (e) => {
      if (locked) return;
      e.preventDefault();
      const s = Math.sign(e.deltaY);
      /* 这里的「距离」是正交视野高度，一格滚 0.7：从默认 9.6 推到上限 24（≈12 格进深）大约 20 格。
         步长给大一点会在近景里一下把放大率打掉三成，看着像跳帧。 */
      cam.dist = Math.min(ISO.viewMax, Math.max(ISO.viewMin, cam.dist + s * 0.7));
      applyCam();
    }, { passive: false });
    host.addEventListener('keydown', (e) => {
      if (locked) return;
      const K = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
      if (!K) return;
      e.preventDefault();
      cam.az += K[0] * 5;                    // 每次 5°，正好 18 次转一圈
      cam.el = clampEl(cam.el + K[1] * 4);
      applyCam();
    });
  }

  /* ---------- 动画 ---------- */
  /** 逐格跳的节拍：一格 0.16 秒。骰子从出手到落定 0.62 秒，这段时间棋子原地等 —— 先看点数再走路 */
  const HOP_CELL_SEC = 0.16;
  const DICE_ROLL_SEC = 0.62;
  /** 走路演完到被押走之间停多久：够读完「被押送至…」那一条，也让两段读得通 */
  const TRANSFER_HOLD_SEC = 0.55;
  let hopQ = null;   // {pid, path:[{x,z}], i, t, wait, lastCell, finalCell, transferTo, hold}

  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (paused) { clock.last = now; return; }
    /* 两个 dt 是分开的，别再合并：
     *   装饰动画（棋子呼吸、骰子旋转）用 50ms 上限 —— 卡顿后不要瞬间转半圈。
     *   相机演出用 250ms 上限 —— 它是「定时演出」，「1.15 秒后放开操作」这句承诺必须按墙钟兑现，
     *   不能因为渲染慢（软件渲染只有 ~11fps）就把 1.15s 拖成 2.1s。250ms 仍能兜住切标签页那种大停帧。 */
    const rawDt = (now - clock.last) / 1000;
    const dt = Math.min(0.05, rawDt);
    clock.last = now;
    clock.frames++;
    if (now - clock.at > 500) {
      clock.fps = Math.round(clock.frames * 1000 / (now - clock.at));
      clock.frames = 0; clock.at = now;
    }
    const t = now / 1000;
    /* 人物朝向：yaw 跟镜头方位角走，保证脸永远朝着屏幕；上面再叠一层很小的摇摆当「活着」的暗示。
       注意不能只留摇摆 —— 那样 azimuth 一转，就能看到角色的后脑勺。 */
    const faceYaw = THREE.MathUtils.degToRad(cam.az);
    for (const [id, g] of tokenGroups) {
      if (hopQ && hopQ.pid === id) continue;
      if (REDUCED) { g.rotation.y = faceYaw; continue; }
      g.position.y = Math.sin(t * 2.1 + g.userData.phase) * 0.055;
      g.rotation.y = faceYaw + Math.sin(t * 0.9 + g.userData.phase) * 0.13;
      /* 广告牌恒正对相机，上面那句 rotation.y 对它无效，所以转身摆动改在这里补：
         宽度按同一个相位微缩（±3%）+ 极小倾角，读起来是站着呼吸而不是一张贴纸。
         上下浮动不用另做 —— Sprite 挂在 g 底下，直接继承 g.position.y 的 bob。
         每个棋子有自己的 SpriteMaterial，转 material.rotation 不会串到别人身上。 */
      const sp = g.userData.sprite;
      if (sp) {
        const sway = Math.sin(t * 0.9 + g.userData.phase);
        sp.scale.x = sp.scale.y * (1 + sway * 0.03);
        sp.material.rotation = sway * 0.022;
      }
    }
    if (hopQ) stepHop(dt);
    for (const cube of diceGroup.children) {
      if (cube.userData.spin > 0) {
        cube.userData.spin -= dt;
        cube.rotation.x += dt * 11; cube.rotation.y += dt * 8;
        if (cube.userData.spin <= 0) settle(cube, cube.userData.value);
      }
    }
    /* 全部落定后再停一小会，然后收起来 —— 把画面还给格子（见 DICE_HOLD_SEC 的注释）。
       只要还有一颗在转就把计时清零，所以「一颗接一颗落定」的节奏不会被提前掐断。 */
    if (diceGroup.visible) {
      if (diceGroup.children.some((c) => c.userData.spin > 0)) diceHold = 0;
      else if ((diceHold += dt) >= DICE_HOLD_SEC) diceGroup.visible = false;
    }
    /* 选中裙边的呼吸：只动自发光强度，不动透明度 —— 半透明的金裙边压在有主的粉裙边上
       会混成第三种颜色，读起来像「这格主人变了」。`prefers-reduced-motion` 下不脉动。 */
    if (selSkirt && selSkirt.visible) {
      selSkirt.material.emissiveIntensity = REDUCED ? 0.34 : 0.22 + 0.2 * Math.sin(t * 4.6);
    }
    /* 候选裙边与选中裙边同频：一眼看出「这两类亮的是同一回事 —— 此刻能点」。
       同样只动自发光，不动透明度。 */
    if (pickOverlay && pickOverlay.visible) {
      pickOverlay.material.emissiveIntensity = REDUCED ? 0.4 : 0.28 + 0.2 * Math.sin(t * 4.6);
    }
    /* 候选玩家的环与绿环同频闪动：一眼看出「这两类亮的是同一回事 —— 此刻能点」 */
    for (const ring of pickPlayerRings.values()) {
      ring.material.opacity = REDUCED ? 0.85 : 0.55 + 0.3 * Math.sin(t * 4.6);
    }
    stepCamera(Math.min(0.25, rawDt), t);
    renderer.render(scene, camera);
    hooks.onFrame && hooks.onFrame();
  }

  /** 押送的第二段：直接落到真值格。不做沿圈补走 —— 补走正是「绕半个棋盘」的由来 */
  function landTransfer(g) {
    const { pid, transferTo } = hopQ;
    hopQ = null;
    const { x, z } = cellPos(transferTo);
    g.position.x = x; g.position.z = z; g.position.y = 0;
    hooks.onLand && hooks.onLand(pid, transferTo, 'transfer');
    hooks.onMoveSettled && hooks.onMoveSettled(pid, transferTo);
  }

  function stepHop(dt) {
    if (hopQ.wait > 0) { hopQ.wait -= dt; return; }   // 骰子还没停稳，棋子原地等
    const g = tokenGroups.get(hopQ.pid);
    if (!g) { hopQ = null; return; }
    if (hopQ.hold > 0) { hopQ.hold -= dt; if (hopQ.hold <= 0) landTransfer(g); return; }
    const from = hopQ.path[hopQ.i], to = hopQ.path[Math.min(hopQ.i + 1, hopQ.path.length - 1)];
    hopQ.t += dt / HOP_CELL_SEC;
    const k = Math.min(1, hopQ.t);
    g.position.x = from.x + (to.x - from.x) * k;
    g.position.z = from.z + (to.z - from.z) * k;
    g.position.y = Math.sin(k * Math.PI) * 1.05;
    if (k >= 1) {
      hopQ.i++; hopQ.t = 0;
      if (hopQ.i >= hopQ.path.length - 1) {
        g.position.y = 0;
        const pid = hopQ.pid, cell = hopQ.lastCell;
        /* 路走完了，但引擎这一手把人押走了（踩中机会格 → 直接进监狱那类）：
           先按走路落定报一次，停一拍，再瞬移到真落点。 */
        if (hopQ.transferTo != null && hopQ.transferTo !== cell) {
          hooks.onLand && hooks.onLand(pid, cell, 'walk');
          hopQ.hold = TRANSFER_HOLD_SEC;
          return;
        }
        hopQ = null;
        hooks.onLand && hooks.onLand(pid, cell, 'walk');
        /* 跳完了才允许交接镜头：引擎一位玩家的掷骰是一个原子动作，状态到的那一刻
           回合指针已经换人了，不排队就会看见「棋子在半空、镜头已经甩走」。 */
        hooks.onMoveSettled && hooks.onMoveSettled(pid, cell);
      }
    }
  }

  /* ---------- 对外 ---------- */
  const api = {
    mount(el, S, h) {
      host = el; hooks = h || {};
      disposed = false;   // dispose 后再挂载必须复位，否则 frame 一进来就 return（首帧之后不再渲染）
      paused = false;
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setClearColor(0x000000, 0);
      if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      el.appendChild(renderer.domElement);
      renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
      renderer.domElement.setAttribute('role', 'img');
      renderer.domElement.setAttribute('aria-label', '3D 棋盘：拖拽或用方向键转视角，滚轮缩放，悬停格子看地价与归属');
      el.tabIndex = 0;
      el.style.outline = 'none';
      buildWorld(S);
      applyCam();
      bindEvents();
      api.resize();
      /* 容器尺寸变化（侧栏折叠、窗口缩放）比 window resize 更准，走 ResizeObserver */
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => { api.resize(); });
        ro.observe(el);
      }
      raf = requestAnimationFrame(frame);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => api.redrawLabels());
      return api;
    },
    resize() {
      if (!host || !renderer) return;
      const w = host.clientWidth || 600, hgt = host.clientHeight || 600;
      renderer.setSize(w, hgt, false);
      applyCam();          // 宽高比变了要重算正交的左右边界
    },
    /** 表现层重新上色（买地后调用）：只重画持有者描边，不重跑规则 */
    /** 棋子跟着状态走（换人 / 移动后调用） */
    sync(Snap) {
      state = Snap.state; view = Snap.view;
      LAYOUT = view.layout && view.layout.cells ? view.layout : null;
      for (const p of state.players) {
        const g = tokenGroups.get(p.id);
        if (!g) continue;
        if (hopQ && hopQ.pid === p.id) {
          /* 演出没跟上真状态（传送卡、交换位置那类一步跨很远）就立刻落位，
             别把棋子留在半路某一格上 —— 玩家看到的必须是引擎的真值。
             比对的是这一段的**终点**：押送是「先走路、再瞬移」两段，中途那一格本来就不是真值。 */
          if (p.position === hopQ.finalCell) continue;
          hopQ = null;
        }
        const { x, z } = cellPos(p.position);
        g.position.x = x; g.position.z = z;
        g.position.y = 0;
      }
      syncTreasure();
      syncEntities();
    },
    paintOwners,
    redrawLabels() {
      for (const [cellId, decal] of decalByCell) {
        const cell = state.board[cellId];
        const price = cell.price ? Math.round(cell.price * view.priceIndex) : 0;
        const corp = companyOnCell(cell.id);
        decal.material.map.dispose();
        decal.material.map = tileTexture(cell, corp ? `🔔${corp.sharePrice}` : (cell.price ? `${price}` : ''));
        decal.material.needsUpdate = true;
      }
    },
    /**
     * 掷骰演出：骰子按真实点数翻滚落定 → 棋子沿圈逐格跳过 `steps` 格（带小弧线）。
     *
     * 引擎一次 `ROLL_DICE` 就把整段路原子地走完了，中间那些格子从不进状态，
     * 所以「路过哪几格」只能由宿主把这一手的真实路线（`state.movePath`）交给表现层 —— 纯表现，不落规则。
     * `transfer` 是这一手的**真落点**（押送 / 传送那类）：路走完后再停一拍，直接瞬移过去，不沿圈补走。
     * @param {{pid:string, from:number, steps:number, dir?:1|-1, dice?:number[]|null, cells?:number[]|null, transfer?:number|null}} opts
     * @returns {boolean} 真的开始演出了才返回 true（减弱动效偏好下返回 false，宿主直接落位）
     */
    playMove(opts) {
      const { pid, from, steps, dir = 1, dice = null, cells = null, transfer = null } = opts || {};
      const g = tokenGroups.get(pid);
      if (!g || REDUCED || !(steps > 0)) return false;
      /* `cells` = 引擎记下的这一手真实格子序列（`state.movePath` 的尾巴）⇒ 直接照它跳。
         没有才按环上的 ±1 自己推 —— 那条只在自建图里成立。 */
      const walk = cells && cells.length ? cells : null;
      const n = state.board.length || 64;
      const path = walk ? walk.map((id) => cellPos(id)) : (() => {
        const out = [cellPos(from)];
        let pos = from;
        for (let k = 0; k < steps; k++) { pos = (pos + dir + n) % n; out.push(cellPos(pos)); }
        return out;
      })();
      const lastCell = walk ? walk[walk.length - 1] : (from + dir * steps + n) % n;
      const finalCell = transfer != null && transfer !== lastCell ? transfer : lastCell;
      /* `dice` 为空 = 这一手不是掷骰走路（神明挪位、传送那类）：不摇骰子，直接开走 */
      hopQ = { pid, path, i: 0, t: 0, wait: dice ? DICE_ROLL_SEC : 0, lastCell, finalCell, transferTo: finalCell, hold: 0 };
      if (dice) throwDice(dice, from);
      return true;
    },
    /** 是否有移动演出正在进行（HUD 用它决定「跳完才交接镜头」） */
    isHopping: () => !!hopQ,
    project(x, y, z) {
      const v = new THREE.Vector3(x, y, z).project(camera);
      const r = host.getBoundingClientRect();
      /* 正交是平行投影，「相机到点的距离」（恒等于 ISO.depth=140）跟看起来多大毫无关系。
         但名牌的缩放正是拿这个 dist 算的 —— 直接回报 140 会让近景里所有名牌缩到最小档。
         所以换一个等效透视距离：取正交视野高度的 4.6 倍，使 labelScale(46/dist) ≈ 1。 */
      const dist = orthoView() * 4.6;
      return {
        x: (v.x * 0.5 + 0.5) * r.width,
        y: (-v.y * 0.5 + 0.5) * r.height,
        vis: v.z < 1 && v.z > -1,
        dist,
      };
    },
    tokenAnchors() {
      const out = [];
      for (const p of state.players) {
        const g = tokenGroups.get(p.id);
        if (!g) continue;
        out.push({
          /* 名牌抬到 1.8：小人连帽顶到 tileTop+1.55，旧值 1.45 会压在帽子上（旧棋子只有 1.24 高） */
          pid: p.id, name: p.name, cash: p.cash, x: g.position.x, y: tileTop + 1.8, z: g.position.z,
          /* 金底名牌 = 「正在行动的这位」。跟随中就以镜头目标为准 —— 这样相机、地面高亮环、
             名牌金底三处永远指同一个人。没跟随时退回引擎的回合指针（真实对局里两者恒等）。 */
          cur: p.id === (followPid || state.players[state.currentPlayerIndex].id),
        });
      }
      return out;
    },
    tileAnchor(cellId) {
      const { x, z } = cellPos(cellId);
      return { x, y: tileTop + 0.2, z };
    },
    /** 宝箱盒子当前画在哪（null = 场上没有）。表现层自检用：证明盒子落在 `view.treasureCellId` 那一格 */
    treasureAnchor() {
      if (!treasureMesh || !treasureMesh.visible) return null;
      return { cellId: view.treasureCellId, x: treasureMesh.position.x, z: treasureMesh.position.z };
    },
    /** 实体圆盘画在哪些格（W3-c 自检用：证明 `view.entities` 真落到了场景里，而不是只进了快照） */
    entityAnchors() {
      if (!entityGroup) return [];
      return entityGroup.children.map((sp) => ({ cellId: sp.userData.ent.cellId, emoji: sp.userData.ent.emoji, sub: sp.userData.ent.sub, x: sp.position.x, y: +sp.position.y.toFixed(2), z: sp.position.z }));
    },
    lastPointer: () => ({ ...lastPointer }),
    stats() {
      return { fps: clock.fps, calls: renderer ? renderer.info.render.calls : 0, tris: renderer ? renderer.info.render.triangles : 0, cam: { ...cam } };
    },
    /** 回到默认近景机位。会先释放跟随 —— 否则用户手选的机位下一帧就被跟随逻辑拽回玩家身上 */
    setView() {
      releaseFollow();
      Object.assign(cam, { az: ISO.az, el: ISO.el, dist: ISO.view });
      applyCam();
    },
    /** 兼容旧整壳（非 MP_MODE 时加载的 hud.js）留下的切换按钮：这套 HUD 只有近景一种视角，
        传什么都还是近景，没有「切过去」这件事。 */
    setCamMode() { return 'iso'; },
    camMode: () => 'iso',
    /**
     * 默认聚焦机位（等距近景 az45 / el35.3 / view9.6）。
     * 给「镜头巡演」用：它要验收的是「拉近 → 跟随 → 解锁」，必须让机位真的动起来。
     * 带这一份是因为 focusPlayer 不传 el/dist 时会落到它上面 —— 巡演照着它取数，
     * 才能断言「镜头确实动过」，而不是只看「感觉挺顺」。
     */
    focusView: () => modeView(),
    /**
     * 轮到某位玩家：平滑拉近聚焦，结束后进入跟随（详见文件中部「相机系统」注释）。
     * @param {string} pid 玩家 id
     * @param {{immediate?:boolean, el?:number, dist?:number}} [opts]
     */
    focusPlayer(pid, opts) { focusPlayer(pid, opts); },
    /** 释放跟随、回自由视角 */
    releaseFollow() { releaseFollow(); },
    /** 相机是否处于「入场演出中」—— 此时应屏蔽玩家操作 */
    isCameraLocked: () => locked,
    /** 视野里能看到几格（格心投影落在视口内即算）。
     *  把「周围只显示几格」从主观感受变成可断言的数字，否则只能靠肉眼看截图。 */
    visibleCells() {
      if (!camera || !host) return { count: 0, ids: [] };
      const v = new THREE.Vector3(), ids = [];
      for (const cell of state.board) {
        const { x, z } = cellPos(cell.id);
        v.set(x, tileTop, z).project(camera);
        if (v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1) ids.push(cell.id);
      }
      return { count: ids.length, ids };
    },
    /** 选格模式（W3）：合法格套绿环、其余格面压暗；传空数组 = 退出选格态并全部还原 */
    setPickHighlight(ids) { setPickHighlight(ids); },
    setPickPlayers(ids) { setPickPlayers(ids); },
    /** 当前选态（自检用）：绿环套在哪些格 / 哪些人脚下 */
    pickState() { return { cells: pickIds.slice(), players: pickPids.slice(), rings: pickPlayerRings.size }; },
    /** 当前被跟随的角色：投影是否落在舞台内 + 世界坐标 */
    heroOnScreen() {
      if (!camera || !host || !followPid) return null;
      const g = tokenGroups.get(followPid);
      if (!g) return null;
      const v = new THREE.Vector3(g.position.x, tileTop + 0.9, g.position.z).project(camera);
      return {
        pid: followPid, x: g.position.x, z: g.position.z,
        ndc: { x: +v.x.toFixed(3), y: +v.y.toFixed(3) },
        inside: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
      };
    },
    cameraState: () => ({
      state: camState, pid: followPid, locked,
      tx: target.x, tz: target.z,
      mode: 'iso', az: cam.az, el: cam.el,
      view: orthoView(),
      /* 实际生效的横向倍率（已夹 ISO.maxAspect）。小地图取景框要用它，不能自己算舞台宽高比 ——
         超宽屏下框会比实际看得见的宽一截。 */
      aspect: isoAspect(),
      /* 补间进度（0→1）。演出时长是硬承诺，暴露出来才能被脚本断言，而不是只看「感觉挺顺」 */
      prog: camTween ? camTween.t / camTween.dur : null,
    }),
    /** 同步出一帧（可带 dt 推进棋子动画）：后台标签页 rAF 被冻结，首屏与自检都走这里 */
    renderOnce(dt) {
      if (!renderer) return;
      if (dt && hopQ) stepHop(dt);
      if (dt) stepCamera(dt, (globalThis.performance ? performance.now() : Date.now()) / 1000);
      renderer.render(scene, camera);
      hooks.onFrame && hooks.onFrame();
    },
    /** 切到方环示意时停掉 WebGL，别在背后空转 */
    setPaused(v) { paused = !!v; },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro && ro.disconnect();
      if (focusRing) {            // 高亮环随场景一起遍历会漏掉材质，单独收尾
        focusRing.geometry && focusRing.geometry.dispose();
        focusRing.material && focusRing.material.dispose();
        focusRing = null;
      }
      camTween = null; camState = 'idle'; followPid = null; locked = false;
      /* 实体圆盘的纹理是按「图标+副标+主人色」缓存的，换局重挂载时不清掉会一直攒（炸弹剩余步数每步一个 key） */
      if (entityGroup) { scene.remove(entityGroup); entityGroup = null; }
      for (const t of entTexCache.values()) t.dispose && t.dispose();
      entTexCache.clear();
      /* figGeo 是缓存的：dispose 已经把里面的几何都释放了，不置空的话
         再次 mount 会拿到一堆「已释放的几何」渲染出空白小人。 */
      figGeo = null;
      scene && scene.traverse((o) => { o.geometry && o.geometry.dispose && o.geometry.dispose(); });
      renderer && renderer.dispose();
      host.innerHTML = '';
    },
  };
  globalThis.D25World = api;
})();
