/**
 * 강냉이 레이스의 확률과 재생 결정성을 검증한다.
 *
 *   yarn verify:odds            기본 (환산 + 추첨 분포 + 결정성)
 *   yarn verify:odds 300        결정성 확인에 쓸 시드 수
 *
 * 검증 대상이 세 가지다.
 *
 *  1) 환산   설정 확률(%)이 구슬 개수로 정확히 떨어지는가 (apportion)
 *  2) 추첨   서버가 그 구성에서 균등하게 하나를 뽑을 때 분포가 설정과 같은가
 *  3) 재생   같은 시드가 항상 같은 1등 칸을 내는가
 *
 * 당첨 확률은 물리와 무관하다. 서버가 구성에서 균등 추첨으로 상품을 정하고, 시드가
 * 정한 1등 칸에 그 상품을 올려놓기 때문이다. 물리는 연출을 맡고, 그 연출이 서버의
 * 답과 어긋나지 않는지를 3) 이 확인한다.
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { Box2dPhysics } from '../src/physics-box2d';
import { DEFAULT_CONFIG } from '../src/toonland/api';
import { apportion, buildField } from '../src/toonland/prizeTable';
import type { GameConfig, Prize } from '../src/toonland/types';
import { predictWinner } from './seed-pool';

class NodePhysics extends Box2dPhysics {
  async init(): Promise<void> {
    const wasmBinary = fs.readFileSync(new URL('../node_modules/box2d-wasm/dist/umd/Box2D.simd.wasm', import.meta.url));
    const self = this as any;
    self.Box2D = await Box2DFactory({ wasmBinary } as any);
    self.gravity = new self.Box2D.b2Vec2(0, 10);
    self.world = new self.Box2D.b2World(self.gravity);
  }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

/** 카이제곱 분포 상위 0.1% 기준값 (자유도별). 표를 쓰는 편이 근사식보다 읽기 쉽다 */
const CHI_SQ_P001: Record<number, number> = {
  1: 10.83,
  2: 13.82,
  3: 16.27,
  4: 18.47,
  5: 20.52,
  6: 22.46,
  7: 24.32,
  8: 26.12,
  9: 27.88,
  10: 29.59,
};

/** 확률 -> 구슬 개수 환산이 정확한지 (합이 전체와 같은지, 비율이 설정에 가까운지) */
function checkApportion(): boolean {
  const cases: { name: string; config: GameConfig }[] = [
    { name: '기본 설정', config: DEFAULT_CONFIG },
    {
      name: '0.5% 단위 (구슬 200개)',
      config: {
        ...DEFAULT_CONFIG,
        fieldSize: 200,
        prizes: DEFAULT_CONFIG.prizes.map((p, i) => ({ ...p, probability: [0.5, 1.5, 3, 12.5, 7][i] ?? 1 })),
      },
    },
    {
      name: '상품 확률 합계 100% (꽝 없음)',
      config: {
        ...DEFAULT_CONFIG,
        prizes: DEFAULT_CONFIG.prizes.map((p, i) => ({ ...p, probability: [10, 20, 30, 25, 15][i] ?? 0 })),
      },
    },
  ];

  let ok = true;
  console.log('## 확률 -> 구슬 개수 환산\n');
  for (const { name, config } of cases) {
    const rows = apportion(config);
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const sumOk = total === config.fieldSize;
    if (!sumOk) ok = false;

    console.log(`### ${name} (구슬 ${config.fieldSize}개)`);
    console.log('| 항목 | 설정 | 개수 | 실제 | 오차 |');
    console.log('|---|---:|---:|---:|---:|');
    for (const { prize, count } of rows) {
      const target = prize
        ? prize.probability
        : Math.max(0, 100 - config.prizes.filter((p) => p.visible).reduce((s, p) => s + p.probability, 0));
      const actual = (count / config.fieldSize) * 100;
      const diff = actual - target;
      if (Math.abs(diff) > 100 / config.fieldSize) ok = false;
      console.log(
        `| ${prize ? prize.name : config.loseLabel} | ${target.toFixed(2)}% | ${count} | ${actual.toFixed(2)}% | ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%p |`
      );
    }
    console.log(`\n합계 ${total} / ${config.fieldSize} ${sumOk ? 'OK' : '불일치!'}\n`);
  }
  return ok;
}

/** 서버가 하는 추첨: 구성에서 균등하게 하나를 뽑는다 */
function drawWinner(field: { prize: Prize | null }[]): Prize | null {
  return field[Math.floor(Math.random() * field.length)].prize;
}

function checkDraw(rounds: number): boolean {
  const config = DEFAULT_CONFIG;
  const field = buildField(config);
  const counts = new Map<string, number>();
  for (let i = 0; i < rounds; i++) {
    const prize = drawWinner(field);
    const label = prize ? prize.name : config.loseLabel;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const expected = new Map(
    apportion(config).map(({ prize, count }) => [prize ? prize.name : config.loseLabel, count / field.length])
  );

  console.log(`## 추첨 분포 ${rounds.toLocaleString()}판\n`);
  console.log('| 항목 | 설정 확률 | 실측 | 당첨 수 | 기대 수 | 편차 |');
  console.log('|---|---:|---:|---:|---:|---:|');
  let chiSq = 0;
  let cells = 0;
  for (const [label, p] of expected) {
    const wins = counts.get(label) ?? 0;
    const expectedWins = p * rounds;
    const sd = Math.sqrt((p * (1 - p)) / rounds);
    const z = sd > 0 ? (wins / rounds - p) / sd : 0;
    if (expectedWins > 0) {
      chiSq += (wins - expectedWins) ** 2 / expectedWins;
      cells++;
    }
    console.log(
      `| ${label} | ${pct(p)} | ${pct(wins / rounds)} | ${wins} | ${expectedWins.toFixed(1)} | ${z >= 0 ? '+' : ''}${z.toFixed(2)}σ |`
    );
  }
  const df = Math.max(1, cells - 1);
  const limit = CHI_SQ_P001[df] ?? Number.POSITIVE_INFINITY;
  const ok = chiSq <= limit;
  console.log(`\n카이제곱 ${chiSq.toFixed(2)} (자유도 ${df}, 0.001 기준값 ${limit.toFixed(2)}) -> ${ok ? '설정과 일치' : '불일치!'}\n`);
  return ok;
}

/** 같은 시드가 항상 같은 1등 칸을 내는지. 어긋나면 화면과 서버 판정이 달라진다 */
async function checkReplay(seedCount: number): Promise<boolean> {
  const config = DEFAULT_CONFIG;
  const n = buildField(config).length;
  const physics = new NodePhysics();
  await physics.init();

  console.log(`## 재생 결정성 (시드 ${seedCount}개)\n`);
  let ok = true;
  const seeds = Array.from({ length: seedCount }, () => Math.floor(Math.random() * 0xffffffff) >>> 0);
  const first = seeds.map((seed) => predictWinner(physics, seed, n, config.mapIndex));
  // 순서를 뒤집어 다시 돌린다. 앞선 판이 결과에 새면 여기서 드러난다
  const second = [...seeds].reverse().map((seed) => predictWinner(physics, seed, n, config.mapIndex)).reverse();

  for (let i = 0; i < seeds.length; i++) {
    if (first[i] !== second[i] || first[i] < 0) {
      ok = false;
      console.log(`  seed=${seeds[i]}: ${first[i]} vs ${second[i]} 불일치!`);
    }
  }
  console.log(`  ${seeds.length}개 시드 모두 재현: ${ok ? 'OK' : '실패'}`);
  console.log(`  1등 칸 분포: 서로 다른 값 ${new Set(first).size}개\n`);
  return ok;
}

async function main() {
  const seedCount = Number(process.argv[2] ?? 200);

  const apportionOk = checkApportion();
  const drawOk = checkDraw(200_000);
  const replayOk = await checkReplay(seedCount);

  console.log(`환산 ${apportionOk ? '통과' : '실패'} / 추첨 ${drawOk ? '통과' : '실패'} / 재생 ${replayOk ? '통과' : '실패'}`);
  if (!apportionOk || !drawOk || !replayOk) process.exitCode = 1;
}

main();
