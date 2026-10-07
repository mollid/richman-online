import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './rooms/GameRoom.js';

const app = express();
app.get('/', (_req, res) => {
  res.send('richman-online server');
});
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'richman-online-server' });
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
httpServer.listen(port, () => {
  console.log(`[server] Colyseus 对战服务已启动: ws://localhost:${port}`);
  console.log(`[server] 健康检查: http://localhost:${port}/healthz`);
});


