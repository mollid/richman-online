import { useEffect, useState } from 'react';
import { DEFAULT_MAP_ID, MAP_CHOICES, MAX_DAY_CHOICES, ONLINE_DEFAULT_MAX_DAYS, START_CASH_CHOICES, STARTING_CASH } from '@richman/shared';
import { ColyseusSession, type RoomSummary } from '../../net/remote.js';
import type { AuthUser } from '../../net/auth.js';
import { LbDialog, LbField, LbSeg } from './LbDialog.js';

function dayLimitLabel(days: number | null): string {
  return days === null ? '不限' : `${days} 天`;
}

/** 房间多久没人动过。不到一分钟说「刚刚」，免得整列都是「0 分钟前」 */
function idleLabel(sec: number): string {
  return sec < 60 ? '刚刚' : `${Math.floor(sec / 60)} 分钟前`;
}

export interface OnlineCreate {
  playerName: string;
  maxDays: number | null;
  /** 开局地图：只有四张原版图 */
  mapId: number;
  isPrivate: boolean;
  initialCash: number;
}

/**
 * 联机开局面板：建房 + 凭码加入 + 公开房列表。
 *
 * 昵称这一格删了 —— 登录后服务端一律拿账号名当牌子上那个名字（`GameRoom.onJoin` 里
 * `auth.username` 优先于 `options.name`），留着输入框只会让人以为改了有用。
 * 角色也不在这里选：那要等进了房才看得见谁占了谁，仍在房间大厅里。
 */
export function OnlineModeDialog({
  user,
  connecting,
  error,
  canResume,
  onCreate,
  onJoin,
  onResume,
  onClose,
}: {
  user: AuthUser;
  connecting: boolean;
  error: string;
  canResume: boolean;
  onCreate: (opts: OnlineCreate) => void;
  onJoin: (roomId: string) => void;
  onResume: () => void;
  onClose: () => void;
}) {
  const [maxDays, setMaxDays] = useState<number | null>(ONLINE_DEFAULT_MAX_DAYS);
  const [mapId, setMapId] = useState<number>(DEFAULT_MAP_ID);
  const [initialCash, setInitialCash] = useState<number>(STARTING_CASH);
  // 建房默认可公开 —— 大厅列表本来就是给「顺手凑一桌」用的，想只发给好友再切成私密
  const [isPrivate, setIsPrivate] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);

  const refreshRooms = async () => {
    try {
      setRooms(await ColyseusSession.listRooms());
    } catch {
      setRooms([]);
    }
  };

  useEffect(() => {
    void refreshRooms();
    // 服务端会在后台收房（空闲满 15 分钟、或最后一个玩家走清后 autoDispose），
    // 不轮询的话列表就一直挂着已经没了的房，直到人手动点刷新。
    const poll = setInterval(() => void refreshRooms(), 10_000);
    return () => clearInterval(poll);
  }, []);

  return (
    <LbDialog title="联机模式" sub={`以 ${user.username} 的身份开局`} tone="blue" wide onClose={onClose}>
      <LbSeg
        label="初始金额"
        hint="只有房主说了算"
        options={START_CASH_CHOICES.map((n) => ({ key: String(n), value: n, label: `¥${n.toLocaleString('zh-CN')}` }))}
        value={initialCash}
        onChange={setInitialCash}
      />

      <LbSeg
        label="游戏时长"
        hint="联机默认 60 天，长局收得了口"
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

      <LbSeg
        label="房间可见性"
        options={[
          { key: 'public', value: false, label: '公开' },
          { key: 'private', value: true, label: '私密' },
        ]}
        value={isPrivate}
        onChange={setIsPrivate}
      />

      <button
        className="lb-go lb-go--blue"
        disabled={connecting}
        onClick={() => onCreate({ playerName: user.username, maxDays, mapId, isPrivate, initialCash })}
      >
        {connecting ? '连接中…' : '创建房间'}
      </button>

      <LbField label="加入房间" hint="私密房不出现在下面的列表里，只能凭码进">
        <div className="lb-row">
          <input
            className="lb-input"
            placeholder="房间码"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && roomId && !connecting) onJoin(roomId);
            }}
          />
          <button className="lb-go lb-go--blue" style={{ flex: '0 0 auto' }} disabled={!roomId || connecting} onClick={() => onJoin(roomId)}>
            加入
          </button>
        </div>
      </LbField>

      {canResume && (
        <button className="lb-mini" style={{ alignSelf: 'flex-start' }} disabled={connecting} onClick={onResume}>
          回到上次对局
        </button>
      )}

      {error && <div className="lb-err">{error}</div>}

      <LbField label="公开房间">
        <div className="lb-list__hd" style={{ justifyContent: 'flex-end' }}>
          <button className="lb-mini" onClick={() => void refreshRooms()}>
            刷新
          </button>
        </div>
        {rooms.length === 0 ? (
          <div className="lb-empty">暂无等待中的房间</div>
        ) : (
          <div className="lb-list lb-scroll">
            {rooms.map((room) => (
              <div key={room.roomId} className="lb-item">
                <span className="lb-item__main">
                  <span className="lb-item__name">{room.roomId}</span>
                  <span className="lb-item__sub">
                    {room.players}/{room.maxPlayers} 人 · {idleLabel(room.idleSec)}没人动
                  </span>
                </span>
                <button
                  className="lb-mini"
                  disabled={connecting || room.players >= room.maxPlayers}
                  onClick={() => onJoin(room.roomId)}
                >
                  {room.players >= room.maxPlayers ? '已满' : '加入'}
                </button>
              </div>
            ))}
          </div>
        )}
      </LbField>

      <p className="lb-hint">创建房间后把房间码发给好友，2 人即可开局（最多 4 人）。进房后在房间大厅里选角色、准备。</p>
    </LbDialog>
  );
}
