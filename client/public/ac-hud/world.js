/* 2.5D 世界层（three.js UMD，file:// 可直接开）
 * 只画「场」：底座、64 格棋盘、岛上装饰、棋子、骰子、光影、镜头。
 * 文字与气泡交给 overlay.js（Pixi），面板留在 DOM。
 * 数据从 globalThis.GAME_SNAPSHOT 读，本文件不含规则。 */
(function () {
  'use strict';
  const THREE = globalThis.THREE;
  const SPACING = 2.0;      // 格距
  const TILE = 1.86;        // 格边长
  const DEPTH = 0.20;       // 格厚（参考《環島大富翁》里格子是薄片平板，不是方块）
  const money = (n) => Math.round(n).toLocaleString('zh-CN');
  const GROUP_HEX = {
    residential: 0x8fd07a, commercial: 0x7ec8ef, industrial: 0xc9b48a,
    tech: 0xb7a6e6, coastal: 0x7fd8c8, financial: 0xf0b96a,
  };
  const TYPE_HEX = {
    start: 0xffe08a, chance: 0xffd0e0, news: 0xdfe9ff, 'free-card': 0xe6e0ff,
    points: 0xfff0b8, lottery: 0xd6f2e6, magic: 0xf0d9ff,
    tax: 0xe8e2d2, hospital: 0xffe3e3, jail: 0xe3e6ee, game: 0xd9f0ff,
    shop: 0xffe6c8, bank: 0xf2ead2, god: 0xffd9a8, company: 0xd9c9a3, blank: 0xe9e6dc,
  };
  const EMOJI = {
    start: '🏁', property: '🏠', commercial: '🏬', chance: '🎋', news: '📰', 'free-card': '🃏',
    points: '🎟️', lottery: '🎰', magic: '🔮', tax: '💼', hospital: '🏥',
    jail: '🚔', game: '🎮', shop: '🛍️', bank: '🏦', god: '⛩️', company: '🏢', blank: '▫️',
  };

  let renderer, scene, camera, host, state, view, S;
  let perspCam = null, orthoCam = null, keyLight = null;
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
  const pal = {
    sand: 0xf7ebc9, grass: 0x9ad985, grass2: 0x7fbf68, water: 0x8fd8ef,
    trunk: 0xb08a55, leaf: 0x4f9440, stone: 0xe8d9b0, rim: 0x7a6547,
  };

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
  const extrude = (w, h, r, d, bevel) => {
    const g = new THREE.ExtrudeGeometry(roundedRect(w, h, r), {
      depth: d, bevelEnabled: !!bevel, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 1, curveSegments: 4,
    });
    g.rotateX(-Math.PI / 2);
    return g;
  };

  /* 世界布局（`view.layout`）：由 shared 的 `boardLayout` 按地图自带坐标换算，四张图每张都有。
     没有它就说明这副棋盘没坐标（引擎里那份 64 格自建盘，单测夹具）—— 那时不摆格子，
     不再伪造一个方环出来。 */
  let LAYOUT = null;

  /** 格子 → 世界坐标。几何全在 shared，本文件不排任何形状 */
  function cellPos(i) {
    const p = LAYOUT && LAYOUT.cells[i];
    return p ? { x: p.x, z: p.z } : { x: 0, z: 0 };
  }

  /* 岛体那一摞（海 / 浅滩 / 浪花 / 沙底 / 草地 / 树）尺寸是按 64 格小盘写死的。
     原版图按邻距定标后半径能到 54，不跟着放大格子就铺到海面之外、悬在空上。 */
  function islandK() {
    return LAYOUT ? Math.max(1, LAYOUT.radius / 22.6) : 1;
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

  /* 中央告示牌：木牌上的字也走 canvas 纹理，改文案不用动几何 */
  function signTexture(lines) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#e8d9b0'; g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#f7ebc9'; g.fillRect(14, 14, 484, 228);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((tx, i) => {
      g.font = i === 0 ? '900 64px "M PLUS Rounded 1c","PingFang SC","Microsoft YaHei",system-ui'
        : '800 44px "Nunito","M PLUS Rounded 1c",system-ui';
      g.fillStyle = i === 0 ? '#6b5940' : '#8a7548';
      g.fillText(tx, 256, i === 0 ? 92 : 170 + (i - 1) * 54);
    });
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
    /* 俯视的默认距离（70）与滚轮上限（130）都是按 64 环 ≈ 半径 22.6 定的。
       棋盘放大后不跟着抬，「回到全盘」就只能看到上下两条边 —— 实测潮汕 103 格正是如此。
       这里用赋值而不是累乘：重新挂载（换局）时不会越乘越远。 */
    cam.dist = 70 * IK;
    /* 重新挂载（dispose 后再 mount）时清空上一轮的容器，否则贴面 / 棋子会逐轮累积 */
    tileMeshes = []; decalByCell = new Map(); tokenGroups = new Map(); rimGroup = null; focusRing = null;
    treasureMesh = null;   // 上一轮场景已经重建，旧盒子留在变量里会把宝箱画在一个不存在的格上
    /* 选格 / 选人的高亮也一样：它们属于**上一轮那个 scene**，留着引用会把绿环画进
       一个已经不渲染的场景里（换局后「进选格态却什么都看不见」就是这么来的）。 */
    pickOverlay = null; pickIds = []; pickPlayerRings.clear();
    scene = new THREE.Scene();
    perspCam = new THREE.PerspectiveCamera(32, 1, 0.5, 260);
    orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    camera = perspCam;

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
       MeshLambert 比 MeshStandard 省掉整套 PBR 的分段计算，对这种哑光大色块肉眼看不出差别。 */
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(96 * IK, 96 * IK),
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
    /* 原版图的路径会穿过岛的内陆，而草地台的顶面（实测 0.53）比格面（0.45）还高 ——
       实测潮汕有六成格子整块埋在草里，全盘看下去只剩沙带上零星几格。
       带自带坐标的图一律把草地降到与沙面同高：内陆读成一块平的公园绿地，格子永远浮在上面。
       必须在广场 / 小径 / 树之前做，它们的高度全是从 `groundY` 推的。 */
    if (LAYOUT && groundY > 0.4) {
      // 0.12：高于沙面 0.05（否则两张大面共面，掠射角下糊出一片斑马状 z-fighting 条纹），
      // 又低于格面 0.45（否则内陆的格子还是被埋）
      const sink = groundY - 0.12;
      grass.position.y -= sink;
      groundY -= sink;
    }
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(6.6 * IK, 44), mat(0xf4e8cd, { roughness: 0.94 }));
    plaza.rotation.x = -Math.PI / 2; plaza.position.y = groundY + 0.012; plaza.receiveShadow = true;
    scene.add(plaza);
    const plazaRing = new THREE.Mesh(new THREE.RingGeometry(6.6 * IK, 7.25 * IK, 44), mat(0xdccaa2, { roughness: 0.94 }));
    plazaRing.rotation.x = -Math.PI / 2; plazaRing.position.y = groundY + 0.009;
    scene.add(plazaRing);
    const pathGeo = new THREE.PlaneGeometry(2.3 * IK, 8.0 * IK);
    pathGeo.rotateX(-Math.PI / 2);
    const pathMat = mat(0xefe2c4, { roughness: 0.94 });
    for (let k = 0; k < 4; k++) {
      const path = new THREE.Mesh(pathGeo, pathMat);
      path.position.set(0, groundY + 0.006, 0);
      path.rotation.y = (k / 4) * Math.PI * 2;
      path.translateZ(10.5);                // 从广场外缘伸到草地边
      path.receiveShadow = true;
      scene.add(path);
    }
    // 木告示牌：牌面文字走 canvas 纹理，改文案不用动几何
    const signPost = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 2.4, 8), mat(pal.trunk));
    signPost.position.set(0, groundY + 1.2, -3.6); signPost.castShadow = true;
    scene.add(signPost);
    const postMat = mat(0xb08a55);
    const signBoard = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.6, 0.18), [
      postMat, postMat, postMat, postMat,
      new THREE.MeshStandardMaterial({ map: signTexture(['中央岛', `奖池 ${money(state.lotteryPool)}`]), roughness: 0.82 }),
      mat(0xd9c9a3),
    ]);
    signBoard.position.set(0, groundY + 2.42, -3.6); signBoard.castShadow = true;
    scene.add(signBoard);

    // 池塘 + 装饰（位置固定，保证每次渲染一致）
    const pond = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.4, 0.5, 26), mat(pal.water, { roughness: 0.25, metalness: 0.1 }));
    pond.position.set(6.4, 0.16, 6.2); scene.add(pond);

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1.7, 8);
    const trunkMat = mat(pal.trunk);
    const leafGeo = new THREE.ConeGeometry(1.05, 0.9, 6);
    const leafMat = mat(pal.leaf);
    const hedgeGeo = new THREE.SphereGeometry(0.72, 12, 9);
    const hedgeMat = mat(pal.grass2);
    /* 环内 7 棵树 + 6 丛灌木：原来是 42 次 draw call，改实例化后 2 次。
       摆放位置全部写死 —— 随机化会让每次刷新长得不一样，前后对比截图就失去意义。
       坐标一律乘 `IK`：岛体随棋盘半径放大了，装饰留在原尺寸就会挤进棋盘路径中间
       （实测第一版就是这样，环内树带直接长在格子上）。 */
    const trunkList = [], leafList = [];
    const plantTree = (bx, bz, s, y0) => {
      const x = bx * IK, z = bz * IK;
      trunkList.push({ x, y: y0 + 0.85 * s, z, s });
      for (let k = 0; k < 5; k++) {
        leafList.push({ x, y: y0 + 1.75 * s, z, rx: 0.55, ry: (k / 5) * Math.PI * 2, rz: 0.32, s });
      }
    };
    for (const [x, z, s] of [[-8.6, -8.4, 1], [-3.2, -9.4, .85], [4.4, -8.6, .95], [9.2, -2.6, .9], [-9.4, 3.6, 1.05], [-6.2, 9.4, .8], [2.6, 9.6, .9]]) {
      plantTree(x, z, s, groundY - 0.05);   // 草地顶面；给 0 会让树干整根埋进草里（旧值就是这样）
    }
    /* ---------- 环内树带 ----------
     * 近景跟随镜头只看得到玩家周围 ~5 单位，而环心广场在 18 单位外 —— 所以近景里
     * 「草地」其实就是贴着棋盘内侧那一圈。这一带原来只有零星草丛，画面会空掉一半。
     * 沿半径 ~13 补一圈树：角度刻意避开 0/90/180/270（十字小径正压在这四个方向上）。 */
    for (let k = 0; k < 12; k++) {
      const a = THREE.MathUtils.degToRad(12 + k * 30);
      const r = 12.9 + (k % 3) * 0.45;
      plantTree(Math.cos(a) * r, Math.sin(a) * r, 0.8 + (k % 4) * 0.1, groundY - 0.05);
    }

    /* ---------- 环外椰林 ----------
     * 环格最大伸到 |16.93|，底座到 |19.5|，中间那条 2.5 单位宽的沙带是「岛」的边界。
     * 棋子走在环上时镜头朝外看，看到的就是这条沙带和它外面的海 —— 原来是空的一片纯沙。
     * 椰林贴着沙带外侧摆：近景里正好停在格子后方的上边缘，不挡棋盘，但把岛的轮廓交代清楚。
     */
    for (const [x, z, s] of [
      [-16, 18.2, 1.0], [-8, 18.5, .85], [0, 18.1, .95], [8, 18.5, .9], [16, 18.2, 1.05],
      [-12, -18.4, .9], [-4, -18.1, 1.0], [4, -18.5, .85], [12, -18.2, .95],
      [-18.4, -12, .95], [-18.1, -4, .85], [-18.5, 4, 1.0], [-18.2, 12, .9],
      [18.2, -8, .9], [18.5, 0, 1.05], [18.1, 8, .85],
    ]) {
      plantTree(x, z, s, 0.05);        // 0.05 = 沙色底座顶面
    }
    instanced(trunkGeo, trunkMat, trunkList, true);
    instanced(leafGeo, leafMat, leafList, true);
    instanced(hedgeGeo, hedgeMat, [[-11.5, -11.5], [11.5, -11.5], [-11.5, 11.5], [11.5, 11.5], [2.4, -12.6], [-12.6, 3.2]]
      .map(([x, z]) => ({ x: x * IK, y: 0.35, z: z * IK, s: [1.5, 0.8, 1.5] })), true);

    /* 礁石：半沉在浅滩 / 海面里，只露出一角。外侧 10 块沉水、四角 4 块搁在沙带边。
       y 值分开给：浅滩顶面在 −0.55，沙带顶面在 0.05，混用一个高度会有一半浮空或全淹。 */
    instanced(new THREE.DodecahedronGeometry(0.62, 0), mat(0xd4c8a9, { roughness: 0.95, flatShading: true }), [
      { x: -21.9, y: -0.36, z: 4.4, ry: 0.4, s: [1.30, 0.85, 1.10] },
      { x: -20.5, y: -0.40, z: -6.6, ry: 1.1, s: [0.95, 0.70, 1.00] },
      { x: -22.7, y: -0.32, z: -2.1, ry: 2.2, s: [1.05, 0.90, 0.95] },
      { x: 21.3, y: -0.38, z: 6.5, ry: 0.8, s: [1.15, 0.75, 1.20] },
      { x: 22.5, y: -0.34, z: -3.3, ry: 1.7, s: [0.90, 0.85, 0.95] },
      { x: 20.7, y: -0.36, z: -11.1, ry: 2.9, s: [1.20, 0.80, 1.05] },
      { x: 6.3, y: -0.32, z: 21.7, ry: 0.5, s: [1.10, 0.90, 1.15] },
      { x: -7.5, y: -0.38, z: 22.3, ry: 1.4, s: [1.25, 0.80, 1.00] },
      { x: 11.9, y: -0.36, z: -21.1, ry: 2.4, s: [0.95, 0.75, 1.05] },
      { x: -3.3, y: -0.34, z: -21.9, ry: 0.9, s: [1.05, 0.85, 0.95] },
      { x: 18.1, y: 0.28, z: 17.9, ry: 0.7, s: [0.80, 0.60, 0.85] },
      { x: -18.3, y: 0.28, z: 17.8, ry: 1.9, s: [0.90, 0.65, 0.80] },
      { x: 18.2, y: 0.28, z: -18.0, ry: 2.6, s: [0.75, 0.55, 0.90] },
      { x: -18.0, y: 0.28, z: -18.2, ry: 1.2, s: [0.85, 0.62, 0.78] },
    ].map((r) => ({ ...r, x: r.x * IK, z: r.z * IK })), true);

    /* ---------- 环内草丛 / 花丛 ----------
     * 战略俯视下它们只是些小色点，但能让「中间那片草地」不至于是一块纯色板。
     * 撒在广场外圈（半径 8.6~13.6）—— 环内半径 6.6 是广场、13.6 以外是环格。
     * 固定种子，每次渲染一致。 */
    const tuftList = [], bloomList = [], bushList = [];
    let ts = 0x5bf03635;
    const trnd = () => { ts = (ts * 1664525 + 1013904223) >>> 0; return ts / 4294967296; };
    for (let i = 0; i < 110; i++) {
      const a = trnd() * Math.PI * 2, r = (8.6 + trnd() * 5.0) * IK;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      /* 草丛高度要按缩放算：锥体的原点在「体中心」，固定 y 会让大株悬空、小株埋进土里 */
      const s = 0.55 + trnd() * 0.85;
      tuftList.push({ x, y: groundY + 0.26 * s, z, ry: trnd() * 6.3, s });
      if (i % 4 === 0) {
        /* 花按 3 朵一簇撒：单朵在近景里只占几个像素，看不出是花 */
        for (let k = 0; k < 3; k++) {
          bloomList.push({
            x: x + 0.28 + trnd() * 0.36, y: groundY + 0.20 + trnd() * 0.14,
            z: z - 0.42 + trnd() * 0.36, s: 0.75 + trnd() * 0.5,
          });
        }
      }
      if (i % 9 === 0) {
        const bs = 0.55 + trnd() * 0.5;
        bushList.push({ x, y: groundY + 0.30 * bs, z, ry: trnd() * 6.3, s: [bs, bs * 0.8, bs] });
      }
    }
    instanced(new THREE.ConeGeometry(0.24, 0.52, 5), mat(pal.grass2, { roughness: 0.95 }), tuftList, false);
    instanced(new THREE.SphereGeometry(0.44, 9, 7), mat(pal.leaf, { roughness: 0.92 }), bushList, false);
    instanced(new THREE.SphereGeometry(0.15, 8, 6), mat(0xffc6dd, { roughness: 0.7 }), bloomList, false);

    /* ---------- 岛上民居 ----------
     * 参考图里草地上散着几栋房子、灯塔、工厂 —— 岛不是一块空地。
     * 这里放 4 栋民居：房身 + 四坡顶各实例化一次，4 栋 = 2 次 draw call。
     * 位置刻意避开既有的树 / 灌木 / 池塘 / 十字小径（小径是 2.3 宽、沿 ±X/±Z 轴的）。 */
    const houseSpots = [
      [11.6, 6.2, 0.45], [-11.6, -6.0, -0.35], [-6.0, -11.6, 0.90], [6.4, -11.4, -0.80],
      [10.4, 9.8, 1.35], [-9.2, 11.6, 0.20],   // 补两栋贴近环内的：跟随镜头只看得见这一圈
    ];
    instanced(new THREE.BoxGeometry(1.5, 1.0, 1.4), mat(0xfff3dd, { roughness: 0.85 }),
      houseSpots.map(([x, z, ry]) => ({ x, y: groundY + 0.50, z, ry })), true);
    /* 四棱锥当屋顶：ConeGeometry 用 4 个径向段就是方锥；+45° 让四个坡面对齐房身四个面 */
    instanced(new THREE.ConeGeometry(1.28, 0.82, 4), mat(0xd9714f, { roughness: 0.8 }),
      houseSpots.map(([x, z, ry]) => ({ x, y: groundY + 1.41, z, ry: ry + Math.PI / 4 })), true);

    // 64 格
    geoTile = extrude(TILE, TILE, 0.28, DEPTH, true);
    geoTile.computeBoundingBox();
    tileTop = geoTile.boundingBox.max.y;   // 实测：bevel 让顶面高于 DEPTH（写死 DEPTH 会把贴面埋进格子里）
    /* 奶油台座：参考图里每格外围有一圈白边，格子像是坐在一只奶油小碟上 —— 近景下这圈白边
       是「棋盘」和「地面」之间唯一的视觉分隔，没有它，草地色的格子和草地会糊成一片。
       宽度只能顶到 SPACING（2.0）—— 再宽邻格台座就会互相插进去。TILE+0.12=1.98 留 0.01 缝，
       正好在格与格之间露出一条连续的奶油线。
       高度上限：沙面在 y=0.05，台座顶抬到 0.085 就只露出 0.035 —— 够读成一条边，又不会把格子架空。 */
    geoPad = extrude(TILE + 0.12, TILE + 0.12, 0.16, 0.30, true);
    geoPad.computeBoundingBox();
    geoPad.translate(0, -geoPad.boundingBox.max.y + 0.085, 0);
    /* 持有者色环：贴在台座上沿的一圈彩色裙边（比格面宽 0.06）。
       上限同样是 SPACING —— 环再宽就会与邻格的环相撞。 */
    geoRim = new THREE.BoxGeometry(TILE + 0.12, 0.13, TILE + 0.12);
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
  function paintOwners() {
    if (!rimGroup) { rimGroup = new THREE.Group(); scene.add(rimGroup); }
    rimGroup.clear();
    for (const cell of state.board) {
      const decal = decalByCell.get(cell.id);
      const pid = view.owners[cell.id];
      if (!pid) { if (decal) decal.position.y = tileTop + 0.012; continue; }
      const { x, z } = cellPos(cell.id);
      const plinth = new THREE.Mesh(geoRim, mat(new THREE.Color(cssOf(pid)), { roughness: 0.55 }));
      plinth.position.set(x, 0.085, z);
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
  const DICE_SIZE = 1.15;
  function buildDice() {
    diceGroup = new THREE.Group();
    /* 骰盘：把骰子放进中央广场南侧的木盘里。原先是 0.86 的方块埋在草里，
       在默认镜头下只是中间一个白点。现在放大到 1.15 并抬到草地顶面之上。 */
    const tray = new THREE.Mesh(new THREE.CircleGeometry(2.5, 36), mat(0xe6d8b6, { roughness: 0.92 }));
    tray.rotation.x = -Math.PI / 2; tray.position.y = groundY + 0.01;
    scene.add(tray);
    const trayRim = new THREE.Mesh(new THREE.RingGeometry(2.5, 2.72, 36), mat(0xc9b48a, { roughness: 0.85 }));
    trayRim.rotation.x = -Math.PI / 2; trayRim.position.y = groundY + 0.014;
    scene.add(trayRim);
    fillDice(state.dice ? state.dice.length : 1, state.dice);
    diceGroup.position.set(0, groundY, 2.7);
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
      cube.position.set((i - (n - 1) / 2) * 1.5, DICE_SIZE / 2 + 0.06, 0);
      cube.userData.value = values ? (values[i] || 1) : 1;
      settle(cube, cube.userData.value);
      diceGroup.add(cube);
    }
  }
  /**
   * 把骰子甩出去：颗数按这次真的掷了几颗重建（骰力道具会把一颗变两三颗），
   * 旋转结束后翻向本次掷出的真实点数。
   * 俯视时骰子留在中央骰盘；近景等距里骰盘在镜头外，就搬到行动者脚下那一格旁边。
   */
  function throwDice(values, from) {
    if (!diceGroup) return;
    const vals = (values && values.length ? values : [1]).slice(0, 4);
    if (diceGroup.children.length !== vals.length) fillDice(vals.length, null);
    const near = camMode === 'iso';
    const a = near ? cellPos(from) : { x: 0, z: 2.7 };
    diceGroup.position.set(a.x + (near ? 0.8 : 0), near ? tileTop : groundY, a.z + (near ? 0.8 : 0));
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

  /* ---------- 两套镜头 ----------
   * top（默认）  透视俯视：看全盘，用来做决策。早前为「棋局要看得见」服务。
   * iso（近景）  正交等距：看角色。参考《環島大富翁》那种「人物站在棋盘上、周围只露几格」的取景。
   *
   * iso 为什么必须是正交：
   *   透视投影下越远越小，一张 5 格进深的画面里，近处格子和远处格子尺寸差得明显，
   *   等距菱形也会被扭歪（不是规则 2:1）。正交投影让所有格子一样大，这才是等距棋盘的观感。
   * iso 的角度：
   *   az 45° / el 35.264°（= atan(1/√2)）是标准等距角，正方形格子在屏幕上正好投影成 2:1 菱形。
   * iso 的「距离」用 cam.dist 复用了，但语义换成「正交视野竖直覆盖多少世界单位」。
   *   复用而不是新开一个变量，是为了让既有的补间状态机（focusPlayer / stepCamera）原样工作。
   */
  const ISO = {
    az: 45, el: 35.264,
    view: 9.6,           // 竖直覆盖 9.6 世界单位；SPACING=2 → 约 4.8 格进深（“只显示几格”）
    /* 视野上下限。上限给到 80 不是为了「近景能拉这么远」，而是为了让两种模式的**互切不跳**：
       俯视的距离范围是 42~130，换算成等效视野就是 25~78。上限若卡在 22，
       从默认俯视（等效 42）切进来的那一帧会被夹到 22 —— 肉眼就是「切的一瞬间先猛地推近一次」。
       给到 80 之后换算值原样落地，后续全靠补间平滑推近。 */
    viewMin: 7.0, viewMax: 80,
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
       注意只夹横向：竖直视野不动，所以两种模式互切的等效换算（见 viewFromDist）不受影响。 */
    maxAspect: 1.5,
  };
  const TOP_SHADOW = 34;
  let camMode = 'top';                     // top | iso
  let topMemory = { az: 0, el: 46, dist: 70 };   // 离开 top 时记下手选机位，回来时恢复

  /* 竖向 fov 固定。舞台早前强制 1:1，宽屏时两侧留出大片空壳；改成铺满之后必须按宽高比补偿：
     画面比参考更「窄」（竖屏/方屏）时水平可视范围变小，镜头要等比退远，否则棋盘左右会被切。 */
  const FRAME_ASPECT = 1.0;
  /* 注意：这里刻意从 host 尺寸算宽高比，而不是读 camera.aspect ——
     现在有两台相机，谁在前台会变，读数跟着变会让 frameScale 在切换瞬间抖一下。 */
  const viewAspect = () => {
    const w = host ? host.clientWidth : 1, h = host ? host.clientHeight : 1;
    return h > 0 ? w / h : 1;
  };
  const frameScale = () => {
    const a = viewAspect();
    return a >= FRAME_ASPECT ? 1 : FRAME_ASPECT / a;
  };
  /* 透视 dist ↔ 正交 view 的等效换算：透视在目标平面上的可视高度 ≈ 2·d·tan(fov/2)·frameScale。
     两种模式互切时用它做一次换算，否则换相机的那一帧会「跳」一下（70 被当成 70 世界单位的正交视野）。 */
  const perspHalfTan = () => Math.tan(THREE.MathUtils.degToRad((perspCam ? perspCam.fov : 32) / 2));
  const viewFromDist = (d) => 2 * d * perspHalfTan() * frameScale();
  const distFromView = (v) => v / Math.max(1e-4, 2 * perspHalfTan() * frameScale());
  const orthoView = () => Math.min(ISO.viewMax, Math.max(ISO.viewMin, cam.dist));
  /* 近景实际生效的宽高比 = 舞台宽高比，但横向最多 ISO.maxAspect 倍（见 ISO.maxAspect 注释）。
     小地图的取景框必须用这个值而不是舞台宽高比，否则超宽屏下框会比实际视野宽一截。 */
  const isoAspect = () => Math.min(viewAspect(), ISO.maxAspect);
  /* 俯角下限在两种模式里不一样：俯视要能压到 16°（贴地平视看格子立面），
     近景等距压太低会让格子的菱形被拉成长条、失去等距的规整感，所以抬到 24°。 */
  const clampEl = (v) => (camMode === 'iso'
    ? Math.min(62, Math.max(24, v))
    : Math.min(78, Math.max(16, v)));

  function applyCam() {
    const el = THREE.MathUtils.degToRad(cam.el), az = THREE.MathUtils.degToRad(cam.az);
    const dx = Math.sin(az) * Math.cos(el), dy = Math.sin(el), dz = Math.cos(az) * Math.cos(el);
    if (camMode === 'iso') {
      const h = orthoView(), w = h * isoAspect();
      orthoCam.left = -w / 2; orthoCam.right = w / 2; orthoCam.top = h / 2; orthoCam.bottom = -h / 2;
      /* 注视点与相机位姿同步抬高 aimY：方向不变 ⇒ 正交投影下只是整幅画面刚性下移，
         等距菱形的角度一分不变。见 ISO.aimY 的注释。 */
      const ay = target.y + ISO.aimY;
      orthoCam.position.set(target.x + dx * ISO.depth, ay + dy * ISO.depth, target.z + dz * ISO.depth);
      orthoCam.updateProjectionMatrix();
      orthoCam.lookAt(target.x, ay, target.z);
      camera = orthoCam;                      // raycast / project 一直取当前这台
    } else {
      const d = cam.dist * frameScale();
      perspCam.position.set(target.x + dx * d, target.y + dy * d, target.z + dz * d);
      perspCam.lookAt(target);
      camera = perspCam;
      /* 持续记录「俯视机位」。为什么不在切走那一刻才采样：切走的瞬间很可能正处在一次补间中间
         （刚点完复位 / 刚换完回合就往近景切），这时 cam.dist 是个半途值 ——
         记下来会让「回到全盘」停在一个不上不下的距离上，棋盘放不满。
         只在「不在补间里」的时候记，拿到的就一定是一台停稳的机位。 */
      if (!camTween) topMemory = { az: cam.az, el: cam.el, dist: cam.dist };
    }
    syncKeyLight();
  }

  /* 阴影相机跟随注视点：默认 ±34 覆盖全盘，1024 的阴影图摊到 68 单位上只有 15px/单位，
     近景下接触阴影会糊成一片。切到 iso 时收窄到 ±13，同时让光源跟着走 —— 近景只看得到局部，
     没必要为全盘支付分辨率。 */
  function syncKeyLight() {
    if (!keyLight) return;
    const ext = camMode === 'iso' ? ISO.shadow : TOP_SHADOW;
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
   *   idle    自由视角，完全由用户拖拽 / 预设掌控
   *   intro   聚焦入场：注视点与镜头位姿从「当前值」补间到「该玩家 + 近景」，期间 locked=true 屏蔽输入
   *   follow  跟随：注视点以指数平滑追该玩家的棋子，棋子每跳一格都能立刻跟上且不抖
   *
   * 为什么注视点要 clamp：棋盘 34 单位见方，镜头拉到近景时视野只有 ~29 单位。
   * 若把注视点直接钉在角落棋子上，棋盘会被甩出画面、玩家没法看局。所以跟随的是
   * 「朝玩家方向偏移、但离棋盘中心不超过 followClamp」的点 —— 玩家始终在画面偏中位置，
   * 棋盘其余部分也留住。真正的「这是谁的回合」由地面上的高亮环 + 名牌金底来强调。
   */
  const CAM = {
    focusEl: 43,          // 近景俯角（全局默认 46°）
    focusDist: 54,        // 近景距离（全局默认 70）—— 数值受「棋盘要装得下」约束，见 resize/frameScale
    followClamp: 8,       // 注视点离棋盘中心的最大半径
    introMs: 1150,        // 入场时长
    followHalfLife: 0.16, // 跟随平滑半衰期（秒）
  };
  const CAM_PRESETS = {
    reset: { az: 0, el: 46, dist: 70 },
    top: { az: 0, el: 78, dist: 64 },
    tilt: { az: 45, el: 38, dist: 88 },
    side: { az: 30, el: 26, dist: 82 },
  };
  let camState = 'idle';        // idle | intro | follow
  let followPid = null;
  let camTween = null;
  let locked = false;           // 输入闸门：intro 期间为 true
  let focusRing = null;

  const easeInOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const lerp = (a, b, k) => a + (b - a) * k;
  /* 注视点夹取（只在 top 模式）。近景 iso 下必须原样返回：
     「人物站在棋盘上」的全部意义就是让他居中，夹取到离环心 8 单位反而会把角色推出画面。
     两种模式在这里分叉，是因为它们要解决的问题正好相反 —— top 怕棋盘跑出视野，iso 怕角色跑出视野。 */
  function clampToBoard(x, z) {
    if (camMode === 'iso') return { x, z };
    const r = Math.hypot(x, z);
    if (r <= CAM.followClamp) return { x, z };
    const s = CAM.followClamp / r;
    return { x: x * s, z: z * s };
  }

  /* 从当前模式推默认机位。调用方只给 pid 时，focusPlayer 会落到这套值上。 */
  function modeView() {
    return camMode === 'iso'
      ? { el: ISO.el, dist: ISO.view, az: ISO.az }
      : { el: CAM.focusEl, dist: CAM.focusDist, az: cam.az };
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
      const geo = new THREE.RingGeometry(TILE * 0.33, TILE * 0.45, 22);
      geo.rotateX(-Math.PI / 2);
      pickOverlay = new THREE.InstancedMesh(geo,
        new THREE.MeshBasicMaterial({ color: 0x7fe07a, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
        Math.max(1, tileMeshes.length));
      pickOverlay.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      pickOverlay.renderOrder = 4;
      pickOverlay.visible = false;
      scene.add(pickOverlay);
    }
    const mat4 = new THREE.Matrix4();
    for (let i = 0; i < pickIds.length; i++) {
      const p = cellPos(pickIds[i]);
      mat4.makeTranslation(p.x, tileTop + 0.03, p.z);
      pickOverlay.setMatrixAt(i, mat4);
    }
    pickOverlay.count = pickIds.length;
    pickOverlay.instanceMatrix.needsUpdate = true;
    pickOverlay.visible = on;
  }

  /**
   * 轮到 pid 操作：拉近并聚焦，随后进入跟随。
   * @param {string} pid
   * @param {{immediate?:boolean, el?:number, dist?:number, az?:number, dur?:number}} [opts]
   *        immediate 用于首帧 / 无动效偏好；不传 el/dist/az 就落到当前模式的默认机位。
   */
  function focusPlayer(pid, opts) {
    const o = opts || {};
    const g = tokenGroups.get(pid);
    if (!g || !camera) return;
    const mv = modeView();
    followPid = pid;
    updateFocusRing(pid);
    const c = clampToBoard(g.position.x, g.position.z);
    const toEl = o.el != null ? o.el : mv.el;
    const toDist = o.dist != null ? o.dist : mv.dist;
    const toAz = o.az != null ? o.az : mv.az;
    if (o.immediate || REDUCED) {
      cam.el = toEl; cam.dist = toDist; cam.az = toAz;
      target.set(c.x, target.y, c.z);
      camTween = null; camState = 'follow';
      applyCam();
      setLocked(false);
      hooks.onCameraSettled && hooks.onCameraSettled(pid);
      return;
    }
    /* az 也进补间：模式互切时从 0° 平滑转到 45°（等距方位），不是硬切。
       走最短弧 —— 直接 lerp 会在 350°→10° 时反向绕一整圈。 */
    const dAz = (((toAz - cam.az) % 360) + 540) % 360 - 180;
    camTween = {
      t: 0, dur: Math.max(0.15, (o.dur != null ? o.dur : CAM.introMs) / 1000),
      /* 补齐「哪些参数该动」：用户已经在中意的机位上，focusPlayer 只该挪注视点，
         不该把俯角/距离一起拽回默认值（那会让人觉得自己调的机位每次换回合都被抹掉）。 */
      use: {
        el: o.el != null || camMode === 'iso',
        dist: o.dist != null || camMode === 'iso',
        az: o.az != null || camMode === 'iso',
      },
      from: { tx: target.x, tz: target.z, el: cam.el, dist: cam.dist, az: 0 },
      to: { tx: c.x, tz: c.z, el: toEl, dist: toDist, az: dAz },
    };
    camState = 'intro';
    setLocked(true);
    applyCam();
  }

  /**
   * 切换镜头模式：top（透视战略俯视）↔ iso（正交近景等距）。
   * 换的是「相机实例」，所以必须把 cam.dist 的语义一起换算过去 ——
   * 70 在透视里是「退到 70 单位外」，在正交里是「竖直覆盖 70 单位」，直接沿用会跳一大下。
   * 同时记/恢复手选机位，让用户切来切去不丢自己调好的角度。
   */
  function setCamMode(mode, pid) {
    const m = mode === 'iso' ? 'iso' : 'top';
    if (m === camMode) return camMode;
    const who = pid || followPid || (state ? state.players[state.currentPlayerIndex].id : null);
    if (m === 'iso') {
      /* topMemory 由 applyCam 在「俯视 + 不在补间」时持续维护，这里不再采样 —— 理由见 applyCam */
      camMode = 'iso';
      cam.dist = viewFromDist(cam.dist);     // 等效视野高度，保证换相机那一帧不跳
    } else {
      camMode = 'top';
      cam.dist = distFromView(cam.dist);     // 同样先换成等效透视距离：补间的「起点」才接得上
      /* 注意：这里刻意**不**把 cam.az / cam.el 直接改成 topMemory 的值。
         直接改会让「上一帧 45°/35.3° → 下一帧 46°/43°」在换相机那一帧硬跳一下；
         交给 focusPlayer 的补间去转，才是真正的平滑。 */
    }
    /* 切完再 focusPlayer，并且**显式把 el/dist/az 一起交代过去**。
       不交代的话，focusPlayer 的 `use` 遮罩会跳过 dist —— 因为 top 模式「不传就不改机位」，
       于是「回到全盘」会把透视相机留在近景的等效距离(≈16)上：按钮点了跟没点一样，
       棋盘还是放不满。切回 top 时补的 dist 取 topMemory.dist，也就是离开前那台机位的距离，
       整个动作于是读成一次平滑的拉远，而不是瞬移。 */
    if (who && tokenGroups.has(who)) {
      const to = m === 'iso'
        ? { az: ISO.az }
        : { az: topMemory.az, el: topMemory.el, dist: topMemory.dist };
      focusPlayer(who, to);
    } else {
      if (m === 'top') { cam.az = topMemory.az; cam.el = topMemory.el; }
      applyCam(); syncKeyLight();
    }
    hooks.onCameraMode && hooks.onCameraMode(camMode);
    return camMode;
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
      const f = camTween.from, to = camTween.to, use = camTween.use;
      target.x = lerp(f.tx, to.tx, e);
      target.z = lerp(f.tz, to.tz, e);
      if (use.el) cam.el = lerp(f.el, to.el, e);
      if (use.dist) cam.dist = lerp(f.dist, to.dist, e);
      if (use.az) cam.az += to.az * (e - (camTween.eAz || 0));
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
        const c = clampToBoard(g.position.x, g.position.z);
        const k = 1 - Math.pow(0.5, dt / CAM.followHalfLife);
        target.x += (c.x - target.x) * k;
        target.z += (c.z - target.z) * k;
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

  function setHover(id) {
    if (hoverCell === id) return;
    if (hoverCell != null) {
      const old = tileMeshes.find((m) => m.userData.cellId === hoverCell);
      if (old) old.scale.set(1, 1, 1);
    }
    hoverCell = id;
    if (id != null) {
      const m = tileMeshes.find((x) => x.userData.cellId === id);
      if (m) m.scale.set(1.06, 1.5, 1.06);
    }
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
      /* 近景的「距离」是正交视野高度，量纲完全不同 —— 同一个 ±4 步长在透视里退 4 单位，
         在近景里会把视野从 10.4 直接推到 14.4（放大率掉 30%），滚一格就跳。所以分开给步长。 */
      cam.dist = camMode === 'iso'
        ? Math.min(ISO.viewMax, Math.max(ISO.viewMin, cam.dist + s * 0.7))
        : Math.min(130 * islandK(), Math.max(42, cam.dist + s * 4));
      applyCam();
    }, { passive: false });
    host.addEventListener('keydown', (e) => {
      if (locked) return;
      const K = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
      if (!K) return;
      e.preventDefault();
      cam.az += K[0] * (camMode === 'iso' ? 5 : 6);   // 近景每次 5°，正好 18 次转一圈
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
    if (selCell != null && !REDUCED) {
      const m = tileMeshes.find((x) => x.userData.cellId === selCell);
      if (m) m.position.y = 0.12 + Math.sin(t * 5) * 0.05;
    }
    /* 选格绿环的呼吸：只在选态里跑；`prefers-reduced-motion` 下固定不脉动 */
    if (pickOverlay && pickOverlay.visible) {
      pickOverlay.material.opacity = REDUCED ? 0.8 : 0.5 + 0.32 * Math.sin(t * 4.6);
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
      /* 两台相机都要跟：谁是当前相机由 camMode 决定，漏掉一台会在切换后拿到陈旧的比例 */
      perspCam.aspect = w / hgt;
      perspCam.updateProjectionMatrix();
      applyCam();          // 宽高比变了要重算取景距离（ortho 的左右边界也在这里重算）
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
      const dist = camMode === 'iso'
        ? orthoView() * 4.6
        : camera.position.distanceTo(new THREE.Vector3(x, y, z));
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
    /** 预设视角。会先释放跟随 —— 否则用户手选的机位下一帧就被跟随逻辑拽回玩家身上 */
    setView(preset) {
      /* 4 个预设是「战略俯视」的机位。在近景里点它 = 想回全盘，所以顺手退出 iso，
         不然会出现「点了复位但视野还是 5 格宽」的怪状态。 */
      if (camMode === 'iso') { camMode = 'top'; cam.dist = distFromView(cam.dist); hooks.onCameraMode && hooks.onCameraMode(camMode); }
      releaseFollow();
      const P = CAM_PRESETS[preset] || CAM_PRESETS.reset;
      // 预设里的距离同样按 64 环定，随棋盘半径一起放大（见 buildWorld 里 cam.dist 那段）
      Object.assign(cam, { ...P, dist: P.dist * islandK() });
      topMemory = { az: P.az, el: P.el, dist: cam.dist };
      applyCam();
    },
    /** 切镜头模式：'top' 战略俯视（透视）/ 'iso' 近景等距（正交） */
    setCamMode(mode, pid) { return setCamMode(mode, pid); },
    camMode: () => camMode,
    /**
     * 当前模式下的「聚焦机位」（top = 俯视近景 el43/dist54，iso = 等距近景 az45/el35.3/view9.6）。
     * 给「镜头巡演」用：它要验收的是「拉近 → 跟随 → 解锁」，必须让机位真的动起来。
     * focusPlayer 默认不传 el/dist 就不改机位（避免把用户手调的机位拽回默认），
     * 巡演要是也不传，俯视下就只平移注视点 —— 画面上几乎看不出变化，会被当成按钮坏了。
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
      mode: camMode, az: cam.az, el: cam.el,
      view: camMode === 'iso' ? orthoView() : viewFromDist(cam.dist),
      /* 近景实际生效的横向倍率（已夹 ISO.maxAspect）。小地图取景框要用它，不能自己算舞台宽高比。
         俯视下如实报原始宽高比 —— 报一个被夹过的值会让人以为俯视也受了限。 */
      aspect: camMode === 'iso' ? isoAspect() : viewAspect(),
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
