/**
 * 角色表（波 3）。
 *
 * 为什么现在才要：魔法屋的目标条件里有「所有男生 / 所有女生」两条（A §三），而在此之前
 * 玩家身上根本没有性别这个概念 —— 角色名是 `session.ts` 里硬编码的四个字符串，
 * 头像是 `hud.js` 里两张写死的表。这两处各抄一份表现数据，正是魔法屋黑屏那类漂移的温床，
 * 所以一并收进来：本表是**唯一出处**，引擎读 `gender` 做判定，HUD 读 `avatar` 做展示。
 *
 * 座位序是刻意排的：**男女交替**。热座与联机常只开 2~4 人，若按"先男后女"排，
 * 两人局就永远是两位男性，性别那两条条件形同虚设；交替之后 2/3/4 人局都至少各有一男一女。
 *
 * `id` 是给后期被动技能系统挂的稳定键（名字会改、人设会说谎，id 不动），
 * 所以它既不是中文名也不是下标 —— 下标会随表增删而错位。
 */

export type Gender = 'male' | 'female';

export interface CharacterDef {
  id: string;
  name: string;
  gender: Gender;
  /** 登场年龄：只做人设与表现（有老有少是决策人点的要求），规则一律不读 */
  age: number;
  /** PixiJS 可用的 0xRRGGBB 颜色 */
  color: number;
  /** 头像：HUD 与棋盘共用一个 emoji，无素材依赖 */
  avatar: string;
  /** 一句人设。括号里是被动技能系统的预置落点，实现时按 `id` 挂 */
  blurb: string;
}

export const CHARACTERS: CharacterDef[] = [
  { id: 'afu', name: '阿福', gender: 'male', age: 17, color: 0xef5350, avatar: '🐵', blurb: '庙口跑腿的少年，运气好过脑子（被动方向：免灾 / 歪打正着）' },
  { id: 'xiaomei', name: '小美', gender: 'female', age: 24, color: 0x42a5f5, avatar: '🐬', blurb: '百货柜台的金牌店员，认得每件货的底价（被动方向：折扣 / 点券）' },
  { id: 'tiexiong', name: '铁雄', gender: 'male', age: 29, color: 0x66bb6a, avatar: '🐗', blurb: '保安队长，拳头先跟您讲道理（被动方向：阻挠 / 对抗）' },
  { id: 'baixiaolu', name: '白小鹿', gender: 'female', age: 19, color: 0xd4e157, avatar: '🐇', blurb: '快递少女，全城没有她跑不到的格（被动方向：移动 / 骰子）' },
  { id: 'husansi', name: '胡三思', gender: 'male', age: 41, color: 0xab47bc, avatar: '🦊', blurb: '当铺掌柜，算盘打得比谁都响（被动方向：交易 / 议价）' },
  { id: 'huadasao', name: '花大嫂', gender: 'female', age: 37, color: 0xffa726, avatar: '🐔', blurb: '里长太太，钱进了她手里就别想出去（被动方向：存款 / 保险）' },
  { id: 'jiabanxian', name: '贾半仙', gender: 'male', age: 53, color: 0x26c6da, avatar: '🦉', blurb: '庙口神算，铁口直断、概不负责（被动方向：神明 / 命运）' },
  { id: 'sumopo', name: '苏媒婆', gender: 'female', age: 48, color: 0xec407a, avatar: '🦜', blurb: '一张嘴能替你攀上任何一桩同盟（被动方向：同盟 / 消息）' },
  { id: 'guanlaoji', name: '关老吉', gender: 'male', age: 68, color: 0x8d6e63, avatar: '🐢', blurb: '收了一辈子租的老房东，钥匙比地契还多（被动方向：租金 / 利息）' },
  { id: 'lengqiuping', name: '冷秋萍', gender: 'female', age: 74, color: 0x78909c, avatar: '🦅', blurb: '退休的银行行长，拍卖槌一响她就笑（被动方向：贷款 / 拍卖）' },
];

const BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));

/** 按 id 取角色；id 不存在时返回 null（调用方自己决定是回落还是报错） */
export function characterById(id: string): CharacterDef | null {
  return BY_ID.get(id) ?? null;
}

/** 座位 → 角色：超出表长就回绕（表将来扩到 12 人，老代码不用改） */
export function characterOfSeat(seat: number): CharacterDef {
  return CHARACTERS[seat % CHARACTERS.length]!;
}
