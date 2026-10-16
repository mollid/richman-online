import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer } from 'node:http';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom, ROOM_IDLE_TIMEOUT_SEC } from './rooms/GameRoom.js';
import { authRouter, requireAuth, type AuthedRequest } from './auth.js';
import { getLeaderboard, getRecord, initStorage, listUserRecords, recordBelongsToUser } from './storage.js';

const app = express();
app.use(express.json());

// API 跨域（客户端与服务器端口不同）
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/', (_req, res) => {
  res.send('richman-online server');
});
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'richman-online-server' });
});

app.use('/api/auth', authRouter);

app.get('/api/leaderboard', async (_req, res) => {
  try {
    res.json(await getLeaderboard());
  } catch {
    res.status(500).json({ error: '获取排行榜失败' });
  }
});

/**
 * 回放只对局中人开放：列表按登录账号过滤，单条还要再核一次归属。
 *
 * 原来这里挂的是 `/api/records/recent` —— 任何人不带票就能把全服每局的完整动作日志拖走。
 * 收进用户菜单之后，这条口子必须跟着关：能看的只有「你自己打过的那几局」。
 */
app.get('/api/records/mine', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
    res.json(await listUserRecords((req as AuthedRequest).user!.id, limit));
  } catch {
    res.status(500).json({ error: '获取对局列表失败' });
  }
});

app.get('/api/records/:id', requireAuth, async (req, res) => {
  try {
    if (!(await recordBelongsToUser(req.params.id!, (req as AuthedRequest).user!.id))) {
      res.status(403).json({ error: '这局对局与你无关' });
      return;
    }
    const record = await getRecord(req.params.id!);
    if (!record) {
      res.status(404).json({ error: '对局记录不存在' });
      return;
    }
    res.json(record);
  } catch {
    res.status(500).json({ error: '获取回放失败' });
  }
});

/** 大厅房间列表（0.16 的 matchmake 不支持 GET，走自定义接口） */
app.get('/api/rooms', async (_req, res) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    const rooms = await matchMaker.query({ name: 'game' });
    res.json(
      rooms
        .filter((room) => {
          const meta = room.metadata as { private?: boolean; idleSec?: number } | undefined;
          // 私密房不进列表：连 roomId 都不下发，只能靠房主主动发码加入
          if (meta?.private === true) return false;
          // 到点先由这里把它从列表摘掉，房间本身晚一个扫描周期才被真收（见 GameRoom.sweepIdle）
          if ((meta?.idleSec ?? 0) >= ROOM_IDLE_TIMEOUT_SEC) return false;
          return true;
        })
        .map((room) => ({
          roomId: room.roomId,
          clients: room.clients,
          maxClients: room.maxClients,
          metadata: room.metadata ?? {},
        })),
    );
  } catch {
    res.status(500).json({ error: '查询房间列表失败' });
  }
});

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});
gameServer.define('game', GameRoom);

const port = Number(process.env.PORT ?? 2567);
void initStorage();
httpServer.listen(port, () => {
  console.log(`[server] Colyseus 对战服务已启动: ws://localhost:${port}`);
  console.log(`[server] 健康检查: http://localhost:${port}/healthz`);
});




