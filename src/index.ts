import { Roulette } from './roulette';
import { createGameApi } from './toonland/apiFactory';
import { RaceGame } from './toonland/game';

const roulette = new Roulette();

async function boot() {
  // 실서버에 붙을지 시연 모드로 돌지는 HTML 메타 태그가 정한다 (INTEGRATION.md 참고)
  const { api, mode, chargeUrl } = createGameApi();
  const game = new RaceGame(roulette, api, chargeUrl);
  await game.init();

  if (mode === 'demo') {
    const badge = document.getElementById('demoBadge');
    if (badge) badge.hidden = false;
  }
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
