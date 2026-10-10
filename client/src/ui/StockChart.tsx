import { useEffect, useRef, useState } from 'react';
import { candleRange, type Stock } from '@richman/shared';

/**
 * 画布尺寸**跟着容器走**，不再写死 336×130。
 *
 * 原来 svg 是固定 viewBox + `width="100%"`，容器变宽时浏览器只会按比例居中留白 ——
 * 于是把弹层从 600px 放宽到 1120px 之后，K 线还是原来那么大，右下角多出两片空白。
 * 现在量容器实际宽度重算 viewBox：宽了多画几天、价格区也长高，蜡烛跟着变宽。
 */
const PAD = 16; // .stock-chart 左右各 8px 内边距
const MIN_W = 240;
const MAX_W = 1300;
const PITCH = 22; // 每根 K 线目标占位（px），决定「同宽下能看几天」
const MAX_STEP = 90; // 蜡烛少时别把它们摊到屏幕两端 —— 超过这个间距就改成居中一块画
const MIN_VISIBLE = 12;

const UP = '#e5484d'; // 红涨
const DOWN = '#30a46c'; // 绿跌
const FLAT = '#8a8f98';
const VOL_TOTAL = '#3f4a57';
const VOL_PLAYER = '#f5b74c'; // 玩家真实成交那一段单独着色

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 日 K 线 + 成交量（玩法文档 §3.4 的自定扩展）。
 *
 * 纯 SVG 手绘，不引第三方图表库：一屏十几到几十根、每根 4 个数，画出来比装一个 200KB 的
 * 图表库更可控，也方便沿用面板既有的配色。
 */
export function StockChart({ stock }: { stock: Stock }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxW, setBoxW] = useState(336);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = (w: number) => setBoxW(clamp(Math.round(w) - PAD, MIN_W, MAX_W));
    apply(el.clientWidth || 336 + PAD);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width + PAD);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const all = stock.candles;
  if (all.length === 0) {
    return (
      <div className="stock-chart empty" ref={boxRef}>
        {stock.name}：尚无 K 线 —— 每过一个交易日收一根
      </div>
    );
  }

  const W = boxW;
  const PRICE_H = clamp(Math.round(W * 0.16), 92, 200);
  const VOL_H = clamp(Math.round(PRICE_H * 0.33), 30, 64);
  const GAP = 8;
  const H = PRICE_H + VOL_H + GAP;

  const visible = clamp(Math.floor(W / PITCH), MIN_VISIBLE, all.length);
  const candles = all.slice(-visible);

  const { high, low } = candleRange(candles);
  const top = Math.max(high, stock.price);
  const bottom = Math.min(low, stock.price);
  const span = Math.max(1, top - bottom);
  const y = (v: number) => PRICE_H - ((v - bottom) / span) * PRICE_H;

  const maxVolume = Math.max(1, ...candles.map((c) => c.volume));
  /* 蜡烛少（刚开盘几天）时，别按容器宽度平均撒开 —— 5 根摊在 1000px 上会各占 200px、
     饼一样宽，右边还空一大片。改成「一块居中画布」：间距封顶 MAX_STEP，整块居中。 */
  const step = Math.min(W / candles.length, MAX_STEP);
  const plotW = step * candles.length;
  const x0 = (W - plotW) / 2;
  const bodyW = Math.max(2, Math.min(step * 0.6, 26));
  const last = candles[candles.length - 1]!;

  return (
    <div className="stock-chart" ref={boxRef}>
      <div className="stock-chart-head">
        <b>{stock.name}</b>
        <span className={last.close >= last.open ? 'up' : 'down'}>¥{stock.price.toLocaleString('zh-CN')}</span>
        <span className="stock-chart-meta">
          近 {candles.length} 个交易日 · 区间 ¥{bottom.toLocaleString('zh-CN')}–¥{top.toLocaleString('zh-CN')} · 流通{' '}
          {stock.floatShares.toLocaleString('zh-CN')} 股
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${stock.name} 日 K 线与成交量`}>
        {/* 价格网格：顶、中、底三条，够读出相对位置即可 */}
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={PRICE_H * f} y2={PRICE_H * f} stroke="#243039" strokeWidth={1} />
        ))}
        {candles.map((c, i) => {
          const cx = x0 + i * step + step / 2;
          const color = c.close > c.open ? UP : c.close < c.open ? DOWN : FLAT;
          const bodyTop = y(Math.max(c.open, c.close));
          const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)));
          const volH = (c.volume / maxVolume) * VOL_H;
          const playerH = (c.playerVolume / maxVolume) * VOL_H;
          return (
            <g key={c.day}>
              <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={1} />
              <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={color}>
                <title>{`${c.day} 日　开 ${c.open} 高 ${c.high} 低 ${c.low} 收 ${c.close}　量 ${c.volume}（玩家 ${c.playerVolume}）`}</title>
              </rect>
              <rect x={cx - bodyW / 2} y={PRICE_H + GAP + (VOL_H - volH)} width={bodyW} height={volH} fill={VOL_TOTAL}>
                <title>{`成交量 ${c.volume} 股，其中玩家成交 ${c.playerVolume} 股`}</title>
              </rect>
              {c.playerVolume > 0 && (
                <rect
                  x={cx - bodyW / 2}
                  y={PRICE_H + GAP + (VOL_H - playerH)}
                  width={bodyW}
                  height={playerH}
                  fill={VOL_PLAYER}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="stock-chart-foot">
        <span>
          最新一根：开 {last.open} 收 {last.close} 高 {last.high} 低 {last.low}
        </span>
        <span>
          量 {last.volume.toLocaleString('zh-CN')} 股
          {last.playerVolume > 0 ? `（含玩家 ${last.playerVolume.toLocaleString('zh-CN')}）` : ''}
        </span>
      </div>
    </div>
  );
}
