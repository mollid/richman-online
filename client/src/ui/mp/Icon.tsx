import './tokens.css';

/**
 * 马卡龙图标。
 *
 * 走外链 sprite（`/mp/sprite.svg#i-x`）而不是把 70 多枚 symbol 内联进包：
 * 一次请求、浏览器缓存，且新增一枚只改 svg 不改 tsx。
 *
 * 注意一个坑：`<use href>` 指向不存在的 symbol 时**什么都不渲染**，不报错也不回落。
 * 所以图标 id 不要在这里写字符串字面量，从 `shared` 的那张表取（见 `@richman/shared` 的 `*_ICON`）。
 */
export function Icon({ id, size, tone, className }: { id: string; size?: 's' | 'l' | 'xl'; tone?: 'good' | 'bad' | 'flat'; className?: string }) {
  const cls = [
    'mp-icon',
    size ? `mp-icon--${size}` : '',
    tone ? `mp-icon--${tone}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <svg className={cls} aria-hidden="true" focusable="false">
      <use href={`/mp/sprite.svg#${id}`} />
    </svg>
  );
}
