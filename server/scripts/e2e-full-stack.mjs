/**
 * 全栈终局验证（快速路径）：
 * 两个注册账号 → 建房/加入 → 开局 → test_finish 触发真实 game_over/战绩链路 → 排行榜验证
 * 前提：docker compose 栈已启动，且 server 开启 RICHMAN_TEST_MODE=1
 */
import { Client } from 'colyseus.js';

const HTTP = 'http://localhost:2567/api';
const log = (...args) => console.log('[fullstack]', ...args);

async function ensureUser(username) {
  const body = JSON.stringify({ username, password: 'richman123' });
  let res = await fetch(`${HTTP}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) {
    res = await fetch(`${HTTP}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  }
  if (!res.ok) throw new Error(`账号准备失败: ${res.status}`);
  return res.json();
}

const suffix = Math.floor(Math.random() * 100000);
const userA = await ensureUser(`战神${suffix}`);
const userB = await ensureUser(`小影${suffix}`);
log(`账号就绪：${userA.user.username} / ${userB.user.username}`);

const clientA = new Client('ws://localhost:2567');
const roomA = await clientA.create('game', { name: userA.user.username, token: userA.token });
log(`房间 ${roomA.roomId} 已创建`);

const clientB = new Client('ws://localhost:2567');
const roomB = await clientB.joinById(roomA.roomId, { name: userB.user.username, token: userB.token });

let state = null;
const onState = (snapshot) => { state = snapshot.game; };
roomA.onMessage('state', onState);
roomB.onMessage('state', onState);

const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  if (state && state.players.length === 2) break;
  await new Promise((r) => setTimeout(r, 50));
}
if (!state || state.players.length !== 2) throw new Error('未同步到双玩家状态');

roomA.send('start_game', {});
while (state.phase === 'lobby') await new Promise((r) => setTimeout(r, 50));
log('对局开始 → 触发 test_finish（走真实 game_over/战绩链路）');

roomB.send('test_finish', {}); // 乙获胜

const endDeadline = Date.now() + 6000;
while (Date.now() < endDeadline) {
  if (state.phase === 'game_over') break;
  await new Promise((r) => setTimeout(r, 50));
}
if (state.phase !== 'game_over') throw new Error('对局未进入 game_over');
const winner = state.players.find((p) => p.id === state.winnerId);
log(`对局结束！胜者：${winner?.name}`);

await new Promise((r) => setTimeout(r, 1500)); // 等待异步入库
const leaderboard = await (await fetch(`${HTTP}/leaderboard`)).json();
log(`排行榜：${JSON.stringify(leaderboard)}`);
const winnerEntry = leaderboard.find((e) => e.username === winner?.name && e.wins >= 1);
if (!winnerEntry) throw new Error('排行榜中未找到胜者战绩');
log(`战绩入库验证通过：${winnerEntry.username} ${winnerEntry.wins} 胜 / ${winnerEntry.games} 局`);
log('FULL STACK PASS ✅');
process.exit(0);
