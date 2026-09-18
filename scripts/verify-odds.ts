/**
 * 강냉이 레이스의 당첨 확률이 관리자 설정과 일치하는지 검증한다.
 *
 *   yarn verify:odds            기본 300판
 *   yarn verify:odds 1000       판 수 지정
 *
 * 이 게임은 확률을 물리 엔진으로 조작하지 않는다. 설정 확률을 구슬 개수로 환산하고
 * (예: 꽝 63% -> 꽝 구슬 63개), 어떤 구슬이 어느 출발 칸에 놓일지는 셔플로 정한다.
 *
 * 그래서 출발 칸마다 유불리가 있어도(아래 '칸별 승률'에 그대로 드러난다) 상품별 당첨
 * 확률은 정확히 개수 비율이 된다. 라벨을 칸에 배정하는 순열이 균등하고 물리와 독립이기
 * 때문이다. 이 스크립트는 그 성질을 실제 물리로 돌려서 확인한다.
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
import { Box2dPhysics } from '../src/physics-box2d';
import { DEFAULT_CONFIG } from '../src/toonland/api';
import { apportion, buildField } from '../src/toonland/prizeTable';
import type { GameConfig } from '../src/toonland/types';

const STEP_MS = 10;
const MAX_SIM_SEC = 600;

class NodePhysics extends Box2dPhysics {
  async init(): Promise<void> {
    const wasmBinary = fs.readFileSync(new URL('../node_modules/box2d-wasm/dist/umd/Box2D.simd.wasm', import.meta.url));
    const self = this as any;
    self.Box2D = await Box2DFactory({ wasmBinary } as any);
    self.gravity = new self.Box2D.b2Vec2(0, 10);
    self.world = new self.Box2D.b2World(self.gravity);
  }
}

/** src/utils/utils.ts 의 shuffle 과 같은 알고리즘 (엔진이 출발 칸을 정하는 방식) */
function shuffle<T>(input: T[]): T[] {
  const array = input.slice();
  for (let i = array.length; i > 0; ) {
    const j = Math.floor(Math.random() * i);
    i--;
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/** 한 판을 굴려서 1등으로 골인한 출발 칸 번호를 돌려준다 */
async function raceOnce(mapIdx: number, n: number): Promise<number | null> {
  const stage = stages[mapIdx];
  const p = new NodePhysics();
  await p.init();
  p.createStage(stage);

  // Marble 생성자와 같은 배치
  const maxLine = Math.ceil(n / 10);
  const lineDelta = -Math.max(0, Math.ceil(maxLine - 5));
  for (let order = 0; order < n; order++) {
    const line = Math.floor(order / 10);
    p.createMarble(order, 10.25 + (order % 10) * 0.6, maxLine - line + lineDelta);
  }
  p.start();

  const stepSec = STEP_MS / 1000;
  for (let t = 0; t < MAX_SIM_SEC; t += stepSec) {
    p.step(stepSec);
    for (let id = 0; id < n; id++) {
      if (p.getMarblePosition(id).y > stage.goalY) return id;
    }
  }
  return null;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

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

async function main() {
  const rounds = Number(process.argv[2] ?? 300);
  const config = DEFAULT_CONFIG;

  const apportionOk = checkApportion();

  console.log(`## 실제 물리 레이스 ${rounds}판\n`);
  const field = buildField(config);
  const n = field.length;

  const winsByLabel = new Map<string, number>();
  const winsBySlot = new Array<number>(n).fill(0);
  let unfinished = 0;

  const startedAt = Date.now();
  for (let r = 0; r < rounds; r++) {
    // 1) 서버: 상품을 번호에 배정한다 (LocalGameApi.startRound 과 같은 방식)
    const prizeByNumber = shuffle(field.map((slot) => slot.prize));

    // 2) 클라이언트/엔진: 번호를 출발 칸에 배정한다 (setMarbles 과 같은 방식)
    const slots = shuffle([...Array(n).keys()]);
    const numberOfSlot = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      numberOfSlot[slots[i]] = i + 1;
    }

    const winnerSlot = await raceOnce(config.mapIndex, n);
    if (winnerSlot === null) {
      unfinished++;
      continue;
    }
    winsBySlot[winnerSlot]++;
    const picked = prizeByNumber[numberOfSlot[winnerSlot] - 1];
    const label = picked ? picked.name : config.loseLabel;
    winsByLabel.set(label, (winsByLabel.get(label) ?? 0) + 1);

    if ((r + 1) % 25 === 0) {
      process.stderr.write(`  ${r + 1}/${rounds}판 (${((Date.now() - startedAt) / 1000).toFixed(0)}초)\n`);
    }
  }

  const played = rounds - unfinished;
  const expected = new Map(apportion(config).map(({ prize, count }) => [prize ? prize.name : config.loseLabel, count / n]));

  console.log('| 항목 | 설정 확률 | 실측 | 당첨 수 | 표준편차 대비 |');
  console.log('|---|---:|---:|---:|---:|');
  let worstSigma = 0;
  for (const [label, p] of expected) {
    const wins = winsByLabel.get(label) ?? 0;
    const observed = played > 0 ? wins / played : 0;
    // 이항분포 표준편차로 정규화한 편차. |z| 가 3 을 넘으면 설정과 다르다고 의심할 만하다
    const sd = Math.sqrt((p * (1 - p)) / Math.max(1, played));
    const z = sd > 0 ? (observed - p) / sd : 0;
    worstSigma = Math.max(worstSigma, Math.abs(z));
    console.log(`| ${label} | ${pct(p)} | ${pct(observed)} | ${wins} | ${z >= 0 ? '+' : ''}${z.toFixed(2)}σ |`);
  }

  // 칸별 승률은 균등하지 않아도 된다. 위 표가 맞으면 배정 셔플이 그 편향을 지워준다는 뜻이다
  const slotMax = Math.max(...winsBySlot);
  const slotMin = Math.min(...winsBySlot);
  console.log(`\n출발 칸별 승리 수: 최소 ${slotMin}, 최대 ${slotMax} (칸이 유리해도 상품 확률에는 영향이 없다)`);
  console.log(`완주 실패: ${unfinished}판`);
  console.log(`\n환산 검증: ${apportionOk ? '통과' : '실패'}`);
  console.log(`실측 최대 편차: ${worstSigma.toFixed(2)}σ ${worstSigma < 3.5 ? '(정상 범위)' : '(확인 필요)'}`);

  if (!apportionOk) process.exitCode = 1;
}

main();
