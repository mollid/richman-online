import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './rooms/GameRoom.js';

const app = express();
app.get('/', (_req, res) => {
  res.send('richman-online server');
});
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'richman-online-server' });
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

