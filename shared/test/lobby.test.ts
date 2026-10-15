import { describe, expect, it } from 'vitest';

import {
  addPlayer,
  applyAction,
  characterById,
  createGame,
  removePlayer,
  setLobbyCharacter,
  setLobbyReady,
  type GameState,
} from '../src/index.js';

/**
 * 联机大厅的房主与准备态。
 *
 * 这两个字段放进 `GameState` 而不是留在 `GameRoom` 里，为的是让「全员准备才能开局」
 * 成为引擎规则：这样热座（`ready` 默认 true）不受影响，而任何客户端绕过按钮直接发
 * START_GAME 也会被挡。房主权限（谁能按）仍在服务端，因为那要认 sessionId。
 */

function lobby(): GameState {
  return createGame([], 7, { startDate: { year: 2026, month: 1, day: 5 } });
}

function join(state: GameState, id: string, opts: { name?: string; characterId?: string; ready?: boolean } = {}): GameState {
  return addPlayer(state, {
    id,
    name: opts.name ?? id,
    color: 0x000000,
    characterId: opts.characterId,
    ready: opts.ready,
  });
}

describe('房主选举', () => {
  it('第一个进房的人拿槌子，后来者不改写', () => {
    let s = join(lobby(), 'a');
    expect(s.hostId).toBe('a');
    s = join(s, 'b');
    expect(s.hostId).toBe('a');
  });

  it('房主离开后转给最早加入的幸存者，并播报一条', () => {
    let s = join(join(join(lobby(), 'a'), 'b'), 'c');
    s = removePlayer(s, 'a');
    expect(s.hostId).toBe('b');
    expect(s.log.at(-1)!.text).toContain('房主转给 b');
  });

  it('房走光了就没有房主，但也不报错', () => {
    let s = join(lobby(), 'a');
    s = removePlayer(s, 'a');
    expect(s.hostId).toBeNull();
  });

  it('createGame 直接带人建房时，第一个人就是房主', () => {
    const s = createGame([{ id: 'x', name: 'X', color: 0 }, { id: 'y', name: 'Y', color: 1 }], 7);
    expect(s.hostId).toBe('x');
  });
});

describe('准备态', () => {
  it('没显式声明就默认已准备 —— 热座与 AI 补位不该被这道门挡住', () => {
    const s = join(lobby(), 'a');
    expect(s.players[0]!.ready).toBe(true);
  });

  it('联机进房显式给 false', () => {
    const s = join(lobby(), 'a', { ready: false });
    expect(s.players[0]!.ready).toBe(false);
  });

  it('有人没准备就开不了局，且拒绝文案点名是谁', () => {
    let s = join(join(lobby(), 'a'), 'b', { ready: false });
    expect(() => applyAction(s, { type: 'START_GAME' })).toThrow(/未准备/);
    try {
      applyAction(s, { type: 'START_GAME' });
    } catch (e) {
      expect((e as Error).message).toContain('b');
    }
    s = setLobbyReady(s, 'b', true);
    expect(applyAction(s, { type: 'START_GAME' }).phase).not.toBe('lobby');
  });

  it('取消准备同样走这条通道', () => {
    let s = join(join(lobby(), 'a'), 'b');
    s = setLobbyReady(s, 'a', false);
    expect(s.players.find((p) => p.id === 'a')!.ready).toBe(false);
    expect(() => applyAction(s, { type: 'START_GAME' })).toThrow(/未准备/);
  });

  it('开局之后不再允许改准备态', () => {
    const playing = applyAction(join(join(lobby(), 'a'), 'b'), { type: 'START_GAME' });
    expect(() => setLobbyReady(playing, 'a', false)).toThrow(/对局已开始/);
  });

  it('状态没变就不产生新对象（客户端连点不该刷出两份状态）', () => {
    const s = join(lobby(), 'a');
    expect(setLobbyReady(s, 'a', true)).toBe(s);
  });
});

describe('大厅换角色', () => {
  it('换成功会同步头像、性别、颜色，并退回未准备', () => {
    let s = join(join(lobby(), 'a'), 'b', { ready: false });
    expect(s.players[0]!.characterId).toBe('afu');
    s = setLobbyCharacter(s, 'a', 'tiexiong');
    const me = s.players.find((p) => p.id === 'a')!;
    const ch = characterById('tiexiong')!;
    expect(me.characterId).toBe(ch.id);
    expect(me.avatar).toBe(ch.avatar);
    expect(me.gender).toBe(ch.gender);
    expect(me.color).toBe(ch.color);
    expect(me.ready).toBe(false);
  });

  it('别人占着的角色换不动', () => {
    const s = join(join(lobby(), 'a'), 'b');
    expect(() => setLobbyCharacter(s, 'a', s.players[1]!.characterId)).toThrow(/已被别人选走/);
  });

  it('用角色名当默认名的人，换角色后牌子跟着换', () => {
    // 不填昵称时名字就是角色名（`GameRoom.onJoin` 定的）。此时若名字不动，
    // 就会出现「头像小美、名字阿福」——正是这张表当初收掉 DEFAULT_NAMES 要防的事。
    const s = join(lobby(), 'd', { name: '阿福', characterId: 'afu' });
    expect(setLobbyCharacter(s, 'd', 'xiaomei').players[0]!.name).toBe('小美');
  });

  it('自己起的昵称不跟着角色走', () => {
    const s = join(lobby(), 'c', { name: '测试甲' });
    expect(setLobbyCharacter(s, 'c', 'guanlaoji').players[0]!.name).toBe('测试甲');
  });

  it('点自己已经选着的那个 = 什么都不发生，也不会被踢回未准备', () => {
    let s = join(join(lobby(), 'a'), 'b');
    s = setLobbyReady(s, 'a', true);
    expect(setLobbyCharacter(s, 'a', s.players[0]!.characterId)).toBe(s);
  });
});
