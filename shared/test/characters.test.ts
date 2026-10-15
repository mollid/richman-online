import { describe, expect, it } from 'vitest';

import {
  applyAction,
  CHARACTERS,
  characterById,
  characterOfSeat,
  createGame,
  MAGIC_CONDITIONS,
  ReplayEngine,
  type GameState,
  type PlayerDef,
} from '../src/index.js';

/**
 * 波 3 角色表（`shared/src/characters.ts`）。
 *
 * 这张表同时喂着两处完全不同的消费者：引擎按 `gender` 判魔法屋的「所有男生 / 所有女生」，
 * HUD 按 `avatar` 画头像。所以这里钉的是**表的形状**——它一旦不成立，
 * 性别条件会静默退化成"全体"或"无人"，而 typecheck 什么都不会说。
 */

const SEATS: PlayerDef[] = [
  { id: 'p1', name: '一位', color: 0xef5350 },
  { id: 'p2', name: '二位', color: 0x42a5f5 },
  { id: 'p3', name: '三位', color: 0x66bb6a },
  { id: 'p4', name: '四位', color: 0xffa726 },
];

function newGame(seed = 42, players = SEATS): GameState {
  return applyAction(createGame(players, seed, { startDate: { year: 2026, month: 1, day: 5 } }), { type: 'START_GAME' });
}

describe('角色表（波 3）', () => {
  it('十人、五男五女、有老有少', () => {
    expect(CHARACTERS).toHaveLength(10);
    expect(CHARACTERS.filter((c) => c.gender === 'male')).toHaveLength(5);
    expect(CHARACTERS.filter((c) => c.gender === 'female')).toHaveLength(5);
    // 决策人点过"有老有少"：最小到最大至少跨一代人
    const ages = CHARACTERS.map((c) => c.age);
    expect(Math.max(...ages) - Math.min(...ages)).toBeGreaterThanOrEqual(40);
  });

  it('id / 颜色 / 头像各自唯一（撞色会让棋盘与账本认不出谁是谁）', () => {
    for (const key of ['id', 'color', 'avatar'] as const) {
      const values = CHARACTERS.map((c) => c[key]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('座位序男女交替：2~4 人局天然各有一男一女', () => {
    // 若排成"先男后女"，两人局就永远是两位男性，性别那两条条件直接退化
    for (let i = 0; i < CHARACTERS.length; i++) {
      expect(CHARACTERS[i]!.gender === 'male').toBe(i % 2 === 0);
    }
    for (const count of [2, 3, 4]) {
      const genders = CHARACTERS.slice(0, count).map((c) => c.gender);
      expect(new Set(genders).size).toBe(2);
    }
  });

  it('createGame 按座位派生 characterId / gender / avatar', () => {
    const g = newGame();
    expect(g.players.map((p) => p.characterId)).toEqual(['afu', 'xiaomei', 'tiexiong', 'baixiaolu']);
    expect(g.players.map((p) => p.gender)).toEqual(['male', 'female', 'male', 'female']);
    expect(g.players[0]!.avatar).toBe(characterById('afu')!.avatar);
  });

  it('显式选了角色就按选的来，没选才回落到座位', () => {
    // START_GAME 要求至少两人，所以配一个同座序的搭档
    const picked: PlayerDef[] = [
      { id: 'x', name: '随便', color: 0x123456, characterId: 'guanlaoji' },
      { id: 'y', name: '搭档', color: 0x654321 },
    ];
    const g = applyAction(createGame(picked, 7, { startDate: { year: 2026, month: 1, day: 5 } }), { type: 'START_GAME' });
    expect(g.players[0]!.characterId).toBe('guanlaoji');
    expect(g.players[0]!.gender).toBe('male');
    // 名字与颜色仍以调用方为准（联机大厅里玩家自己起的名字不该被角色表覆盖）
    expect(g.players[0]!.name).toBe('随便');
    expect(g.players[0]!.color).toBe(0x123456);
    // 没选的那位按座位取：座位 1 = 小美
    expect(g.players[1]!.characterId).toBe('xiaomei');
  });

  it('认不出的 id 回落到座位，不抛错也不留 undefined', () => {
    const bogus: PlayerDef[] = [
      { id: 'x', name: '甲', color: 1, characterId: 'nobody' },
      { id: 'y', name: '乙', color: 2 },
    ];
    const g = applyAction(createGame(bogus, 9, { startDate: { year: 2026, month: 1, day: 5 } }), { type: 'START_GAME' });
    expect(g.players[0]!.characterId).toBe(characterOfSeat(0).id);
    expect(g.players[0]!.gender).toBe('male');
  });
});

describe('录像与角色（波 3 补）', () => {
  const makeRecord = (players: Array<{ player_name: string; color: number; character_id?: string | null }>) => ({
    seed: 4242,
    startDate: { year: 2026, month: 1, day: 5 },
    players,
    actions: [],
  });

  it('录像带 character_id 就按它复现，不再靠座位回落', () => {
    const engine = new ReplayEngine(
      makeRecord([
        { player_name: '甲', color: 1, character_id: 'lengqiuping' },
        { player_name: '乙', color: 2, character_id: 'jiabanxian' },
      ]),
    );
    // 钉的是"角色 → 性别"这条链在重放里仍然成立：魔法屋的性别条件全靠它
    expect(engine.finalState.players.map((p) => [p.characterId, p.gender])).toEqual([
      ['lengqiuping', 'female'],
      ['jiabanxian', 'male'],
    ]);
  });

  it('老录像没这一列时按座位回落（开发阶段不为它做保底）', () => {
    const engine = new ReplayEngine(
      makeRecord([
        { player_name: '甲', color: 1 },
        { player_name: '乙', color: 2 },
      ]),
    );
    expect(engine.finalState.players.map((p) => p.characterId)).toEqual(['afu', 'xiaomei']);
  });
});

describe('魔法屋的性别条件（A §三 第 11、12 条）', () => {
  it('「所有男生」命中全部男性，「所有女生」命中全部女性', () => {
    // 默认四人局按座位取：afu(M) xiaomei(F) tiexiong(M) baixiaolu(F)
    const male = MAGIC_CONDITIONS.findIndex((c) => c.kind === 'all-male');
    const female = MAGIC_CONDITIONS.findIndex((c) => c.kind === 'all-female');
    expect(male).toBe(10);
    expect(female).toBe(11);

    for (const [index, expected] of [[male, ['p1', 'p3']], [female, ['p2', 'p4']]] as const) {
      const s = structuredClone(newGame(21, SEATS.slice(0, 4)));
      s.phase = 'awaiting_action';
      s.currentPlayerIndex = 0;
      s.magic = { condition: index === male ? 'all-male' : 'all-female' };
      // 用「存入所有现金」当探针：谁被转了存款，谁就在这份名单里
      const next = applyAction(s, { type: 'CAST_MAGIC', effect: 'to-deposit' });
      const hit = next.players.filter((p) => p.cash === 0 && p.deposit > 0).map((p) => p.id);
      expect(hit.sort()).toEqual([...expected].sort());
    }
  });

  it('性别条件不会命中不到人（每局至少一男一女，故不落入"默默收回水晶球"）', () => {
    for (const count of [2, 3, 4]) {
      const s = structuredClone(newGame(31, SEATS.slice(0, count)));
      s.phase = 'awaiting_action';
      s.currentPlayerIndex = 0;
      s.magic = { condition: 'all-male' };
      const next = applyAction(s, { type: 'CAST_MAGIC', effect: 'to-deposit' });
      expect(next.log.some((l) => l.text.includes('收回水晶球'))).toBe(false);
    }
  });
});
