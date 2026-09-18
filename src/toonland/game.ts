import options from '../options';
import type { Roulette } from '../roulette';
import { type GameApi, InsufficientCornError, type Settled } from './api';
import { mapLabel } from './mapLabels';
import { apportion, availablePrizes, effectiveOdds, totalPrizeProbability } from './prizeTable';
import type { Donator, GameConfig, HistoryEntry, Prize } from './types';

const KIND_LABELS: Record<Prize['kind'], string> = {
  corn: '강냉이',
  inventory: '인벤토리',
  cash: '캐시',
};

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`화면 요소를 찾을 수 없습니다: #${id}`);
  return found as T;
}

function num(v: number): string {
  return v.toLocaleString('ko-KR');
}

export class RaceGame {
  private config!: GameConfig;
  private donator!: Donator;
  private roundId: string | null = null;
  private running = false;

  constructor(
    private readonly roulette: Roulette,
    private readonly api: GameApi,
    /** 캐시 충전 페이지. 서버 모드에서 강냉이가 부족할 때 여기로 보낸다 */
    private readonly chargeUrl?: string
  ) {}

  async init(): Promise<void> {
    this.config = await this.api.loadConfig();
    this.donator = await this.api.getDonator();

    this.renderMaps();
    this.renderHeader();
    this.renderPrizes();
    await this.renderHistory();
    this.bindEvents();

    const canTopUpHere = 'topUp' in (this.api as object);
    el('btnCharge').textContent = canTopUpHere ? '강냉이 받기' : '캐시 충전하러 가기';

    this.roulette.setAutoRecording(false);
    this.roulette.setTheme('dark');
    this.roulette.setMap(this.config.mapIndex);
    this.renderChips();
  }

  private bindEvents(): void {
    el('btnPlay').addEventListener('click', () => this.play());
    el('btnPlayAgain').addEventListener('click', () => {
      this.closeModal('resultModal');
      this.play();
    });
    el('btnTopUp').addEventListener('click', () => this.openCharge('topup'));
    el('btnCharge').addEventListener('click', () => this.topUp());

    el<HTMLSelectElement>('sltMap').addEventListener('change', (e) => {
      const index = Number((e.target as HTMLSelectElement).value);
      this.config.mapIndex = index;
      this.roulette.setMap(index);
      this.renderChips();
    });

    el<HTMLInputElement>('chkSkill').addEventListener('change', (e) => {
      options.useSkills = (e.target as HTMLInputElement).checked;
    });

    document.querySelectorAll('[data-close-modal]').forEach((node) => {
      node.addEventListener('click', () => {
        this.closeModal('resultModal');
        this.closeModal('chargeModal');
      });
    });

    this.roulette.addEventListener('goal', (e) => {
      void this.onGoal((e as CustomEvent).detail?.winner as string | undefined);
    });
  }

  private renderMaps(): void {
    const select = el<HTMLSelectElement>('sltMap');
    select.replaceChildren(
      ...this.roulette.getMaps().map((map) => {
        const option = document.createElement('option');
        option.value = String(map.index);
        option.textContent = mapLabel(map.title);
        return option;
      })
    );
    select.value = String(this.config.mapIndex);
  }

  private renderHeader(): void {
    el('meName').textContent = this.donator.nickname;
    el('meGrade').textContent = gradeOf(this.donator.corn);
    el('meCorn').textContent = num(this.donator.corn);
    el('meCash').textContent = num(this.donator.cash);
    el('entryFee').textContent = num(this.config.entryFee);
  }

  private renderPrizes(): void {
    const prizes = availablePrizes(this.config);
    const list = el('prizeList');

    if (prizes.length === 0) {
      list.replaceChildren(
        Object.assign(document.createElement('li'), {
          className: 'tl-empty',
          textContent: '등록된 상품이 없습니다.',
        })
      );
    } else {
      const odds = new Map(effectiveOdds(this.config).map((row) => [row.label, row.actual]));
      list.replaceChildren(
        ...prizes.map((prize) => {
          const li = document.createElement('li');
          li.className = 'tl-prize';
          li.innerHTML = `
            <span class="tl-prize__kind tl-prize__kind--${prize.kind}">${KIND_LABELS[prize.kind]}</span>
            <span class="tl-prize__name"></span>
            <span class="tl-prize__odds"></span>`;
          li.querySelector('.tl-prize__name')!.textContent = prize.name;
          li.querySelector('.tl-prize__odds')!.textContent =
            `${(odds.get(prize.name) ?? prize.probability).toFixed(2)}%`;
          return li;
        })
      );
    }

    const loseChance = Math.max(0, 100 - totalPrizeProbability(prizes));
    el('loseNote').textContent =
      this.config.consolationCorn > 0
        ? `꽝 ${loseChance.toFixed(2)}% · 꽝이어도 기본 혜택 ${num(this.config.consolationCorn)} 강냉이를 드려요.`
        : `꽝 ${loseChance.toFixed(2)}%`;
  }

  /** 공개된 확률 테이블만으로 구슬 수와 당첨 확률 칩을 채운다 */
  private renderChips(): void {
    const rows = apportion(this.config);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const winners = rows.reduce((sum, row) => sum + (row.prize ? row.count : 0), 0);
    el('fieldChip').textContent = `구슬 ${num(total)}개`;
    el('winChip').textContent = `당첨 확률 ${((winners / Math.max(1, total)) * 100).toFixed(2)}%`;
  }

  private async play(): Promise<void> {
    if (this.running) return;

    let started: Awaited<ReturnType<GameApi['startRound']>>;
    try {
      started = await this.api.startRound();
    } catch (e) {
      if (e instanceof InsufficientCornError) {
        this.openCharge('insufficient');
        return;
      }
      this.toast(e instanceof Error ? e.message : '게임을 시작할 수 없습니다.');
      return;
    }

    this.running = true;
    this.roundId = started.roundId;
    this.config = started.config;
    this.donator = started.donator;
    this.renderHeader();
    this.renderPrizes();

    this.renderChips();

    el('stageIdle').hidden = true;
    this.setPlayButton(true);

    // 구슬에는 번호만 적는다. 어떤 번호가 무슨 상품인지는 서버만 알고,
    // 결과는 골인한 번호를 서버에 물어봐서 받는다
    const numbers = Array.from({ length: started.fieldSize }, (_, i) => String(i + 1));
    this.roulette.setMarbles(numbers);
    this.roulette.setWinnerRange(0, 0);
    this.roulette.start();
  }

  private async onGoal(winnerLabel: string | undefined): Promise<void> {
    if (!this.running || !this.roundId) return;
    this.running = false;
    this.setPlayButton(false);

    const pickedNumber = Number(winnerLabel);
    if (!Number.isInteger(pickedNumber)) {
      this.toast('골인한 구슬 번호를 읽지 못했습니다.');
      return;
    }

    let settled: Settled;
    try {
      settled = await this.api.settleRound(this.roundId, pickedNumber);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : '결과를 저장하지 못했습니다.');
      return;
    }
    this.roundId = null;

    this.donator = settled.donator;
    this.config = await this.api.loadConfig();
    this.renderHeader();
    this.renderPrizes();
    await this.renderHistory();
    this.showResult(settled);
  }

  private showResult({ outcome }: Settled): void {
    const won = !!outcome.prize;
    el('resultEmoji').textContent = won ? '🎉' : '😢';
    el('resultTitle').textContent = won ? '당첨을 축하드려요!' : '아쉽네요, 꽝이에요';
    el('resultNumber').textContent = `${num(outcome.pickedNumber)}번 구슬 1등`;
    el('resultPrize').textContent = outcome.prize ? outcome.prize.name : this.config.loseLabel;

    if (won && outcome.prize) {
      const p = outcome.prize;
      const gained =
        p.kind === 'corn'
          ? `+${num(p.payout)} 강냉이`
          : p.kind === 'cash'
            ? `+${num(p.payout)} 캐시`
            : '인벤토리에서 확인하세요';
      el('resultSub').textContent = `${gained} · 게임참여내역에서 확인할 수 있어요.`;
    } else {
      el('resultSub').textContent =
        outcome.cornDelta > 0
          ? `기본 혜택으로 ${num(outcome.cornDelta)} 강냉이를 드렸어요. 다음 판을 노려보세요!`
          : '다음 판을 노려보세요!';
    }

    el('resultModal').hidden = false;
  }

  private async renderHistory(): Promise<void> {
    const entries = await this.api.listHistory(20);
    const box = el('historyList');

    if (entries.length === 0) {
      box.replaceChildren(
        Object.assign(document.createElement('p'), {
          className: 'tl-empty',
          textContent: '참여한 게임이 없습니다.',
        })
      );
      return;
    }

    box.replaceChildren(...entries.map((entry) => this.historyRow(entry)));
  }

  private historyRow(entry: HistoryEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = `tl-history__row ${entry.result === '당첨' ? 'is-win' : ''}`;
    row.innerHTML = `
      <span class="tl-history__at"></span>
      <span class="tl-history__reward"></span>
      <span class="tl-history__spent"></span>
      <span class="tl-history__result"></span>`;
    row.querySelector('.tl-history__at')!.textContent = new Date(entry.at).toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    row.querySelector('.tl-history__reward')!.textContent = entry.reward;
    row.querySelector('.tl-history__spent')!.textContent = `${num(entry.spent)} 강냉이`;
    row.querySelector('.tl-history__result')!.textContent = entry.result;
    return row;
  }

  private setPlayButton(running: boolean): void {
    const btn = el<HTMLButtonElement>('btnPlay');
    btn.disabled = running;
    el('btnPlayText').textContent = running ? '레이스 진행 중…' : '도전하기';

    // 레이스 중 맵을 바꾸면 구슬이 리셋되어 골인 이벤트가 오지 않는다.
    // 참가비는 이미 빠진 뒤라 라운드가 그대로 멈춰버리므로 막는다
    el<HTMLSelectElement>('sltMap').disabled = running;
    el<HTMLInputElement>('chkSkill').disabled = running;
  }

  /**
   * 충전 모달은 두 곳에서 열린다. 헤더의 충전하기 버튼(그냥 충전하려는 경우)과
   * 참가비가 모자라 라운드를 못 연 경우. 잔액이 넉넉한데 '부족해요'가 뜨면 이상하므로
   * 제목과 문구를 나눠 쓴다
   */
  private openCharge(reason: 'topup' | 'insufficient'): void {
    const short = reason === 'insufficient';
    el('chargeTitle').textContent = short ? '강냉이가 부족해요' : '강냉이 충전';
    el('chargeSub').textContent = short
      ? `1회 참가비는 ${num(this.config.entryFee)} 강냉이인데 ${num(this.donator.corn)} 강냉이를 갖고 있어요.`
      : `지금 ${num(this.donator.corn)} 강냉이를 갖고 있어요. 1회 참가비는 ${num(this.config.entryFee)} 강냉이예요.`;
    el('chargeModal').hidden = false;
  }

  /** 시연 모드에서는 바로 채워주고, 실서버에서는 캐시 충전 페이지로 보낸다 */
  private async topUp(): Promise<void> {
    const api = this.api as GameApi & { topUp?: (amount: number) => Promise<Donator> };

    if (api.topUp) {
      this.donator = await api.topUp(this.config.entryFee * 10);
      this.renderHeader();
      this.closeModal('chargeModal');
      this.toast('강냉이를 충전했어요.');
      return;
    }

    if (this.chargeUrl) {
      window.open(this.chargeUrl, '_blank', 'noopener');
      this.closeModal('chargeModal');
      return;
    }

    this.toast('충전은 투네이션 충전 페이지에서 진행해 주세요.');
  }

  private closeModal(id: string): void {
    el(id).hidden = true;
  }

  private toast(message: string): void {
    const node = el('toast');
    node.textContent = message;
    node.hidden = false;
    window.setTimeout(() => {
      node.hidden = true;
    }, 2400);
  }
}

/** 당첨왕 기획서의 보유 강냉이 등급 기준 */
export function gradeOf(corn: number): string {
  if (corn >= 3_000_000) return '전설';
  if (corn >= 1_000_000) return '영웅';
  if (corn >= 800_000) return '지존';
  if (corn >= 300_000) return '고수';
  if (corn >= 100_000) return '중수';
  return '초보';
}
