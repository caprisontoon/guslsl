import type { FieldSlot, GameConfig, Prize } from './types';

/**
 * 구슬 이름 파서(utils/parseName)가 `/`를 가중치, `*`를 개수 구분자로 읽는다.
 * 상품명에 이 문자가 들어가면 이름이 잘려 다른 상품과 뭉개지므로 필드에 올리기 전에 막는다.
 */
export const FORBIDDEN_NAME_CHARS = /[/*]/;

export function sanitizeLabel(name: string): string {
  return name.replace(/[/*]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 노출 중이고 당첨 한도가 남은 상품만 실제로 필드에 오른다 */
export function availablePrizes(config: GameConfig): Prize[] {
  return config.prizes.filter((p) => p.visible && (p.winnerLimit === 0 || p.awarded < p.winnerLimit));
}

/** 설정된 상품 확률의 합. 나머지가 꽝 확률이다 */
export function totalPrizeProbability(prizes: Prize[]): number {
  return prizes.reduce((sum, p) => sum + p.probability, 0);
}

type Apportioned = { prize: Prize | null; count: number };

/**
 * 확률(%)을 구슬 개수로 환산한다. 최대잔여법이라 개수 합이 정확히 fieldSize 가 되고,
 * 각 상품의 실제 확률(count / fieldSize)이 설정값에 가장 가깝게 떨어진다.
 *
 * 이 개수 비율이 곧 당첨 확률이다. 구슬의 출발 위치는 setMarbles 에서 셔플되므로
 * 어느 구슬이 1등으로 들어올지는 균등하고, 따라서 P(상품) = 개수 / 전체가 된다.
 */
export function apportion(config: GameConfig): Apportioned[] {
  const prizes = availablePrizes(config);
  const loseProbability = Math.max(0, 100 - totalPrizeProbability(prizes));
  const entries: { prize: Prize | null; probability: number }[] = [
    ...prizes.map((prize) => ({ prize, probability: prize.probability })),
    { prize: null, probability: loseProbability },
  ];

  const total = entries.reduce((sum, e) => sum + e.probability, 0);
  if (total <= 0) return [{ prize: null, count: config.fieldSize }];

  const raw = entries.map((e) => (e.probability / total) * config.fieldSize);
  const counts = raw.map((v) => Math.floor(v));
  let left = config.fieldSize - counts.reduce((sum, v) => sum + v, 0);

  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0; k++, left--) {
    counts[order[k % order.length].i]++;
  }

  return entries.map((e, i) => ({ prize: e.prize, count: counts[i] }));
}

/** 관리자에게 보여줄 '설정 확률 대비 실제 확률'. 개수로 환산하며 생기는 오차를 드러낸다 */
export function effectiveOdds(config: GameConfig): { label: string; target: number; actual: number; count: number }[] {
  return apportion(config).map(({ prize, count }) => ({
    label: prize ? prize.name : config.loseLabel,
    target: prize ? prize.probability : Math.max(0, 100 - totalPrizeProbability(availablePrizes(config))),
    actual: config.fieldSize > 0 ? (count / config.fieldSize) * 100 : 0,
    count,
  }));
}

/** 레이스에 올릴 구슬 한 칸씩. 위치 셔플은 엔진(setMarbles)이 한다 */
export function buildField(config: GameConfig): FieldSlot[] {
  const slots: FieldSlot[] = [];
  for (const { prize, count } of apportion(config)) {
    const label = sanitizeLabel(prize ? prize.name : config.loseLabel) || '꽝';
    for (let i = 0; i < count; i++) {
      slots.push({ label, prize });
    }
  }
  return slots;
}

export type ConfigIssue = { level: 'error' | 'warn'; message: string };

export function validateConfig(config: GameConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const prizes = config.prizes;
  const sum = totalPrizeProbability(prizes);

  if (config.entryFee < 0) issues.push({ level: 'error', message: '참가비는 0 이상이어야 합니다.' });
  if (config.fieldSize < 2) issues.push({ level: 'error', message: '구슬 수는 2개 이상이어야 합니다.' });
  if (sum > 100) {
    issues.push({ level: 'error', message: `상품 확률 합계가 ${sum.toFixed(2)}%입니다. 100%를 넘을 수 없습니다.` });
  }
  if (config.consolationCorn > config.entryFee) {
    issues.push({ level: 'warn', message: '꽝 기본 혜택이 참가비보다 많습니다. 판마다 강냉이가 늘어납니다.' });
  }

  const names = new Set<string>();
  for (const p of prizes) {
    const label = sanitizeLabel(p.name);
    if (!label) {
      issues.push({ level: 'error', message: '상품 이름이 비어 있습니다.' });
      continue;
    }
    if (FORBIDDEN_NAME_CHARS.test(p.name)) {
      issues.push({ level: 'error', message: `'${p.name}': 상품 이름에 / 와 * 는 쓸 수 없습니다.` });
    }
    if (names.has(label)) {
      issues.push({ level: 'error', message: `'${label}': 상품 이름이 중복됩니다. 당첨 상품을 구분할 수 없습니다.` });
    }
    names.add(label);
    if (p.probability < 0) {
      issues.push({ level: 'error', message: `'${label}': 확률은 0 이상이어야 합니다.` });
    }
  }
  if (names.has(sanitizeLabel(config.loseLabel))) {
    issues.push({ level: 'error', message: '꽝 이름과 같은 상품이 있습니다.' });
  }

  for (const { prize, count } of apportion(config)) {
    if (prize && prize.probability > 0 && count === 0) {
      issues.push({
        level: 'warn',
        message: `'${prize.name}': 확률 ${prize.probability}%가 구슬 ${config.fieldSize}개로는 표현되지 않아 당첨될 수 없습니다. 구슬 수를 늘리세요.`,
      });
    }
  }

  return issues;
}

/** 한 판의 기대 강냉이 수지. 운영자가 소진 속도를 가늠하는 값 */
export function expectedCornPerRound(config: GameConfig): number {
  const payout = apportion(config).reduce((sum, { prize, count }) => {
    const p = config.fieldSize > 0 ? count / config.fieldSize : 0;
    return sum + p * (prize ? prize.cornValue : config.consolationCorn);
  }, 0);
  return payout - config.entryFee;
}
