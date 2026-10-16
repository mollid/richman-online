import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import {
  createSession,
  createUser,
  destroySession,
  findUserByUsername,
  getSessionUser,
  storageReady,
  validateCredentials,
  type UserRow,
} from './storage.js';

export const authRouter = Router();

export interface AuthedRequest extends Request {
  user?: UserRow;
  token?: string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const r = req as AuthedRequest;
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token || !storageReady.redis) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  void getSessionUser(token)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: '登录已过期，请重新登录' });
        return;
      }
      r.user = user;
      r.token = token;
      next();
    })
    .catch(() => res.status(500).json({ error: '服务器内部错误' }));
}

authRouter.post('/register', async (req, res) => {
  try {
    if (!storageReady.pg || !storageReady.redis) {
      res.status(503).json({ error: '账号服务未启用（数据库未连接）' });
      return;
    }
    const creds = validateCredentials(req.body?.username, req.body?.password);
    if (!creds) {
      res.status(400).json({ error: '用户名需 2-16 位（字母/数字/下划线/中文），密码至少 6 位' });
      return;
    }
    const existing = await findUserByUsername(creds.username);
    if (existing) {
      res.status(409).json({ error: '用户名已被占用' });
      return;
    }
    const user = await createUser(creds.username, creds.password);
    if (!user) {
      res.status(500).json({ error: '创建账号失败' });
      return;
    }
    const token = await createSession(user.id);
    res.status(201).json({ token, user: { id: user.id, username: user.username } });
  } catch (e) {
    res.status(e instanceof Error && e.message.includes('占用') ? 409 : 500).json({
      error: e instanceof Error ? e.message : '注册失败',
    });
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    if (!storageReady.pg || !storageReady.redis) {
      res.status(503).json({ error: '账号服务未启用（数据库未连接）' });
      return;
    }
    const creds = validateCredentials(req.body?.username, req.body?.password);
    if (!creds) {
      res.status(400).json({ error: '用户名或密码格式不正确' });
      return;
    }
    const user = await findUserByUsername(creds.username);
    if (!user || !(await bcrypt.compare(creds.password, user.password_hash))) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    const token = await createSession(user.id);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch {
    res.status(500).json({ error: '登录失败' });
  }
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  const r = req as AuthedRequest;
  if (r.token) await destroySession(r.token);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  const r = req as AuthedRequest;
  res.json({ user: { id: r.user!.id, username: r.user!.username } });
});
