/* 2.5D 叠加层（Pixi JS）：只画「跟着世界动」的 2D 界面件
 * 棋子名牌 / 选中格的说明气泡 / 飘字。棋盘格上的地名由 world.js 贴成纹理，两层分工写在这里。
 * 每帧由 world 的 onFrame 钩子调 tick()，把世界坐标投影成屏幕坐标。 */
(function () {
  'use strict';
  const PIXI = globalThis.PIXI;
  let app, host, names, floats, stage = null, S = null;
  const plates = new Map();
  const floatsQ = [];

  const FONT = '"M PLUS Rounded 1c","PingFang SC","Microsoft YaHei",system-ui';

  /* 名牌：棕底白字（和整套奶油皮肤不搭）→ 奶油底板 + 描边 + 玩家色圆点 + 软投影。
     带圆点时就多留 22px 给圆点，pivot 仍是「底边中点」，方便往上立。 */
  function pill(text, tone, dotHex) {
    const c = new PIXI.Container();
    const g = new PIXI.Graphics();
    const dot = dotHex != null ? 22 : 0;
    const t = new PIXI.Text(text, {
      fontFamily: FONT, fontWeight: '800', fontSize: 15,
      fill: tone === 'gold' ? 0x8a6410 : tone === 'bad' ? 0x9a2c22 : 0x6b5940,
    });
    const w = t.width + 20 + dot, h = t.height + 10, r = h / 2;
    const edge = tone === 'gold' ? 0xe0a51f : tone === 'bad' ? 0xc0483c : 0x7a6547;
    g.beginFill(0x7a6547, 0.16);                       // 软投影
    g.drawRoundedRect(2, 4, w, h, r);
    g.endFill();
    g.lineStyle(3, edge, 1);
    g.beginFill(tone === 'gold' ? 0xfff3d6 : tone === 'bad' ? 0xffe9e6 : 0xfffbef, 1);
    g.drawRoundedRect(0, 0, w, h, r);
    g.endFill();
    if (dot) {
      g.lineStyle(0);
      g.beginFill(dotHex, 1);
      g.drawCircle(11 + dot / 2, h / 2, 6.5);
      g.endFill();
    }
    t.position.set(10 + dot, 5);
    c.addChild(g, t);
    c.pivot.set(c.width / 2, c.height);
    return c;
  }

  const api = {
    mount(el, Snap) {
      host = el; S = Snap;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
      el.appendChild(canvas);
      app = new PIXI.Application({
        view: canvas, backgroundAlpha: 0, antialias: true,
        resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: false,
        preserveDrawingBuffer: true,
        width: el.clientWidth || 600, height: el.clientHeight || 600,
      });
      names = new PIXI.Container(); floats = new PIXI.Container();
      app.stage.addChild(names, floats);
      api.rebuild();
      return api;
    },
    rebuild() {
      if (!app) return;
      names.removeChildren().forEach((c) => c.destroy({ children: true }));
      plates.clear();
      for (const a of globalThis.D25World.tokenAnchors()) {
        const p = S.state.players.find((x) => x.id === a.pid);
        const mine = S.view.assets.find((x) => x.playerId === a.pid);
        const c = pill(`${a.cur ? '▶ ' : ''}${a.name} 🔔${Math.round(mine ? mine.total : p.cash).toLocaleString('zh-CN')}`, a.cur ? 'gold' : undefined, p.color);
        c.userData = a;
        names.addChild(c);
        plates.set(a.pid, c);
      }
    },
    /** 在世界坐标上飘一条字（买地、收租之类的表现反馈） */
    float(text, cellId, tone) {
      if (!app) return;
      const anchor = globalThis.D25World.tileAnchor(cellId);
      const c = pill(text, tone);
      c.userData = { ...anchor, born: performance.now(), rise: 78 };
      floats.addChild(c);
      floatsQ.push(c);
      while (floatsQ.length > 6) floatsQ.shift().destroy({ children: true });
    },
    tick() {
      if (!app || !host) return;
      const w = host.clientWidth || 600, h = host.clientHeight || 600;
      if (app.renderer.width !== w || app.renderer.height !== h) app.renderer.resize(w, h);
      const now = performance.now();
      for (const c of names.children) {
        const a = c.userData;
        const s = globalThis.D25World.project(a.x, a.y, a.z);
        const sc = labelScale(s.dist);
        /* 名牌超出台面会被 .d25-stage 的圆角 overflow 裁掉（左缘的玩家实测被切）→ 按自身尺寸贴边内收 8px */
        const halfW = (c.width / 2) * sc, tall = c.height * sc;
        c.position.set(
          Math.max(8 + halfW, Math.min(w - 8 - halfW, s.x)),
          Math.max(8 + tall, Math.min(h - 8, s.y)),
        );
        c.scale.set(sc, sc);
        c.visible = s.vis;
        c.zIndex = 1000 - Math.round(s.dist * 10);
      }
      names.sortableChildren = true;
      for (let i = floatsQ.length - 1; i >= 0; i--) {
        const c = floatsQ[i];
        const k = (now - c.userData.born) / 1300;
        if (k >= 1) { c.destroy({ children: true }); floatsQ.splice(i, 1); continue; }
        const s = globalThis.D25World.project(c.userData.x, c.userData.y + k * 1.2, c.userData.z);
        c.position.set(s.x, s.y - k * c.userData.rise);
        c.alpha = 1 - k * k;
        c.scale.set(labelScale(s.dist) * (1 + k * 0.1), labelScale(s.dist) * (1 + k * 0.1));
      }
      app.render();
    },
    dispose() {
      app && app.destroy(true, { children: true });
      app = null; plates.clear(); floatsQ.length = 0;
      if (host) host.querySelectorAll('canvas').forEach((c) => c.remove());
    },
  };
  // 远近只做轻微缩放：透视由 three 负责，这里避免名牌大小跳变
  function labelScale(dist) {
    return Math.max(0.72, Math.min(1.12, 46 / Math.max(12, dist)));
  }
  globalThis.D25Overlay = api;
})();
