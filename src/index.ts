import { Roulette } from './roulette';
import { LocalGameApi } from './toonland/api';
import { RaceGame } from './toonland/game';

const roulette = new Roulette();

/**
 * 게임 API 구현만 갈아끼우면 투네이션 서버에 붙는다. 기본값은 브라우저 저장소로
 * 도는 단독 실행용 구현이다. 연동 방법은 INTEGRATION.md 참고.
 */
const api = new LocalGameApi();

async function boot() {
  const game = new RaceGame(roulette, api);
  await game.init();
}

function whenEngineReady(run: () => void) {
  if (roulette.isReady) {
    run();
    return;
  }
  window.setTimeout(() => whenEngineReady(run), 50);
}

document.addEventListener('DOMContentLoaded', () => {
  whenEngineReady(() => {
    boot().catch((e) => {
      console.error('[강냉이 레이스] 초기화 실패', e);
    });
  });
});
