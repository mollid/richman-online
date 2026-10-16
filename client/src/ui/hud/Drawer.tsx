/**
 * 右侧抽屉：把旧 HUD 常驻右栏那六块内容收进「默认收起」的一层。
 *
 * 四个只读页（岛民 / 岛况 / 账本 / 播报）在这里画；
 * 另外两块（股市、公布栏）本来就各有自己的 React 面板，抽屉只负责把它们请出来，
 * 不重复画第二份表 —— 那正是「14 行业定价在状态条与面板里各写一遍」的老毛病。
 *
 * 口径全部出自 `view.*`（shared 派生），这里不重算任何规则数。
 */
import { GOD_ICON, godTone, logIcon, type Player } from '@richman/shared';
import type { AcSnapshot } from '../../game/acSnapshot.js';
import { characterPortrait } from '../../game/portrait.js';
import { Icon } from '../mp/Icon.js';

const money = (n: number) => Math.round(n).toLocaleString('zh-CN');

/**
 * `GOD_ICON` 是按 string 开的索引，`<use href="#…">` 指不到 symbol 时什么都不画、连兜底都没有，
 * 所以缺键必须给一枚明确的替代。完整性由 shared/test/icons.test.ts 盯着。
 */
const godIcon = (id: string) => GOD_ICON[id] ?? 'i-spark';

export type DrawerTab = 'islanders' | 'situation' | 'books' | 'log';

/** 抽屉里那四块的显示名（ rail 上的 title 与页签共用，别再各写一份 ） */
export const DRAWER_TABS: Array<{ id: DrawerTab; label: string; icon: string }> = [
  { id: 'islanders', label: '岛民', icon: 'i-people' },
  { id: 'situation', label: '岛况', icon: 'i-globe' },
  { id: 'books', label: '账本', icon: 'i-book' },
  { id: 'log', label: '播报', icon: 'i-mega' },
];

/**
 * 一人身上正在生效的状态。逐项对齐 `hud.js:playerBadges()`，
 * 措辞与门控都引 shared 的原话，表现层不另编一套。
 */
function statusBadges(snap: AcSnapshot, p: Player) {
  const out: Array<{ key: string; icon: string; text: string; tone?: 'good' | 'bad' | 'flat'; tip: string }> = [];
  const day = snap.view.date.dayIndex;
  const nameOf = (id: string) => snap.state.players.find((x) => x.id === id)?.name ?? id;
  const push = (key: string, icon: string, text: string, tip: string, tone?: 'good' | 'bad' | 'flat') =>
    out.push({ key, icon, text, tip, tone });

  if (p.god) {
    const g = snap.view.names.godList.find((x) => x.id === p.god!.godId);
    push('god', godIcon(p.god.godId), `${g?.name ?? p.god.godId} 附身 ${p.god.remainingDays} 天`,
      `附身：${g?.possession ?? ''}${g?.travel ? `｜出巡：${g.travel}` : ''}`, godTone(p.god.godId));
  }
  if (p.custody)
    push('custody', p.custody.kind === 'jail' ? 'i-jail' : 'i-med', `${p.custody.kind === 'jail' ? '在押' : '住院'} ${p.custody.daysLeft} 天`, '暂停行动并丧失收租权', 'bad');
  if (p.skipTurns > 0) push('skip', 'i-clock', `停留 ${p.skipTurns}`, '剩余跳过回合数', 'bad');
  if (p.holdTurns > 0) push('hold', 'i-pin', `驻留 ${p.holdTurns}`, '停留卡：下次前进停在原地', 'bad');
  if (p.rentBlockedTurns > 0) push('rent', 'i-cross', `禁租 ${p.rentBlockedTurns}`, '丧失收租权剩余天数', 'bad');
  if (p.sleepwalkTurns > 0) push('sleep', 'i-med', `梦游 ${p.sleepwalkTurns}`, '丧失收租与买地权利', 'bad');
  if (p.turtleTurns > 0) push('turtle', 'i-clock', `乌龟 ${p.turtleTurns}`, '一次只走一步');
  if (p.bulldozerTurns > 0) push('dozer', 'i-bulldozer', `工程车 ${p.bulldozerTurns}`, '走到哪拆到哪');
  if (p.abroadTurns > 0) push('abroad', 'i-plane', `出国 ${p.abroadTurns}`, '出国期间不能收租', 'bad');
  if (p.insurance) push('ins', 'i-check', `保险 ${p.insurance.daysLeft}`, '期间可理赔灾害损失', 'good');
  if (p.alliance) push('ally', 'i-heart', `同盟 ${p.alliance.daysLeft}`, `与 ${nameOf(p.alliance.with)} 互不收租`, 'good');
  if (p.research) push('res', 'i-lab', `${snap.view.names.items[p.research.itemId]?.name ?? p.research.itemId} ${p.research.remainDays} 天`, '研究所研发中', 'good');
  if (p.unlucky) push('bad-luck', 'i-god-misfortune', `霉运 ${p.unlucky.daysLeft}×${p.unlucky.multiplier}`, '负面事件与租金按倍率放大', 'bad');
  if (p.diceCount > 1) push('dice', 'i-dice', `骰力 ×${p.diceCount}`, '骰子个数');
  if (p.financing > 0) push('fin', 'i-case', `融资 ${money(p.financing)}`, '董事长特别融资未还额（期间存款不计息）', 'bad');
  if (p.loan) push('loan', 'i-bank', `贷款 ${money(p.loan.principal)}`, `到期强制全额归还，无利息（剩 ${Math.max(0, p.loan.dueDayIndex - day)} 天）`, 'bad');
  const chair = snap.state.companies.filter((c) => c.chairmanId === p.id).length;
  if (chair) push('chair', 'i-crown', `董事长 ×${chair}`, '握有经营权，停靠自家免付费', 'good');
  const bomb = snap.view.entities.bombs.find((b) => b.playerId === p.id);
  if (bomb) push('bomb', 'i-bomb', `剩 ${bomb.stepsLeft} 步`, '定时炸弹：走满步数爆炸', 'bad');
  if (p.cards.length) push('cards', 'i-cards', `手牌 ${p.cards.length}/15`, '手牌额满须舍弃');
  if (!p.online) push('off', 'i-exit', '离线', '掉线中，由托管代打', 'bad');
  if (p.bankrupt) push('dead', 'i-god-death', '破产', '已退出本局', 'bad');
  if (p.id.startsWith('bot-')) push('bot', 'i-robot', 'AI 代打', '由电脑控制');
  return out;
}

function Islanders({ snap, viewportPid, onPick }: { snap: AcSnapshot; viewportPid: string; onPick: (pid: string) => void }) {
  const { view, state: st } = snap;
  const leader = view.assets[0]?.total || 1;
  const actor = st.players[st.currentPlayerIndex];
  return (
    <div className="mp-list">
      {view.assets.map((a) => {
        const p = st.players.find((x) => x.id === a.playerId);
        if (!p) return null;
        const pct = Math.max(3, Math.round((a.total / leader) * 100));
        const shares = Object.values(p.stocks).reduce((x, y) => x + y, 0);
        const items = Object.values(p.items).reduce((x, y) => x + y, 0);
        const badges = statusBadges(snap, p);
        return (
          <button key={p.id} type="button" className={`mp-person${p.id === viewportPid ? ' mp-person--me' : ''}`} onClick={() => onPick(p.id)}>
            <span className="mp-person__hd">
              <img src={characterPortrait(p.characterId)} alt="" width={34} height={34} draggable={false} />
              <span className="mp-person__who">
                <b>
                  {p.name}
                  {p.id === viewportPid && <em className="mp-tag">视角</em>}
                  {p.id === actor?.id && <em className="mp-tag mp-tag--on">行动中</em>}
                </b>
                <small>
                  现金 {money(a.cash)} · 存款 {money(a.deposit)} · 点券 {money(p.points)} · 地产 {p.properties.length} · 股 {shares} · 道具 {items}
                </small>
              </span>
              <span className="mp-person__val">{money(a.total)}</span>
            </span>
            <span className="mp-rank">
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="mp-person__foot">
              相对榜首 {pct}% · 脚下「{st.board[p.position]?.name ?? '?'}」
            </span>
            {badges.length > 0 && (
              <span className="mp-badges">
                {badges.map((b) => (
                  <span key={b.key} className={`mp-bg${b.tone ? ` mp-bg--${b.tone}` : ''}`} title={b.tip}>
                    <Icon id={b.icon} size="s" />
                    {b.text}
                  </span>
                ))}
              </span>
            )}
          </button>
        );
      })}
      <p className="mp-hint">点一名岛民 = 切换表现层视角（只看他的钱包与清单，回合归属不变）</p>
    </div>
  );
}

function Situation({ snap, onJumpCell }: { snap: AcSnapshot; onJumpCell: (cellId: number) => void }) {
  const { view, state: st } = snap;
  const A = view.actions;
  const obs = view.entities.obstacles;
  const nRoad = obs.filter((o) => o.kind === 'roadblock').length;
  const nMine = obs.filter((o) => o.kind === 'mine').length;
  const jailed = view.entities.npcs.filter((n) => n.jailed);
  const chips: Array<{ key: string; icon: string; text: string; tone?: 'good' | 'bad' }> = [];
  if (view.date.isHoliday) chips.push({ key: 'holiday', icon: 'i-balloon', text: '例假日：股市休市、银行不放款', tone: 'bad' });
  if (st.stockHaltAllDays > 0) chips.push({ key: 'halt', icon: 'i-cone', text: `全市场停牌 ${st.stockHaltAllDays} 天`, tone: 'bad' });
  if (st.loanBanDays > 0) chips.push({ key: 'loanban', icon: 'i-bank', text: `银行停止放款 ${st.loanBanDays} 天`, tone: 'bad' });
  if (nRoad) chips.push({ key: 'road', icon: 'i-cone', text: `路障 ${nRoad} 个` });
  if (nMine) chips.push({ key: 'mine', icon: 'i-mine', text: `地雷 ${nMine} 个`, tone: 'bad' });
  for (const b of view.entities.bombs) chips.push({ key: `bomb-${b.playerId}`, icon: 'i-bomb', text: `${b.name} 身上剩 ${b.stepsLeft} 步`, tone: 'bad' });
  for (const p of st.players) if (p.skipTurns > 0) chips.push({ key: `skip-${p.id}`, icon: 'i-clock', text: `${p.name} 停 ${p.skipTurns} 回合` });

  return (
    <div className="mp-sect">
      <div className="mp-badges">
        {chips.map((c) => (
          <span key={c.key} className={`mp-bg${c.tone ? ` mp-bg--${c.tone}` : ''}`}>
            <Icon id={c.icon} size="s" />
            {c.text}
          </span>
        ))}
        {!chips.length && <p className="mp-empty">此刻没有全局状态生效</p>}
      </div>

      {view.gods.length > 0 && (
        <>
          <h4 className="mp-sect__t">岛上驻留的神（经过即附身）</h4>
          <div className="mp-gods">
            {view.gods.map((g) => (
              <button key={`${g.godId}-${g.cellId}`} type="button" className={`mp-god mp-god--${godTone(g.godId)}`} title={`${g.name}：${g.summary}（剩 ${g.ttlDays} 天，第 ${g.bornDay} 天现身）`} onClick={() => onJumpCell(g.cellId)}>
                <Icon id={godIcon(g.godId)} size="l" tone={godTone(g.godId)} />
                <b>{g.name}</b>
                <small>{g.cellId} 号格 · 剩 {g.ttlDays} 天</small>
              </button>
            ))}
          </div>
        </>
      )}

      {jailed.length > 0 && (
        <>
          <h4 className="mp-sect__t">狱中恶人</h4>
          <div className="mp-badges">
            <span className="mp-bg" title="站上监狱门外才可办">
              <Icon id="i-jail" size="s" />
              保释金 {A.bailFee} 点券
            </span>
            {jailed.map((n) => (
              <span key={`${n.kind}-${n.cellId}`} className="mp-bg">
                <Icon id="i-mask" size="s" />
                {n.name}
              </span>
            ))}
          </div>
        </>
      )}

      {st.auction && (
        <>
          <h4 className="mp-sect__t">拍卖会 · {st.board[st.auction.cellId]?.name ?? ''}</h4>
          <div className="mp-badges">
            <span className="mp-bg">
              当前最高 <b className="mp-n2">{money(st.auction.highestBid)}</b>
            </span>
            <span className="mp-bg">
              下次最低 <b className="mp-n2">{money(A.auctionMinBid)}</b>
            </span>
            <span className="mp-bg">在场竞买 {st.auction.bidders.length}</span>
            {st.auction.bidders.map((b, i) => (
              <span key={b} className={`mp-bg${i === st.auction!.turnIndex ? ' mp-bg--good' : ''}`}>
                {st.players.find((p) => p.id === b)?.name ?? b}
                {i === st.auction!.turnIndex ? ' ← 轮到他' : ''}
              </span>
            ))}
            {st.auction.withdrawn.map((b) => (
              <span key={`w-${b}`} className="mp-bg mp-bg--flat">
                已弃权 {st.players.find((p) => p.id === b)?.name ?? b}
              </span>
            ))}
          </div>
        </>
      )}

      {A.magic && (
        <>
          <h4 className="mp-sect__t">女巫的水晶球</h4>
          <p className="mp-hint">
            本局目标 <b>{view.names.magicConditions?.[A.magic.condition] ?? A.magic.condition}</b>
            · 名单不公布，站上去才知道谁中招
          </p>
        </>
      )}

      <h4 className="mp-sect__t">奖池</h4>
      <p className="mp-hint">
        罚金与投注累加，每月 15 号开奖：奖池 <b className="mp-n2">{money(st.lotteryPool)}</b> · 在押{' '}
        <b className="mp-n2">{st.lotteryTickets.length}</b> 单
      </p>
    </div>
  );
}

function Books({ snap, viewportPid }: { snap: AcSnapshot; viewportPid: string }) {
  const { view, state: st } = snap;
  const p = st.players.find((x) => x.id === viewportPid) ?? st.players[0];
  const groups = p ? view.estates[p.id] ?? [] : [];
  const corp = st.companies.filter((c) => Object.keys(c.shares).length);
  const cols: Array<[string, string, (a: (typeof view.assets)[number]) => string]> = [
    ['现', '现金', (a) => money(a.cash)],
    ['存', '存款', (a) => money(a.deposit)],
    ['土', '土地现值', (a) => money(a.landValue)],
    ['房', '房屋现值', (a) => money(a.houseValue)],
    ['股', '上市股现值', (a) => money(a.stockValue)],
    ['原', '原始股现值', (a) => money(a.corpValue)],
    ['贷', '未偿贷款', (a) => (a.loan ? `−${money(a.loan)}` : '0')],
    ['总', '资产总值', (a) => money(a.total)],
  ];
  return (
    <div className="mp-sect">
      <div className="mp-tablewrap">
        <table className="mp-table">
          <thead>
            <tr>
              <th>岛民</th>
              {cols.map(([h, t]) => (
                <th key={h} title={t}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.assets.map((a) => (
              <tr key={a.playerId} title={a.playerName}>
                <td>
                  <img className="mp-ava--inline" src={characterPortrait(st.players.find((x) => x.id === a.playerId)?.characterId ?? '')} alt="" width={22} height={22} draggable={false} />
                  {a.bankrupt ? <Icon id="i-god-death" size="s" tone="bad" /> : null}
                </td>
                {cols.map(([h], i) => (
                  <td key={h} className={i === cols.length - 1 ? 'mp-table__b' : ''}>
                    {cols[i]![2](a)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mp-hint">买地 / 升级 / 租金都要乘物价指数，见顶栏胶囊。</p>

      {p && (
        <>
          <h4 className="mp-sect__t">{p.name} 的地产</h4>
          {!groups.length && <p className="mp-empty">还没有地：走到无主地产当场买下一块，或去拍卖会捡漏。</p>}
          {groups.map((g) => (
            <div key={g.streetName} className="mp-sect">
              <h5 className="mp-sect__s">
                {g.streetName} 段 · {money(g.totalValue)}
              </h5>
              {g.rows.map((r) => (
                <div key={r.cellId} className="mp-item">
                  <Icon id={r.isChain ? 'i-store' : 'i-house'} size="s" />
                  <span className="mp-item__main">
                    <span className="mp-item__name">
                      {r.cellName} <em className="mp-tag">{r.gradeLabel} · {r.grade} 级</em>
                      {r.facility && <em className="mp-tag">{r.facility}</em>}
                    </span>
                    <span className="mp-item__sub">
                      地皮 {money(r.landValue)} + 建筑 {money(r.houseValue)}
                    </span>
                  </span>
                  <span className="mp-item__sub">{r.cellId} 号格</span>
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {corp.length > 0 && (
        <>
          <h4 className="mp-sect__t">公司经营权（每月 15 号按持股比例分盈余）</h4>
          <div className="mp-tablewrap">
            <table className="mp-table">
              <thead>
                <tr>
                  <th>公司</th>
                  <th>面值</th>
                  <th>累积盈余</th>
                  <th>董事长</th>
                  <th>持股</th>
                </tr>
              </thead>
              <tbody>
                {corp.map((c) => (
                  <tr key={c.cellId}>
                    <td>
                      {c.name || st.board[c.cellId]?.name || c.tile}
                      <small className="mp-item__sub"> {(c.footprint?.length ? c.footprint : [c.cellId]).join('·')}</small>
                    </td>
                    <td>{money(c.sharePrice)}</td>
                    <td>{money(c.surplus)}</td>
                    <td>{c.chairmanId ? st.players.find((p) => p.id === c.chairmanId)?.name ?? '' : '空缺'}</td>
                    <td>
                      {Object.entries(c.shares)
                        .map(([k, v]) => `${st.players.find((p) => p.id === k)?.name ?? k} ${v} 张`)
                        .join('、') || '无人持股'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Log({ snap }: { snap: AcSnapshot }) {
  const log = snap.state.log ?? [];
  /* 引擎的 log 有 200 条上限并从头部剪，所以倒着铺：最新那条永远在最上面。 */
  const recent = log.slice(-80).reverse();
  return (
    <ul className="mp-log">
      {recent.map((e, i) => {
        /* key 用**正序**下标（slice 之后它在数组里的真实位置），不能用这个倒序下标：
           倒序下标每来一条新播报就全体 +1，80 行会一起换 key、整列重挂载 ——
           滚动位置和入场动画都会被重置，看起来就像列表自己跳了一下。 */
        const forward = log.length - 1 - i;
        return (
          <li key={`${forward}-${e.turn}-${e.text}`}>
            <Icon id={logIcon(e.text)} size="s" />
            <b className="mp-log__turn">{e.turn}</b>
            <span>{e.text}</span>
          </li>
        );
      })}
      {!recent.length && <li className="mp-empty">还没有播报</li>}
    </ul>
  );
}

export function DrawerBody({ tab, snap, viewportPid, onPick, onJumpCell }: { tab: DrawerTab; snap: AcSnapshot; viewportPid: string; onPick: (pid: string) => void; onJumpCell: (cellId: number) => void }) {
  if (tab === 'islanders') return <Islanders snap={snap} viewportPid={viewportPid} onPick={onPick} />;
  if (tab === 'situation') return <Situation snap={snap} onJumpCell={onJumpCell} />;
  if (tab === 'books') return <Books snap={snap} viewportPid={viewportPid} />;
  return <Log snap={snap} />;
}
