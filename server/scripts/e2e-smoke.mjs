/**
 * 联机全链路冒烟测试：
 * 两个客户端连接 Colyseus 服务器 → 创建/加入房间 → 开局 → 掷骰 → 校验快照广播
 * 用法：先启动服务器（pnpm dev:server），再执行 node server/scripts/e2e-smoke.mjs
 */
import { Client } from 'colyseus.js';

const endpoint = process.env.SERVER_URL ?? 'ws://localhost:2567';
const log = (...args) => console.log('[smoke]', ...args);

const clientA = new Client(endpoint);
const roomA = await clientA.create('game', { name: '玩家甲' });
log(`玩家甲创建房间 ${roomA.roomId}`);

let stateA = null;
roomA.onMessage('state', ({ game }) => {
  stateA = game;
});
roomA.onMessage('error', ({ message }) => {
  throw new Error(`服务器拒绝: ${message}`);
});

async function waitA(check, label, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stateA && check(stateA)) return stateA;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${label} 超时`);
}

const clientB = new Client(endpoint);
const roomB = await clientB.joinById(roomA.roomId, { name: '玩家乙' });
log('玩家乙加入房间');

let stateB = null;
roomB.onMessage('state', ({ game }) => {
  stateB = game;
});

// 双方都应收到 2 人快照
const startWait = Date.now();
while (Date.now() - startWait < 6000) {
  if (stateA?.players.length === 2 && stateB?.players.length === 2) break;
  await new Promise((r) => setTimeout(r, 50));
}
if (!(stateA?.players.length === 2 && stateB?.players.length === 2)) {
  throw new Error('未收到双玩家快照');
}
log('双方均收到双玩家快照');

// 非房主尝试开局应被拒绝？—— 当前设计允许任意成员开局，直接由玩家甲开始
roomA.send('start_game', {});
await waitA((g) => g.phase === 'awaiting_roll', '开局');
log(`游戏开始 turn=${stateA.turn}`);

// 非当前玩家操作应收到错误
let rejected = false;
roomA.onMessage('error', () => {
  rejected = true;
});

// 玩家甲掷骰
roomA.send('action', { action: { type: 'ROLL_DICE' } });
await waitA((g) => g.dice !== null || g.turn >= 2, '掷骰');
log(`掷骰完成 dice=${JSON.stringify(stateA.dice)} phase=${stateA.phase}`);

// 若进入决策阶段则结束回合，让流程回到掷骰
if (stateA.phase === 'awaiting_action') {
  roomA.send('action', { action: { type: 'END_TURN' } });
  await waitA((g) => g.phase === 'awaiting_roll', '结束回合');
  log('决策后结束回合完成');
}

// 校验两客户端快照一致（权威服务器广播）
if (JSON.stringify(stateA) !== JSON.stringify(stateB)) {
  throw new Error('两客户端快照不一致');
}
log('两客户端快照一致 ✅');
log('E2E SMOKE PASS');
process.exit(0);
