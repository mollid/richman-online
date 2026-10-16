import type { CharacterDef } from '@richman/shared';

/**
 * 角色立绘地址。
 *
 * 文件名以 `characters.ts` 的 id 为键（不是座位号）：角色表扩到 10 人后座位序与图序就会错开，
 * 而 id 是稳定键 —— 加人、改名都不用回来改这里。与 `BoardRenderer` 的棋子贴图同源同批。
 */
export function characterPortrait(id: string): string {
  return `/art/char_${id}@v6.png`;
}

/** 卡片上的那行人设字段：性别年龄，占位说明留给 title */
export function characterVital(c: CharacterDef): string {
  return `${c.gender === 'male' ? '男' : '女'} · ${c.age} 岁`;
}
