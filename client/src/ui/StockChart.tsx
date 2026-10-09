import { candleRange, type Stock } from '@richman/shared';

/** 画布尺寸：侧栏宽度有限，20 根日 K 已够看趋势 */
const W = 336;
const PRICE_H = 92;
const VOL_H = 30;
const GAP = 8;
const H = PRICE_H + VOL_H + GAP;
const VISIBLE = 20;

const UP = '#e5484d'; // 红涨
const DOWN = '#30a46c'; // 绿跌
const FLAT = '#8a8f98';
const VOL_TOTAL = '#3f4a57';
const VOL_PLAYER = '#f5b74c'; // 玩家真实成交那一段单独着色

/**
 * 日 K 线 + 成交量（玩法文档 §3.4 的自定扩展）。
 *
 * 纯 SVG 手绘，不引第三方图表库：一屏 20 根、每根 4 个数，画出来比装一个 200KB 的
 * 图表库更可控，也方便沿用面板既有的配色。
 */
export function StockChart({ stock }: { stock: Stock }) {
  const candles = stock.candles.slice(-VISIBLE);
  if (candles.length === 0) {
    return (
      <div className="stock-chart empty">
        {stock.name}：尚无 K 线 —— 每过一个交易日收一根
      </div>
    );
  }

  const { high, low } = candleRange(candles);
  const top = Math.max(high, stock.price);
  const bottom = Math.min(low, stock.price);
  const span = Math.max(1, top - bottom);
  const y = (v: number) => PRICE_H - ((v - bottom) / span) * PRICE_H;

  const maxVolume = Math.max(1, ...candles.map((c) => c.volume));
  const step = W / VISIBLE;
  const bodyW = Math.max(2, step * 0.6);
  const last = candles[candles.length - 1]!;

  return (
    <div className="stock-chart">
      <div className="stock-chart-head">
        <b>{stock.name}</b>
        <span className={last.close >= last.open ? 'up' : 'down'}>¥{stock.price.toLocaleString('zh-CN')}</span>
        <span className="stock-chart-meta">
          {candles.length} 个交易日 · 区间 ¥{bottom.toLocaleString('zh-CN')}–¥{top.toLocaleString('zh-CN')} · 流通{' '}
          {stock.floatShares.toLocaleString('zh-CN')} 股
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${stock.name} 日 K 线与成交量`}>
        {/* 价格网格：顶、中、底三条，够读出相对位置即可 */}
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={PRICE_H * f} y2={PRICE_H * f} stroke="#243039" strokeWidth={1} />
        ))}
        {candles.map((c, i) => {
          const cx = i * step + step / 2;
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
