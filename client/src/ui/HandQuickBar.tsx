import { useEffect, useMemo, useRef, useState } from 'react';
import { actionRefusal, actionTargets, availableActions, CARDS, FACILITIES, ITEMS } from '@richman/shared';
import type { FacilityType, GameState, PlayerAction, TargetSet, TargetSpec } from '@richman/shared';

/**
 * 一次「要在棋盘上点一格 / 点一个人」的请求。
 *
 * 半成品动作由这里填齐除 `cellId` / `targetPlayerId` 以外的全部参数，宿主只把点到的那格
 * 或那个人补进去再派单 —— 谁发起谁组装，否则会变成「面板攒一半、宿主攒一半」的第三个东西。
 */
export type PickRequest = {
  action: PlayerAction;
  /** 横幅上那句话：让玩家知道此刻点棋盘是在干什么 */
  label: string;
  /** 引擎给的合法格（HUD 用来画绿环） */
  cells: number[];
  /** 被拒格及其理由（HUD 在 hover 时原样引用，不另编一套措辞） */
  rejected: { id: number; reason: string }[];
  /** 引擎给的合法目标玩家（HUD 给他们脚下套环，点棋子即选中） */
  players?: string[];
  /** 被拒玩家及其理由 */
  playerRejected?: { id: string; reason: string }[];
  /** 发起条目的身份，用来把「正在选目标」标在那一格上 */
  key: string;
};

/** 行囊里的一格：卡片可能有多张同名的，所以带上下标 */
export type HandEntry = { kind: 'card' | 'item'; id: string; i: number };

/** 一格的身份 —— HUD 的行囊格、动作条与选中态共用这一个口径 */
export const entryKey = (e: HandEntry) => (e.kind === 'card' ? `card:${e.id}:${e.i}` : `item:${e.id}`);

/** 需要显式在棋盘上点一格的候选池。`foot` 就是脚下那一格，不必让玩家多此一举 */
function wantsBoardPick(spec: TargetSpec): boolean {
  return !!spec.cells && spec.cells !== 'foot';
}

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

/**
 * 手牌 / 道具的**内联动作条**（取代原来的模态「手牌」面板）。
 *
 * 为什么不再弹窗：用卡片道具是本局最高频的动作，而旧路径是「点行囊格子 → 弹出遮罩面板 →
 * 在同一批东西里再找一次 → 点使用」，且一旦需要选目标，`requestPick` 还得先把面板关掉
 * （遮罩会吃掉棋盘点击）—— 弹窗正好挡在主操作路径中间。
 * 现在行囊格子本身就是清单（带可用态与名称），点一格只在这条下方展开动作条：
 * 没有遮罩、棋盘始终可见可点，选格时绿环与这条同时在场。
 *
 * 口径不变：候选与合法性全部出自 `actionTargets` / `actionRefusal`，界面不判第二套。
 */
export function HandQuickBar({
  game,
  entry,
  onAction,
  interactive = true,
  requestPick,
  pickingKey = null,
  onDismiss,
}: {
  game: GameState;
  entry: HandEntry;
  onAction: (a: PlayerAction) => void;
  interactive?: boolean;
  requestPick: (req: PickRequest) => void;
  pickingKey?: string | null;
  onDismiss: () => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [hint, setHint] = useState('');
  const current = game.players[game.currentPlayerIndex];
  const key = entryKey(entry);

  // 换人 / 换回合时上一位的行囊不再属于此刻的行动者，动作条留着会派一个已经非法的动作。
  // 用 ref 记住"挂载时是谁的回合"，否则首帧就会被自己收掉（那条 effect 挂载即执行）。
  const seatRef = useRef(`${game.currentPlayerIndex}:${game.turn}`);
  useEffect(() => {
    const now = `${game.currentPlayerIndex}:${game.turn}`;
    if (now === seatRef.current) return;
    seatRef.current = now;
    onDismiss();
  }, [game.currentPlayerIndex, game.turn, onDismiss]);

  const rows = useMemo<Row[]>(() => {
    if (!current) return [];
    const acts = availableActions(game);
    return [
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
  }, [game, current]);

  // 用掉最后一张后这一格就不存在了：连带收掉展开态，别在行囊上留一具选中着的空壳
  const missing = !current || !rows.some((r) => r.key === key);
  useEffect(() => { if (missing) onDismiss(); }, [missing, onDismiss]);

  const row = rows.find((r) => r.key === key);
  if (!current || !row) return null;

  const set = actionTargets(game, current, row.spec);
  const optional = !!row.spec.players && actionRefusal(game, buildAction('')) === null;
  const player = optional ? (chosen[key] ?? '') : (chosen[key] ?? (set.players.length === 1 ? set.players[0]! : ''));
  const action = buildAction(player);
  const refusal = actionRefusal(game, action);
  const needBoard = wantsBoardPick(row.spec);
  const canUse = interactive && row.listed;
  const picking = pickingKey === key;

  // 灰掉也要说得出为什么：不列 = 引擎那句原话；轮不到人 = 界面自己拦的固定说法
  const why = !row.listed ? (refusal ?? row.desc) : !interactive ? '还没轮到你行动' : '';

  function buildAction(pid: string): PlayerAction {
    const extra: Record<string, unknown> = {};
    if (pid) extra.targetPlayerId = pid;
    if (row!.spec.stocks) extra.stockId = chosen[key] || set.stocks[0];
    if (row!.spec.facilities) extra.facility = (chosen[key] || set.facilities[0]) as FacilityType;
    if (row!.spec.dice) extra.diceValue = Number(chosen[key]) || 6;
    return (row!.kind === 'card'
      ? { type: 'USE_CARD', cardId: row!.id, ...extra }
      : { type: 'USE_ITEM', itemId: row!.id, ...extra }) as PlayerAction;
  }

  /**
   * 逐格问引擎「这一格为什么不行」。
   *
   * 不直接用 `set.rejectedCells`：那是候选池内部的拒绝集，池只搜视野 16 格时窗外的格连被问
   * 都没被问，hover 就只能显示「不可选」。进选态的一刻补一次全图问询（纯校验，不消耗随机数）。
   */
  function cellRefusals(legal: number[]) {
    const ok = new Set(legal);
    const out: { id: number; reason: string }[] = [];
    for (const cell of game.board) {
      if (ok.has(cell.id)) continue;
      const reason = actionRefusal(game, { ...action, cellId: cell.id } as PlayerAction);
      if (reason) out.push({ id: cell.id, reason });
    }
    return out;
  }

  function fire() {
    if (needBoard) {
      // 交给宿主进选格态：合法性由派单那一刻的引擎判，这里不预先拦
      requestPick({
        action,
        label: `${row!.label} · 选目标格`,
        cells: set.cells,
        rejected: cellRefusals(set.cells),
        key: row!.key,
      });
      return;
    }
    if (refusal !== null) {
      setHint(`${row!.label}：${refusal}`);
      return;
    }
    setHint('');
    onAction(action);
    onDismiss();
  }

  /** 选人模式：候选原样交给 HUD 套环，玩家直接在 3D 棋盘上点那个人 */
  function firePickPlayer() {
    requestPick({
      action,
      label: `${row!.label} · 点目标人物`,
      cells: [],
      rejected: [],
      players: set.players,
      playerRejected: set.rejectedPlayers,
      key: row!.key,
    });
  }

  const nameOf = (pid: string) => game.players.find((p) => p.id === pid)?.name ?? pid;

  const bar = (
    <div className={`ac-quick ${canUse ? '' : 'ac-quick--off'} ${picking ? 'ac-quick--picking' : ''}`} role="group" aria-label={`${row.label} 的操作条`}>
      <div className="ac-quick__id">
        <span className="ac-quick__name">{row.label}</span>
        <span className="ac-quick__qty">×{row.count}</span>
        {row.badge && <span className="ac-quick__badge">{row.badge}</span>}
      </div>
      <div className="ac-quick__desc">{picking ? '在棋盘上点目标，Esc 取消' : row.desc}</div>

      <div className="ac-quick__ctl">
        {row.spec.players && (
          <div className="ac-quick__chips" role="group" aria-label="目标玩家">
            {optional && (
              <button
                className={`ac-quick__chip ${player === '' ? 'ac-quick__chip--on' : ''}`}
                disabled={!canUse}
                title="不对对手用，只作用于自己"
                onClick={() => setChosen((m) => ({ ...m, [key]: '' }))}
              >
                自己
              </button>
            )}
            {set.players.map((pid) => (
              <button
                key={pid}
                className={`ac-quick__chip ${player === pid ? 'ac-quick__chip--on' : ''}`}
                disabled={!canUse}
                title={`${nameOf(pid)} · 在视野内`}
                onClick={() => setChosen((m) => ({ ...m, [key]: pid }))}
              >
                {nameOf(pid)}
              </button>
            ))}
            {set.rejectedPlayers.map((r) => (
              <button key={r.id} className="ac-quick__chip ac-quick__chip--off" title={r.reason} disabled>
                {nameOf(r.id)}
              </button>
            ))}
            {!needBoard && set.players.length > 0 && (
              <button className="ac-quick__chip ac-quick__chip--board" disabled={!canUse} title="在棋盘上直接点那个人 —— 候选与这些芯片同源" onClick={firePickPlayer}>
                🎯 点棋子
              </button>
            )}
          </div>
        )}

        {row.spec.stocks && (
          <label className="ac-quick__field">
            股票
            <select value={chosen[key] || set.stocks[0] || ''} disabled={!canUse} onChange={(e) => setChosen((m) => ({ ...m, [key]: e.target.value }))}>
              {set.stocks.map((s) => (
                <option key={s} value={s}>
                  {game.stockMarket.stocks.find((x) => x.id === s)?.name ?? s}
                </option>
              ))}
            </select>
          </label>
        )}

        {row.spec.facilities && (
          <label className="ac-quick__field">
            变更为
            <select value={chosen[key] || set.facilities[0] || ''} disabled={!canUse} onChange={(e) => setChosen((m) => ({ ...m, [key]: e.target.value }))}>
              {set.facilities.map((f) => (
                <option key={f} value={f}>
                  {FACILITIES[f].name}
                </option>
              ))}
            </select>
          </label>
        )}

        {row.spec.dice && (
          <label className="ac-quick__field">
            点数
            <select value={chosen[key] || '6'} disabled={!canUse} onChange={(e) => setChosen((m) => ({ ...m, [key]: e.target.value }))}>
              {set.diceValues.map((d) => (
                <option key={d} value={d}>
                  {d} 点
                </option>
              ))}
            </select>
          </label>
        )}

        <button className="ac-btn ac-btn--green ac-btn--sm" disabled={!canUse || (needBoard && set.cells.length === 0)} onClick={fire}>
          {needBoard ? '使用 · 选格' : '使用'}
        </button>
        <button className="ac-btn ac-btn--cream ac-btn--sm" onClick={onDismiss}>
          收起 <span className="ac-sheet__esc">Esc</span>
        </button>
      </div>

      {(hint || (!canUse && why)) && <div className="ac-note ac-note--warn ac-quick__warn">{hint || why}</div>}
    </div>
  );

  return bar;
}
