/**
 * 시드로 1등 칸을 미리 계산한다.
 *
 *   yarn seeds 100 500            구슬 100개짜리 시드 500개를 뽑아 CSV 로 출력
 *   yarn seeds 100 500 0          맵 0번 지정 (기본 0)
 *
 * 서버는 이 표를 미리 채워두고 라운드를 열 때 한 줄을 골라 쓴다. 그러면 백엔드가
 * 물리 엔진을 돌릴 필요 없이 1등 칸을 알 수 있어서, 어떤 스택이든 붙일 수 있다.
 * 자세한 쓰임새는 server/SERVER_SPEC.md 참고.
 *
 * 여기 있는 루프는 Roulette._update 의 물리 부분을 그대로 옮긴 것이다. 화면 쪽
 * (카메라·파티클·렌더링)은 물리에 영향을 주지 않으므로 뺐다. 첫 골인까지만 돌리므로
 * 골인 처리·구슬 제거 분기도 필요 없다.
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { Skills, zoomThreshold } from '../src/data/constants';
import { type StageDef, stages } from '../src/data/maps';
import { Marble } from '../src/marble';
import { Box2dPhysics } from '../src/physics-box2d';
import { deriveSeed } from '../src/utils/rng';

const STEP_MS = 10;
const MAX_STEPS = 60_000; // 600초

class NodePhysics extends Box2dPhysics {
  async init(): Promise<void> {
    const wasmBinary = fs.readFileSync(new URL('../node_modules/box2d-wasm/dist/umd/Box2D.simd.wasm', import.meta.url));
    const self = this as any;
    self.Box2D = await Box2DFactory({ wasmBinary } as any);
    self.gravity = new self.Box2D.b2Vec2(0, 10);
    self.world = new self.Box2D.b2World(self.gravity);
  }
}

/** Roulette._calcTimeScale 과 같다. 1등이 나오기 전까지는 winners 가 항상 비어 있다 */
function calcTimeScale(marbles: Marble[], stage: StageDef, goalDist: number): number {
  if (goalDist < zoomThreshold && marbles[0] && marbles[1]) {
    if (marbles[0].y > stage.zoomY - zoomThreshold * 1.2) {
      return Math.max(0.2, goalDist / zoomThreshold);
    }
  }
  return 1;
}

/** 같은 (시드, 구슬 수, 맵) 이면 항상 같은 값을 돌려준다. 1등 칸 번호, 못 끝내면 -1 */
export function predictWinner(physics: Box2dPhysics, seed: number, count: number, mapIndex: number): number {
  const stage = stages[mapIndex];
  physics.resetWorld();
  physics.createStage(stage);

  let marbles: Marble[] = [];
  for (let order = 0; order < count; order++) {
    marbles.push(new Marble(physics, order, count, `m${order}`, 1, deriveSeed(seed, order)));
  }
  for (const m of marbles) m.isActive = true;
  physics.start();

  let timeScale = 1;
  let goalDist = Number.POSITIVE_INFINITY;

  for (let step = 0; step < MAX_STEPS; step++) {
    physics.step((STEP_MS / 1000) * timeScale);
    if (marbles.length > 1) marbles.sort((a, b) => b.y - a.y);

    for (const marble of marbles) {
      marble.update(STEP_MS, timeScale);
      if (marble.skill === Skills.Impact) physics.impact(marble.id);
      if (marble.y > stage.goalY) return marble.id;
    }

    goalDist = Math.abs(stage.zoomY - (marbles[0]?.y ?? 0));
    timeScale = calcTimeScale(marbles, stage, goalDist);
    marbles = marbles.filter((m) => m.y <= stage.goalY);
  }
  return -1;
}

async function main() {
  const count = Number(process.argv[2] ?? 100);
  const rows = Number(process.argv[3] ?? 500);
  const mapIndex = Number(process.argv[4] ?? 0);

  const physics = new NodePhysics();
  await physics.init();

  console.log('map_index,field_size,seed,winner_slot');
  let failed = 0;
  for (let i = 0; i < rows; i++) {
    // 시드는 32비트 부호 없는 정수. 서버가 이 값을 그대로 클라이언트에 내려준다
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const slot = predictWinner(physics, seed, count, mapIndex);
    if (slot < 0) {
      failed++;
      continue;
    }
    console.log(`${mapIndex},${count},${seed},${slot}`);
    if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${rows}\n`);
  }
  if (failed > 0) process.stderr.write(`완주 실패로 버린 시드: ${failed}개\n`);
}

if (process.argv[1]?.endsWith('seed-pool.ts')) main();
