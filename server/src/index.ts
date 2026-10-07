import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer } from 'node:http';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './rooms/GameRoom.js';
import { authRouter } from './auth.js';
import { getLeaderboard, initStorage } from './storage.js';

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

/** 大厅房间列表（0.16 的 matchmake 不支持 GET，走自定义接口） */
app.get('/api/rooms', async (_req, res) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    const rooms = await matchMaker.query({ name: 'game' });
    res.json(
      rooms.map((room) => ({
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



