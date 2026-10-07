import { gameDate, GODS, godSummary, ITEMS, type GameState } from '@richman/shared';

function toCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function PlayerList({ game, myPlayerId }: { game: GameState; myPlayerId?: string | null }) {
  const currentId = game.players[game.currentPlayerIndex]?.id;
  const dayIndex = gameDate(game).dayIndex;
  return (
    <div className="panel player-list">
      {game.players.map((p) => {
        const god = p.god ? GODS.find((g) => g.id === p.god!.godId) : undefined;
        const stockCount = Object.values(p.stocks).reduce((a, b) => a + b, 0);
        const itemCount = Object.values(p.items).reduce((a, b) => a + b, 0);
        const bomb = game.bombs.find((b) => b.playerId === p.id);
        const chairmanCount = game.companies.filter((c) => c.chairmanId === p.id).length;
        return (
          <div key={p.id} className={`player-card ${p.id === currentId ? 'current' : ''} ${p.bankrupt ? 'bankrupt' : ''}`}>
            <span className="dot" style={{ background: toCssColor(p.color) }} />
            <div className="player-info">
              <div className="player-name">
                {p.name}
                {p.id.startsWith('bot-') && <span className="badge bot">AI</span>}
                {myPlayerId != null && p.id === myPlayerId && <span className="me-tag">你</span>}
                {god && p.god && (
                  <span className="badge god" title={godSummary(god)}>
                    {god.name}·{p.god.remainingDays}天
                  </span>
                )}
                {!p.online && <span className="badge off">离线</span>}
                {p.skipTurns > 0 && <span className="badge skip">停留{p.skipTurns}</span>}
                {p.holdTurns > 0 && <span className="badge skip">驻留{p.holdTurns}</span>}
                {p.rentBlockedTurns > 0 && <span className="badge skip" title="丧失收租权">禁租{p.rentBlockedTurns}</span>}
                {p.sleepwalkTurns > 0 && <span className="badge skip" title="梦游：丧失收租与买地权">梦游{p.sleepwalkTurns}</span>}
                {p.turtleTurns > 0 && <span className="badge skip" title="乌龟：一次只走一步">乌龟{p.turtleTurns}</span>}
                {p.bulldozerTurns > 0 && <span className="badge" title="工程车：走到哪拆到哪">工程车{p.bulldozerTurns}</span>}
                {p.diceCount > 1 && <span className="badge" title="骰子数">🎲×{p.diceCount}</span>}
                {p.alliance && <span className="badge" title="同盟：互不收过路费">同盟{p.alliance.daysLeft}</span>}
                {p.research && (
                  <span className="badge research" title={`研究所研发中：${ITEMS[p.research.itemId]?.name ?? p.research.itemId}`}>
                    🔬{ITEMS[p.research.itemId]?.name ?? p.research.itemId}·{p.research.remainDays}天
                  </span>
                )}
                {bomb && <span className="badge loan" title="定时炸弹：走满步数后爆炸">💣{bomb.stepsLeft}</span>}
                {p.loan && (
                  <span className="badge loan" title={`未还本金 ¥${p.loan.principal}`}>
                    贷 ¥{p.loan.principal.toLocaleString('zh-CN')}（剩 {p.loan.dueDayIndex - dayIndex} 天）
                  </span>
                )}
                {p.financing > 0 && (
                  <span className="badge loan" title="董事长特别融资（周转期间存款不计息）">
                    融资 ¥{p.financing.toLocaleString('zh-CN')}
                  </span>
                )}
                {chairmanCount > 0 && (
                  <span className="badge" title="公司董事长（享免付费特权）">
                    董事长×{chairmanCount}
                  </span>
                )}
                {p.abroadTurns > 0 && (
                  <span className="badge skip" title="出国旅游：期间不能收租">
                    ✈️出国{p.abroadTurns}
                  </span>
                )}
                {p.insurance && (
                  <span className="badge" title="保险期间：可理赔灾害损失">
                    🛡️保险{p.insurance.daysLeft}
                  </span>
                )}
                {p.bankrupt && <span className="badge bankrupt">破产</span>}
              </div>
              <div className="player-sub wallet-row">
                <span>现金 ¥{p.cash.toLocaleString('zh-CN')}</span>
                <span>存款 ¥{p.deposit.toLocaleString('zh-CN')}</span>
                <span>点券 {p.points.toLocaleString('zh-CN')}</span>
                <span>地产 {p.properties.length} 处</span>
                {p.properties.some((q) => q.chain) && <span>连锁店 {p.properties.filter((q) => q.chain).length}</span>}
                {p.properties.some((q) => q.facility) && <span>建设 {p.properties.filter((q) => q.facility).length}</span>}
                {p.cards.length > 0 && <span>手牌 {p.cards.length}</span>}
                {itemCount > 0 && <span>道具 {itemCount}</span>}
                {stockCount > 0 && <span>持股 {stockCount}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

