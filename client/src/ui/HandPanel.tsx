import { useState } from 'react';
import { availableActions, CARDS, FACILITIES, FACILITY_ORDER, ITEMS, MAX_HAND_CARDS, MAX_ITEM_COUNT, playersInViewport } from '@richman/shared';
import type { FacilityType, GameState, PlayerAction } from '@richman/shared';

/** 需要显式选择目标格（默认不取脚下）的卡片 */
const CARD_REQUIRES_CELL = new Set(['swap-land', 'swap-house', 'rebuild']);
/** 需要显式选择目标格（默认不取脚下）的道具 */
const ITEM_REQUIRES_CELL = new Set(['roadblock', 'mine', 'missile', 'nuke', 'teleporter']);

/** 手牌 / 道具面板：展示当前玩家的卡片与道具并提供使用入口（含目标/股票/格/骰点参数选择） */
export function HandPanel({ game, onAction, interactive = true }: { game: GameState; onAction: (a: PlayerAction) => void; interactive?: boolean }) {
  const [targetId, setTargetId] = useState('');
  const [stockId, setStockId] = useState('');
  const [cellId, setCellId] = useState<number | ''>('');
  const [diceValue, setDiceValue] = useState(6);
  const [facility, setFacility] = useState<FacilityType>('mall');

  const current = game.players[game.currentPlayerIndex];
  const actions = availableActions(game);
  if (!current || (current.cards.length === 0 && Object.keys(current.items).length === 0)) return null;

  // D-43：「指定对手」的候选名单与引擎的视野校验共用同一份口径（近景窗 16 格内），
  // 否则又会出现「按钮给得出、引擎该拒绝」的老毛病。飞弹/核弹/传送机是全局射程，不走这条。
  const others = playersInViewport(game, current);
  const effectiveTarget = targetId && others.some((p) => p.id === targetId) ? targetId : others[0]?.id ?? '';
  const effectiveStock = game.stockMarket.stocks.some((s) => s.id === stockId) ? stockId : game.stockMarket.stocks[0]?.id ?? '';

  const heldCards = current.cards.filter((id) => CARDS[id]);
  const heldItems = Object.keys(current.items).filter((id) => ITEMS[id] && (current.items[id] ?? 0) > 0);
  const itemCount = heldItems.reduce((n, id) => n + (current.items[id] ?? 0), 0);

  const cardNeedsCell = heldCards.some((id) => {
    const t = CARDS[id]!.target;
    return t === 'land' || t === 'building';
  });
  const itemNeedsCell = heldItems.some((id) => {
    const t = ITEMS[id]!.target;
    return t === 'cell' || t === 'land';
  });
  // 有「任意格」目标道具（路障/地雷/飞弹/核弹/传送机）时列出全地图，否则只列土地与路面道具
  const anyCellTarget = heldItems.some((id) => ITEMS[id]!.target === 'cell');
  const cellOptions = anyCellTarget
    ? game.board
    : game.board.filter((c) => c.type === 'property' || c.type === 'commercial'
        || game.mines.some((o) => o.cellId === c.id) || game.roadblocks.some((o) => o.cellId === c.id));
  const needsCell = cardNeedsCell || itemNeedsCell;
  const currentCellName = game.board[current.position]?.name ?? `${current.position}`;
  // 改建卡（CARD-07）：目标为商业用地时还需选择要变更成的设施项目
  const rebuildCard = heldCards.includes('rebuild');
  const rebuildTargetCommercial = cellId !== '' && game.board[cellId as number]?.type === 'commercial';

  const canAct = game.phase === 'awaiting_roll' || game.phase === 'awaiting_action';

  const useCard = (cardId: string) => {
    const card = CARDS[cardId]!;
    const wantsCell = card.target === 'land' || card.target === 'building';
    onAction({
      type: 'USE_CARD',
      cardId,
      targetPlayerId: card.target === 'player' ? effectiveTarget : undefined,
      stockId: card.needsStock ? effectiveStock : undefined,
      cellId: wantsCell && cellId !== '' ? cellId : undefined,
      facility: cardId === 'rebuild' && rebuildTargetCommercial ? facility : undefined,
    });
  };

  const useItem = (itemId: string) => {
    const item = ITEMS[itemId]!;
    const wantsCell = item.target === 'cell' || item.target === 'land';
    onAction({
      type: 'USE_ITEM',
      itemId,
      cellId: wantsCell && cellId !== '' ? cellId : undefined,
      diceValue: item.needsDiceValue ? diceValue : undefined,
    });
  };

  return (
    <div className="panel hand-panel">
      <div className="panel-title">卡片（{current.cards.length}/{MAX_HAND_CARDS}）</div>
      {heldCards.length === 0 && <div className="empty-hint small">暂无卡片</div>}
      {heldCards.map((cardId, i) => {
        const card = CARDS[cardId]!;
        const usable = interactive && actions.usableCards.includes(cardId);
        const needsPlayer = card.target === 'player';
        const needsCellHere = CARD_REQUIRES_CELL.has(cardId);
        const targetOk = !needsPlayer || others.length > 0;
        const cellOk = !needsCellHere || (cellId !== '' && cellId !== current.position);
        const canUse = usable && targetOk && cellOk;
        const tip = !usable
          ? card.phase === 'pre_roll'
            ? '仅掷骰前可用'
            : card.phase === 'post_roll'
              ? '仅掷骰后可用'
              : '当前不可使用'
          : !targetOk
            ? '没有可选目标'
            : !cellOk
              ? '请选择目标格'
              : '';
        return (
          <div key={i} className={`card-row ${canUse ? '' : 'disabled'}`}>
            <div className="card-info">
              <div className="card-name">{card.name}</div>
              <div className="card-desc">{card.description}</div>
            </div>
            <button disabled={!canUse} title={tip} onClick={() => useCard(cardId)}>
              使用
            </button>
            <button className="ghost small" disabled={!interactive || !canAct} title="舍弃这张卡片" onClick={() => onAction({ type: 'DISCARD_CARD', cardId })}>
              弃
            </button>
          </div>
        );
      })}

      <div className="panel-title">道具（{itemCount}）</div>
      {heldItems.length === 0 && <div className="empty-hint small">暂无道具</div>}
      {heldItems.map((itemId) => {
        const item = ITEMS[itemId]!;
        const count = current.items[itemId] ?? 0;
        const usable = interactive && actions.usableItems.includes(itemId);
        const needsCellHere = ITEM_REQUIRES_CELL.has(itemId);
        const cellOk = !needsCellHere || (cellId !== '' && cellId !== current.position);
        const canUse = usable && cellOk;
        const tip = !usable
          ? item.phase === 'pre_roll'
            ? '仅掷骰前可用'
            : item.phase === 'post_roll'
              ? '仅掷骰后可用'
              : '当前不可使用'
          : !cellOk
            ? '请选择目标格'
            : '';
        return (
          <div key={itemId} className={`card-row ${canUse ? '' : 'disabled'}`}>
            <div className="card-info">
              <div className="card-name">
                {item.name} <span className="owned">×{count}</span>
                {item.researchLevel !== null && <span className="price">研究所 Lv{item.researchLevel}</span>}
              </div>
              <div className="card-desc">{item.description}</div>
            </div>
            <button disabled={!canUse} title={tip} onClick={() => useItem(itemId)}>
              使用
            </button>
          </div>
        );
      })}

      {needsCell && (
        <div className="param-row">
          <label>目标格</label>
          <select value={cellId} onChange={(e) => setCellId(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">脚下（{currentCellName}）</option>
            {cellOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {rebuildCard && rebuildTargetCommercial && (
        <div className="param-row">
          <label>变更为</label>
          <select value={facility} onChange={(e) => setFacility(e.target.value as FacilityType)}>
            {FACILITY_ORDER.map((f) => (
              <option key={f} value={f}>
                {FACILITIES[f].name}
              </option>
            ))}
          </select>
        </div>
      )}

      {heldCards.some((id) => CARDS[id]!.target === 'player') && others.length > 0 && (
        <div className="param-row">
          <label>目标玩家</label>
          <select value={effectiveTarget} onChange={(e) => setTargetId(e.target.value)}>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {heldCards.some((id) => CARDS[id]!.needsStock) && (
        <div className="param-row">
          <label>股票</label>
          <select value={effectiveStock} onChange={(e) => setStockId(e.target.value)}>
            {game.stockMarket.stocks.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {heldItems.some((id) => ITEMS[id]!.needsDiceValue) && (
        <div className="param-row">
          <label>骰点</label>
          <select value={diceValue} onChange={(e) => setDiceValue(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((v) => (
              <option key={v} value={v}>
                {v} 点
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}