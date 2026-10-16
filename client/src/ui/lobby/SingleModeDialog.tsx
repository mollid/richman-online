import { useState } from 'react';
import { CHARACTERS, MAP_CHOICES, MAX_DAY_CHOICES, START_CASH_CHOICES, STARTING_CASH, characterById } from '@richman/shared';
import type { HotseatSeat } from '../../net/session.js';
import { characterPortrait } from '../../game/portrait.js';
import { CharacterGrid } from './CharacterGrid.js';
import { LbDialog, LbField, LbSeg } from './LbDialog.js';

/** 天数上限的显示文案（`null` = 不限，只靠「对手全破产」收场） */
function dayLimitLabel(days: number | null): string {
  return days === null ? '不限' : `${days} 天`;
}

export interface SingleStart {
  seats: HotseatSeat[];
  maxDays: number | null;
  mapId: number | null;
  initialCash: number;
}

/**
 * 单人开局面板。
 *
 * 座位默认全给真人（沿用热座那套：一台设备轮流掷骰），谁想一个人打就点两下把座位改成 AI。
 * 至少留一个真人座位 —— 全 AI 的局没人操作，那不是一局游戏，是一段屏保。
 */
export function SingleModeDialog({ onStart, onClose }: { onStart: (opts: SingleStart) => void; onClose: () => void }) {
  const [count, setCount] = useState(2);
  const [picks, setPicks] = useState<string[]>(CHARACTERS.slice(0, 2).map((c) => c.id));
  /** 座位号 → 是否 AI。缺省 false = 真人 */
  const [bots, setBots] = useState<boolean[]>([false, false, false, false]);
  const [maxDays, setMaxDays] = useState<number | null>(null);
  const [mapId, setMapId] = useState<number | null>(null);
  const [initialCash, setInitialCash] = useState<number>(STARTING_CASH);

  /** 改人数时同步 picks：减就砍尾，加就按座位序补没被占的角色 */
  const setCountAndSync = (n: number) => {
    setCount(n);
    setPicks((prev) => {
      if (prev.length > n) return prev.slice(0, n);
      const taken = new Set(prev);
      return [...prev, ...CHARACTERS.filter((c) => !taken.has(c.id)).slice(0, n - prev.length).map((c) => c.id)];
    });
  };

  const toggle = (id: string) => {
    if (picks.includes(id)) {
      setPicks(picks.filter((p) => p !== id));
      return;
    }
    if (picks.length >= count) return undefined;
    setPicks([...picks, id]);
  };

  const humanCount = picks.filter((_, seat) => !bots[seat]).length;
  const missing = count - picks.length;
  const start = () =>
    onStart({
      seats: picks.map((characterId, seat) => ({ characterId, kind: bots[seat] ? 'bot' : 'human' })),
      maxDays,
      mapId,
      initialCash,
    });

  return (
    <LbDialog title="单人模式" sub="一台设备轮流操作，或让 AI 补位" tone="orange" wide onClose={onClose}>
      <LbSeg
        label="人数"
        options={[2, 3, 4].map((n) => ({ key: String(n), value: n, label: `${n} 人` }))}
        value={count}
        onChange={setCountAndSync}
      />

      <LbField label="角色" hint="点卡片按点击顺序占座，再点一次腾出位子">
        <CharacterGrid picked={picks} onToggle={toggle} />
      </LbField>

      <LbField label="谁来操作" hint="改成 AI 后这一座自动行动">
        {picks.length === 0 ? (
          <div className="lb-empty">先在上方点选角色</div>
        ) : (
          <div className="lb-list">
            {picks.map((id, seat) => {
              const c = characterById(id);
              if (!c) return null;
              return (
                <div key={id} className="lb-seat">
                  <span className="lb-seat__no">{seat + 1}</span>
                  <img className="lb-seat__pic" src={characterPortrait(id)} alt="" width={44} height={44} draggable={false} />
                  <span className="lb-seat__name">
                    {c.name}
                    <small>{c.blurb}</small>
                  </span>
                  <span className="lb-seat__kind">
                    <button type="button" aria-pressed={!bots[seat]} onClick={() => setBots(bots.map((v, i) => (i === seat ? false : v)))}>
                      真人
                    </button>
                    <button type="button" aria-pressed={!!bots[seat]} onClick={() => setBots(bots.map((v, i) => (i === seat ? true : v)))}>
                      AI
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </LbField>

      <LbSeg
        label="初始金额"
        hint="贷款上限跟着这一档走"
        options={START_CASH_CHOICES.map((n) => ({ key: String(n), value: n, label: `¥${n.toLocaleString('zh-CN')}` }))}
        value={initialCash}
        onChange={setInitialCash}
      />

      <LbSeg
        label="游戏时长"
        hint="打满天数后按总资产结算"
        options={MAX_DAY_CHOICES.map((d) => ({ key: String(d), value: d, label: dayLimitLabel(d) }))}
        value={maxDays}
        onChange={setMaxDays}
      />

      <LbField label="地图">
        <div className="lb-seg">
          {MAP_CHOICES.map((m) => (
            <button key={String(m.id)} type="button" aria-pressed={mapId === m.id} onClick={() => setMapId(m.id)}>
              {m.name}
              <small style={{ marginLeft: 6, opacity: 0.7 }}>{m.cells} 格</small>
            </button>
          ))}
        </div>
      </LbField>

      <button className="lb-go" disabled={missing > 0 || humanCount === 0} onClick={start}>
        {missing > 0 ? `还差 ${missing} 个角色` : humanCount === 0 ? '至少留一个真人座位' : '开始游戏'}
      </button>
    </LbDialog>
  );
}
