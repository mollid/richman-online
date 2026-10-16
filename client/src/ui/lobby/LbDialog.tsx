import { useEffect, type ReactNode } from 'react';
import './lobby.css';

/**
 * 弹层外壳。
 *
 * 居中靠 `.lb-scrim` 的 `overflow:auto` + `.lb-dialog` 的 `margin:auto`，不是 `place-items:center` ——
 * 后者在内容超出视口时会把面板顶部推出滚动区且滚不回来（旧 `.setup-screen` 与 `.ac-scrim` 都栽过）。
 * 开局面板里的角色格 + 房间列表很容易超出一屏，所以这条在这里钉死。
 */
export function LbDialog({
  title,
  sub,
  tone,
  wide,
  onClose,
  children,
}: {
  title: string;
  sub?: string;
  tone?: 'blue' | 'orange';
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="lb-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`lb-dialog${wide ? ' lb-dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className={`lb-dialog__hd${tone ? ` lb-dialog__hd--${tone}` : ''}`}>
          <span className="lb-dialog__hd-txt">
            {title}
            {sub && <span className="lb-dialog__hd-sub">{sub}</span>}
          </span>
          <button className="lb-dialog__x" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="lb-dialog__bd">{children}</div>
      </div>
    </div>
  );
}

/** 一排互斥选项（人数 / 金额 / 时长 / 地图 都用它） */
export function LbSeg<T>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  options: Array<{ key: string; value: T; label: ReactNode; disabled?: boolean; title?: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="lb-field">
      <span className="lb-field__label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <div className="lb-seg">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            title={o.title}
            disabled={o.disabled}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function LbField({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="lb-field">
      <span className="lb-field__label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </div>
  );
}
