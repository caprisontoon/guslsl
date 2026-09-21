/** 0 이상 1 미만을 돌려주는 난수 함수 */
export type Rng = () => number;

/**
 * mulberry32. 같은 시드면 같은 수열이 나온다.
 *
 * 구슬마다 자기 수열을 따로 갖게 하려고 쓴다. 전역 Math.random 을 쓰면 여러 구슬이
 * 하나의 수열을 나눠 쓰게 되어, 어느 구슬이 먼저 뽑느냐(=프레임당 스텝 수)에 따라
 * 결과가 달라진다. 구슬별로 분리하면 소비 순서와 무관하게 재현된다.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 라운드 시드와 구슬 번호를 섞어 구슬별 시드를 만든다 */
export function deriveSeed(roundSeed: number, index: number): number {
  let h = (roundSeed >>> 0) ^ Math.imul(index + 1, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}
