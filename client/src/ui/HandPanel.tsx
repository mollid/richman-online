import { useState } from 'react';
import { actionRefusal, actionTargets, availableActions, CARDS, FACILITIES, ITEMS, MAX_HAND_CARDS } from '@richman/shared';
import type { FacilityType, GameState, PlayerAction, TargetSet, TargetSpec } from '@richman/shared';

/**
 * 一次「要在棋盘上点一格」的请求。
 *
 * 半成品动作由面板填齐除 `cellId` 以外的全部参数，宿主只把点到的那一格补进去再派单 ——
 * 谁发起谁组装，否则会变成「面板攒一半、宿主攒一半」的第三个东西。
 */
export type PickRequest = {
  action: PlayerAction;
  /** 横幅上那句话：让玩家知道此刻点棋盘是在干什么 */
  label: string;
  /** 引擎给的合法格（HUD 拿去做高亮；W2 只用来切手型光标） */
  cells: number[];
  /** 发起行的身份，用来把「正在选格」标在那一行上 */
  key: string;
};

/** 需要显式在棋盘上点一格的候选池。`foot` 就是脚下那一格，不必让玩家多此一举 */
function wantsBoardPick(spec: { cells?: string }): boolean {
  return !!spec.cells && spec.cells !== 'foot';
}

/**
 * 手牌 / 道具面板（W2 起：目标不再由面板里的下拉框决定）。
 *
 * 三件事变了，理由同一个 —— 让界面问引擎，而不是自己猜：
 * 1. **候选来自 `actionTargets`**。每一行向引擎要「此刻能作用在哪些格 / 哪些人 / 哪支股票」，
 *    与门控共用一个谓词 ⇒ 列得出来的就派得出去。旧实现是一个裸数字 `<select>` 列全图 64 格，
 *    选错了要等引擎抛异常才知道。
 * 2. **格改成在棋盘上点**。点「使用」→ 进入选格态 → 点一格即派单；点非法格退回理由并留在选态。
 * 3. **不再默认锁第一名可见对手**。旧实现 `effectiveTarget = others[0]`：玩家以为在给甲用卡，
 *    实际打到乙。现在只有唯一候选才预选，多于一个必须自己点。
 */
export function HandPanel({
  game,
  onAction,
  interactive = true,
  requestPick,
  pickingKey = null,
}: {
  game: GameState;
  onAction: (a: PlayerAction) => void;
  interactive?: boolean;
  requestPick: (req: PickRequest) => void;
  pickingKey?: string | null;
}) {
  /** 行内已选定的非棋盘参数（对手 / 股票 / 设施 / 骰点），键是行身份 */
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [hint, setHint] = useState('');

  const current = game.players[game.currentPlayerIndex];
  if (!current || (current.cards.length === 0 && Object.keys(current.items).length === 0)) return null;

  const acts = availableActions(game);
  const nameOf = (pid: string) => game.players.find((p) => p.id === pid)?.name ?? pid;

  type Row = {
    key: string;
    kind: 'card' | 'item';
    id: string;
    label: string;
    desc: string;
    count: number;
    badge?: string;
    /** 门控此刻是否放行（不含目标维度）—— 与引擎同一个答案 */
    listed: boolean;
    spec: TargetSpec;
  };

  const rows: Row[] = [
    ...current.cards
      .filter((id): id is string => !!CARDS[id])
      .map((id, i) => {
        const card = CARDS[id]!;
        return {
          key: `card:${id}:${i}`,
          kind: 'card' as const,
          id,
          label: card.name,
          desc: card.description,
          count: 1,
          listed: acts.usableCards.includes(id),
          spec: card.targetSpec,
        };
      }),
    ...Object.keys(current.items)
      .filter((id) => ITEMS[id] && (current.items[id] ?? 0) > 0)
      .map((id) => {
        const item = ITEMS[id]!;
        return {
          key: `item:${id}`,
          kind: 'item' as const,
          id,
          label: item.name,
          desc: item.description,
          count: current.items[id] ?? 0,
          badge: item.researchLevel !== null ? `研究所 Lv${item.researchLevel}` : undefined,
          listed: acts.usableItems.includes(id),
          spec: item.targetSpec,
        };
      }),
  ];

  /**
   * 这一行此刻选中的对手。
   *
   * 两种问法分开处理（问的是引擎，不是猜的）：
   * - **必填**（均贫 / 陷害 / 同盟…）：唯一候选才预选，多于一个必须玩家自己点；
   * - **可选**（定时炸弹 / 传送机）：默认空着 = 对自己用，绝不自作主张把炸弹塞给旁边那个人。
   */
  function pickedPlayer(row: Row, set: TargetSet): string {
    if (!row.spec.players) return '';
    if (playerOptional(row, set)) return chosen[row.key] ?? '';
    return chosen[row.key] ?? (set.players.length === 1 ? set.players[0]! : '');
  }

  /**
   * 对手是可选项还是必填 —— 问引擎：不带目标的动作合不合法。
   * 混起来会把「自装」这个选项吃掉。
   */
  function playerOptional(row: Row, set: TargetSet): boolean {
    if (!row.spec.players) return false;
    return actionRefusal(game, buildAction(row, set, '')) === null;
  }

  /** 把一行摊开成「候选 + 半成品动作 + 引擎此刻的意见」，渲染与派单读同一份 */
  function resolve(row: Row): { action: PlayerAction; refusal: string | null; needBoard: boolean; set: TargetSet } {
    const set = actionTargets(game, current!, row.spec);
    const action = buildAction(row, set, pickedPlayer(row, set));
    return { action, refusal: actionRefusal(game, action), needBoard: wantsBoardPick(row.spec), set };
  }

  function buildAction(row: Row, set: TargetSet, player: string): PlayerAction {
    const extra: Record<string, unknown> = {};
    if (player) extra.targetPlayerId = player;
    if (row.spec.stocks) extra.stockId = chosen[row.key] || set.stocks[0];
    if (row.spec.facilities) extra.facility = (chosen[row.key] || set.facilities[0]) as FacilityType;
    if (row.spec.dice) extra.diceValue = Number(chosen[row.key]) || 6;
    return (row.kind === 'card'
      ? { type: 'USE_CARD', cardId: row.id, ...extra }
      : { type: 'USE_ITEM', itemId: row.id, ...extra }) as PlayerAction;
  }

  function fire(row: Row) {
    const { action, refusal, needBoard, set } = resolve(row);
    if (needBoard) {
      // 交给宿主进选格态：合法性由派单那一刻的引擎判，这里不预先拦
      requestPick({ action, label: `${row.label} · 选目标格`, cells: set.cells, key: row.key });
      return;
    }
    if (refusal !== null) {
      setHint(`${row.label}：${refusal}`);
      return;
    }
    setHint('');
    onAction(action);
  }

  const cardRows = rows.filter((r) => r.kind === 'card');
  const itemRows = rows.filter((r) => r.kind === 'item');
  const itemCount = itemRows.reduce((n, r) => n + r.count, 0);

  return (
    <div className="panel hand-panel">
      <div className="panel-title">
        卡片（{cardRows.length}/{MAX_HAND_CARDS}）
      </div>
      {cardRows.length === 0 && <div className="empty-hint small">暂无卡片</div>}
      {cardRows.map(renderRow)}

      <div className="panel-title">道具（{itemCount}）</div>
      {itemRows.length === 0 && <div className="empty-hint small">暂无道具</div>}
      {itemRows.map(renderRow)}

      {hint && (
        <div className="param-row">
          <span className="ac-note ac-note--warn">{hint}</span>
        </div>
      )}
    </div>
  );

  function renderRow(row: Row) {
    const { refusal, needBoard, set } = resolve(row);
    const canUse = interactive && row.listed;
    const picking = pickingKey === row.key;
    const player = pickedPlayer(row, set);
    const optional = playerOptional(row, set);
    // 目标没挑齐时那句引擎理由就是提示文案 —— 界面不另编一套说法
    const tip = !canUse ? row.desc : needBoard ? '点「使用」后在棋盘上点一格' : (refusal ?? '');

    return (
      <div key={row.key} className={`card-row ${canUse ? '' : 'disabled'} ${picking ? 'picking' : ''}`}>
        <div className="card-info">
          <div className="card-name">
            {row.label} <span className="owned">×{row.count}</span>
            {row.badge && <span className="price">{row.badge}</span>}
          </div>
          <div className="card-desc">{row.desc}</div>

          {row.spec.players && (
            <div className="param-row chips">
              {/* 可选目标（自装炸弹 / 只身传送）要把「自己」这颗摆出来，否则唯一对手会被预选顶掉 */}
              {optional && (
                <button
                  className={`chip ${player === '' ? 'chip--on' : ''}`}
                  disabled={!canUse}
                  title="不对对手用，只作用于自己"
                  onClick={() => setChosen((m) => ({ ...m, [row.key]: '' }))}
                >
                  自己
                </button>
              )}
              {set.players.map((pid) => (
                <button
                  key={pid}
                  className={`chip ${player === pid ? 'chip--on' : ''}`}
                  disabled={!canUse}
                  title={`${nameOf(pid)} · 在视野内`}
                  onClick={() => setChosen((m) => ({ ...m, [row.key]: pid }))}
                >
                  {nameOf(pid)}
                </button>
              ))}
              {/* 视野外的人照样列出来，但灰着并带上引擎那句理由：玩家才知道「不是没这个人，是够不着」 */}
              {set.rejectedPlayers.map((r) => (
                <button key={r.id} className="chip chip--off" title={r.reason} disabled>
                  {nameOf(r.id)}
                </button>
              ))}
            </div>
          )}

          {row.spec.stocks && (
            <select
              value={chosen[row.key] || set.stocks[0] || ''}
              onChange={(e) => setChosen((m) => ({ ...m, [row.key]: e.target.value }))}
            >
              {set.stocks.map((s) => (
                <option key={s} value={s}>
                  {game.stockMarket.stocks.find((x) => x.id === s)?.name ?? s}
                </option>
              ))}
            </select>
          )}

          {row.spec.facilities && (
            <select
              value={chosen[row.key] || set.facilities[0] || ''}
              onChange={(e) => setChosen((m) => ({ ...m, [row.key]: e.target.value }))}
            >
              {set.facilities.map((f) => (
                <option key={f} value={f}>
                  变更为{FACILITIES[f].name}
                </option>
              ))}
            </select>
          )}

          {row.spec.dice && (
            <select
              value={chosen[row.key] || '6'}
              onChange={(e) => setChosen((m) => ({ ...m, [row.key]: e.target.value }))}
            >
              {set.diceValues.map((v) => (
                <option key={v} value={v}>
                  {v} 点
                </option>
              ))}
            </select>
          )}
        </div>

        <button disabled={!canUse} title={tip} onClick={() => fire(row)}>
          {picking ? '选格中…' : needBoard ? '使用 · 选格' : '使用'}
        </button>
        {row.kind === 'card' && (
          <button
            className="ghost small"
            disabled={!interactive}
            title="舍弃这张卡片"
            onClick={() => onAction({ type: 'DISCARD_CARD', cardId: row.id })}
          >
            弃
          </button>
        )}
      </div>
    );
  }
}
