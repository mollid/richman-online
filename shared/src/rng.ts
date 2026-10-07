/** mulberry32：确定性整数 RNG，状态内嵌于 GameState，便于服务器权威与回放 */
export function nextRandom(state: number): { value: number; nextState: number } {
  function mulberry32(a: number) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const fn = mulberry32(state);
  const value = fn();
  return { value, nextState: (state + 0x6d2b79f5) | 0 };
}

export function rollDie(state: number): { value: 1 | 2 | 3 | 4 | 5 | 6; nextState: number } {
  const { value, nextState } = nextRandom(state);
  return { value: (Math.floor(value * 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6, nextState };
}
