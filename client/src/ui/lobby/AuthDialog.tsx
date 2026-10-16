import { useState } from 'react';
import { login as apiLogin, register as apiRegister, type AuthUser } from '../../net/auth.js';
import { LbDialog, LbField } from './LbDialog.js';

/**
 * 登录 / 注册面板。
 *
 * 做成一条输入 + 两个按钮，而不是两个页签：账号密码这两个框在两种意图下长得一样，
 * 分成页签只会让人先花两秒想"我到底注册过没有"。用户名未占用就注册成功、占用就落到登录，
 * 服务端两条路都回得清楚，不必前端先问。
 */
export function AuthDialog({
  reason,
  onDone,
  onClose,
}: {
  /** 为什么被要求登录（点了「单人模式」之类），成功后接着做这件事 */
  reason: string;
  onDone: (user: AuthUser) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (mode: 'login' | 'register') => {
    setBusy(true);
    setError('');
    try {
      onDone(mode === 'login' ? await apiLogin(name.trim(), pass) : await apiRegister(name.trim(), pass));
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const blocked = busy || !name.trim() || pass.length < 6;

  return (
    <LbDialog title="登录 / 注册" sub={reason} onClose={onClose}>
      <LbField label="账号" hint="2-16 位，字母 / 数字 / 下划线 / 中文">
        <input
          className="lb-input"
          autoFocus
          maxLength={16}
          placeholder="账号"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </LbField>
      <LbField label="密码" hint="至少 6 位">
        <input
          className="lb-input"
          type="password"
          maxLength={64}
          placeholder="密码"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !blocked) void submit('login');
          }}
        />
      </LbField>
      {error && <div className="lb-err">{error}</div>}
      <div className="lb-row">
        <button className="lb-go" disabled={blocked} onClick={() => void submit('login')}>
          {busy ? '处理中…' : '登录'}
        </button>
        <button className="lb-go lb-go--blue" disabled={blocked} onClick={() => void submit('register')}>
          注册新账号
        </button>
      </div>
      <p className="lb-hint">单机与联机都要先有账号：战绩与回放记在账号上，排行榜也按账号排。</p>
    </LbDialog>
  );
}
