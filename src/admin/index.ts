import { stages } from '../data/maps';
import type { GameApi } from '../toonland/api';
import { createGameApi } from '../toonland/apiFactory';
import { mapLabel } from '../toonland/mapLabels';
import { effectiveOdds, expectedCornPerRound, totalPrizeProbability, validateConfig } from '../toonland/prizeTable';
import type { ConfigRevision, GameConfig, Prize, PrizeKind } from '../toonland/types';

const KIND_LABELS: Record<PrizeKind, string> = {
  corn: '강냉이',
  inventory: '인벤토리',
  cash: '캐시',
};

const PAYOUT_HINTS: Record<PrizeKind, string> = {
  corn: '지급할 강냉이 수량을 입력하세요.',
  inventory: '인벤토리 아이템 idx를 입력하세요.',
  cash: '지급할 캐시 금액을 입력하세요.',
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`요소를 찾을 수 없습니다: #${id}`);
  return node as T;
}

function num(v: number): string {
  return v.toLocaleString('ko-KR');
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function datetimeLocalToISO(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class AdminApp {
  /** 편집 중인 사본. 저장을 눌러야 api 로 넘어간다 */
  private draft!: GameConfig;
  private saved!: GameConfig;

  constructor(private readonly api: GameApi) {}

  async init(): Promise<void> {
    this.saved = await this.api.loadConfig();
    this.draft = structuredClone(this.saved);

    this.bindTabs();
    this.bindPrizeForm();
    this.bindOddsForm();

    this.renderMapOptions();
    this.renderPrizes();
    this.renderOdds();
    await this.renderPending();
    await this.renderRevisions();
    await this.renderStats();
  }

  private bindTabs(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-tab]').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const target = btn.dataset.tab;
        document.querySelectorAll<HTMLElement>('[data-page]').forEach((page) => {
          page.hidden = page.dataset.page !== target;
        });
      });
    });
  }

  /* ---------- 상품 목록 ---------- */

  private renderPrizes(): void {
    const body = el<HTMLTableSectionElement>('prizeRows');
    body.replaceChildren(
      ...this.draft.prizes.map((prize, i) => {
        const tr = document.createElement('tr');
        if (!prize.visible) tr.className = 'is-hidden-row';
        tr.append(
          cell(String(this.draft.prizes.length - i)),
          cell(prize.name, 'ad-strong'),
          cell(KIND_LABELS[prize.kind]),
          cell(num(prize.payout)),
          cell(num(prize.cornValue)),
          cell(`${prize.probability}%`),
          cell(prize.winnerLimit === 0 ? '무제한' : num(prize.winnerLimit)),
          cell(num(prize.awarded))
        );

        const visibility = document.createElement('td');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = `ad-tag ${prize.visible ? 'ad-tag--on' : 'ad-tag--off'}`;
        toggle.textContent = prize.visible ? '노출' : '숨김';
        toggle.addEventListener('click', () => {
          prize.visible = !prize.visible;
          this.renderPrizes();
          this.renderOdds();
          this.toast(
            `'${prize.name}'을(를) ${prize.visible ? '노출' : '숨김'}으로 바꿨습니다. 확률 설정에서 "설정 저장"을 눌러야 반영됩니다.`
          );
        });
        visibility.append(toggle);

        const actions = document.createElement('td');
        actions.className = 'ad-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ad-btn ad-btn--sm';
        edit.textContent = '수정';
        edit.addEventListener('click', () => this.openPrizeForm(prize));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ad-btn ad-btn--sm ad-btn--danger';
        remove.textContent = '삭제';
        remove.addEventListener('click', () => {
          if (!window.confirm(`'${prize.name}' 상품을 삭제할까요?`)) return;
          this.draft.prizes = this.draft.prizes.filter((p) => p.id !== prize.id);
          this.renderPrizes();
          this.renderOdds();
        });
        actions.append(edit, remove);

        tr.append(visibility, actions);
        return tr;
      })
    );
    el('prizeEmpty').hidden = this.draft.prizes.length > 0;
  }

  private bindPrizeForm(): void {
    el('btnNewPrize').addEventListener('click', () => this.openPrizeForm(null));
    el('btnCancelPrize').addEventListener('click', () => {
      el('prizeForm').hidden = true;
    });

    el<HTMLSelectElement>('prizeKind').addEventListener('change', (e) => {
      const kind = (e.target as HTMLSelectElement).value as PrizeKind;
      el('payoutHint').textContent = PAYOUT_HINTS[kind];
    });

    el<HTMLFormElement>('prizeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitPrize();
    });
  }

  private openPrizeForm(prize: Prize | null): void {
    el('prizeFormTitle').textContent = prize ? '상품 수정' : '상품 생성';
    el<HTMLInputElement>('prizeId').value = prize?.id ?? '';
    el<HTMLInputElement>('prizeName').value = prize?.name ?? '';
    el<HTMLSelectElement>('prizeKind').value = prize?.kind ?? 'corn';
    el<HTMLInputElement>('prizePayout').value = String(prize?.payout ?? 1000);
    el<HTMLInputElement>('prizeCornValue').value = String(prize?.cornValue ?? 1000);
    el<HTMLInputElement>('prizeProbability').value = String(prize?.probability ?? 1);
    el<HTMLInputElement>('prizeWinnerLimit').value = String(prize?.winnerLimit ?? 0);
    el('payoutHint').textContent = PAYOUT_HINTS[(prize?.kind ?? 'corn') as PrizeKind];
    el('prizeForm').hidden = false;
    el('prizeForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private submitPrize(): void {
    const id = el<HTMLInputElement>('prizeId').value;
    const next: Prize = {
      id: id || `p${Date.now().toString(36)}`,
      name: el<HTMLInputElement>('prizeName').value.trim(),
      kind: el<HTMLSelectElement>('prizeKind').value as PrizeKind,
      payout: Number(el<HTMLInputElement>('prizePayout').value),
      cornValue: Number(el<HTMLInputElement>('prizeCornValue').value),
      probability: Number(el<HTMLInputElement>('prizeProbability').value),
      winnerLimit: Number(el<HTMLInputElement>('prizeWinnerLimit').value),
      awarded: this.draft.prizes.find((p) => p.id === id)?.awarded ?? 0,
      visible: this.draft.prizes.find((p) => p.id === id)?.visible ?? true,
    };

    if (id) {
      this.draft.prizes = this.draft.prizes.map((p) => (p.id === id ? next : p));
    } else {
      this.draft.prizes = [next, ...this.draft.prizes];
    }

    el('prizeForm').hidden = true;
    this.renderPrizes();
    this.renderOdds();
    this.toast('상품을 저장했습니다. 확률 설정에서 "설정 저장"을 눌러야 게임에 반영됩니다.');
  }

  /* ---------- 확률 설정 ---------- */

  private renderMapOptions(): void {
    const select = el<HTMLSelectElement>('cfgMap');
    select.replaceChildren(
      ...stages.map((stage, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = mapLabel(stage.title);
        return option;
      })
    );
    select.value = String(this.draft.mapIndex);
  }

  private bindOddsForm(): void {
    el<HTMLInputElement>('cfgEntryFee').addEventListener('input', () => this.syncOddsInputs());
    el<HTMLInputElement>('cfgConsolation').addEventListener('input', () => this.syncOddsInputs());
    el<HTMLInputElement>('cfgFieldSize').addEventListener('input', () => this.syncOddsInputs());
    el<HTMLSelectElement>('cfgMap').addEventListener('change', () => this.syncOddsInputs());

    document.querySelectorAll<HTMLInputElement>('input[name="applyMode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        el<HTMLInputElement>('cfgScheduleAt').disabled =
          (document.querySelector('input[name="applyMode"]:checked') as HTMLInputElement)?.value !== 'schedule';
      });
    });

    el('btnResetOdds').addEventListener('click', () => {
      this.draft = structuredClone(this.saved);
      this.renderPrizes();
      this.renderOdds();
      this.toast('저장된 설정으로 되돌렸습니다.');
    });

    el<HTMLFormElement>('oddsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.saveConfig();
    });
  }

  /** 입력창 값을 draft 에 반영하고 표를 다시 그린다 */
  private syncOddsInputs(): void {
    this.draft.entryFee = Number(el<HTMLInputElement>('cfgEntryFee').value) || 0;
    this.draft.consolationCorn = Number(el<HTMLInputElement>('cfgConsolation').value) || 0;
    this.draft.fieldSize = Number(el<HTMLInputElement>('cfgFieldSize').value) || 0;
    this.draft.mapIndex = Number(el<HTMLSelectElement>('cfgMap').value) || 0;
    this.renderOddsTable();
  }

  private renderOdds(): void {
    el<HTMLInputElement>('cfgEntryFee').value = String(this.draft.entryFee);
    el<HTMLInputElement>('cfgConsolation').value = String(this.draft.consolationCorn);
    el<HTMLInputElement>('cfgFieldSize').value = String(this.draft.fieldSize);
    el<HTMLSelectElement>('cfgMap').value = String(this.draft.mapIndex);
    this.renderOddsTable();
  }

  private renderOddsTable(): void {
    const body = el<HTMLTableSectionElement>('oddsRows');
    const odds = new Map(effectiveOdds(this.draft).map((row) => [row.label, row]));

    const rows = this.draft.prizes.map((prize) => {
      const tr = document.createElement('tr');
      if (!prize.visible) tr.className = 'is-hidden-row';
      tr.append(cell(prize.visible ? prize.name : `${prize.name} (숨김)`, 'ad-strong'));

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '100';
      input.step = '0.01';
      input.value = String(prize.probability);
      input.className = 'ad-inline-input';
      input.addEventListener('input', () => {
        prize.probability = Number(input.value) || 0;
        this.renderOddsTable();
      });
      const probCell = document.createElement('td');
      probCell.append(input);
      tr.append(probCell);

      const row = odds.get(prize.name);
      tr.append(cell(row ? `${row.actual.toFixed(2)}%` : '-'), cell(row ? num(row.count) : '-'));
      return tr;
    });

    // 꽝은 나머지 확률이므로 입력받지 않고 계산해서 보여준다
    const loseRow = effectiveOdds(this.draft).find((r) => r.label === this.draft.loseLabel);
    const loseTr = document.createElement('tr');
    loseTr.className = 'ad-row-lose';
    loseTr.append(
      cell(`${this.draft.loseLabel} (나머지)`, 'ad-strong'),
      cell(`${Math.max(0, 100 - totalPrizeProbability(this.draft.prizes.filter((p) => p.visible))).toFixed(2)}%`),
      cell(loseRow ? `${loseRow.actual.toFixed(2)}%` : '-'),
      cell(loseRow ? num(loseRow.count) : '-')
    );
    rows.push(loseTr);

    body.replaceChildren(...rows);
    this.renderSummary();
  }

  private renderSummary(): void {
    const visible = this.draft.prizes.filter((p) => p.visible);
    const sum = totalPrizeProbability(visible);
    const expected = expectedCornPerRound(this.draft);

    el('oddsSummary').innerHTML = `
      <span>상품 확률 합계 <b>${sum.toFixed(2)}%</b></span>
      <span>꽝 확률 <b>${Math.max(0, 100 - sum).toFixed(2)}%</b></span>
      <span>한 판 기대 수지 <b class="${expected > 0 ? 'ad-neg' : 'ad-pos'}">${expected > 0 ? '+' : ''}${Math.round(expected).toLocaleString('ko-KR')} 강냉이</b>
        <em class="ad-hint">${expected > 0 ? '판마다 강냉이가 늘어납니다' : '판마다 강냉이가 소진됩니다'}</em></span>`;

    const issues = validateConfig(this.draft);
    const box = el('oddsIssues');
    box.replaceChildren(
      ...issues.map((issue) => {
        const p = document.createElement('p');
        p.className = `ad-issue ad-issue--${issue.level}`;
        p.textContent = `${issue.level === 'error' ? '오류' : '주의'} · ${issue.message}`;
        return p;
      })
    );
  }

  private async saveConfig(): Promise<void> {
    this.syncOddsInputs();
    const issues = validateConfig(this.draft);
    if (issues.some((i) => i.level === 'error')) {
      this.toast('오류를 먼저 해결해 주세요.');
      return;
    }

    const mode = (document.querySelector('input[name="applyMode"]:checked') as HTMLInputElement)?.value;
    let scheduledFor: string | null = null;
    if (mode === 'schedule') {
      scheduledFor = datetimeLocalToISO(el<HTMLInputElement>('cfgScheduleAt').value);
      if (!scheduledFor) {
        this.toast('예약 일시를 입력해 주세요.');
        return;
      }
      if (new Date(scheduledFor).getTime() <= Date.now()) {
        this.toast('예약 일시는 현재 시각보다 뒤여야 합니다.');
        return;
      }
    }

    const revision: ConfigRevision = {
      at: new Date().toISOString(),
      scheduledFor,
      entryFee: this.draft.entryFee,
      consolationCorn: this.draft.consolationCorn,
      fieldSize: this.draft.fieldSize,
      odds: effectiveOdds(this.draft).map((row) => ({ label: row.label, probability: row.actual })),
      memo: el<HTMLInputElement>('cfgMemo').value.trim(),
    };

    this.saved = await this.api.saveConfig(this.draft, revision);
    this.draft = structuredClone(this.saved);
    el<HTMLInputElement>('cfgMemo').value = '';

    await this.renderPending();
    await this.renderRevisions();
    this.toast(scheduledFor ? '예약 설정을 등록했습니다.' : '설정을 저장했습니다. 다음 판부터 반영됩니다.');
  }

  private async renderPending(): Promise<void> {
    const pending = await this.api.pendingConfig();
    const banner = el('pendingBanner');
    if (!pending) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.textContent = `예약된 설정이 ${new Date(pending.applyAt).toLocaleString('ko-KR')}에 적용됩니다.`;
  }

  /* ---------- 이력 / 통계 ---------- */

  private async renderRevisions(): Promise<void> {
    const revisions = await this.api.listRevisions();
    const body = el<HTMLTableSectionElement>('revisionRows');
    body.replaceChildren(
      ...revisions.map((rev) => {
        const tr = document.createElement('tr');
        tr.append(
          cell(new Date(rev.at).toLocaleString('ko-KR')),
          cell(rev.scheduledFor ? `예약 ${new Date(rev.scheduledFor).toLocaleString('ko-KR')}` : '즉시'),
          cell(num(rev.entryFee)),
          cell(num(rev.consolationCorn)),
          cell(num(rev.fieldSize)),
          cell(rev.odds.map((o) => `${o.label} ${o.probability.toFixed(2)}%`).join(' · '), 'ad-wrap'),
          cell(rev.memo || '-')
        );
        return tr;
      })
    );
    el('revisionEmpty').hidden = revisions.length > 0;
  }

  private async renderStats(): Promise<void> {
    const daily = await this.api.dailyStats();
    el<HTMLTableSectionElement>('dailyRows').replaceChildren(
      ...daily.map((row) => {
        const tr = document.createElement('tr');
        tr.append(
          cell(row.date),
          cell(num(row.rounds)),
          cell(num(row.wins)),
          cell(num(row.losses)),
          cell(num(row.cornSpent))
        );
        return tr;
      })
    );
    el('dailyEmpty').hidden = daily.length > 0;

    const prizeStats = await this.api.prizeStats();
    el<HTMLTableSectionElement>('prizeStatRows').replaceChildren(
      ...prizeStats.map((row, i) => {
        const tr = document.createElement('tr');
        tr.append(cell(String(i + 1)), cell(row.label, 'ad-strong'), cell(num(row.wins)));
        return tr;
      })
    );
    el('prizeStatEmpty').hidden = prizeStats.length > 0;
  }

  private toast(message: string): void {
    const node = el('adToast');
    node.textContent = message;
    node.hidden = false;
    window.setTimeout(() => {
      node.hidden = true;
    }, 2600);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const { api, mode } = createGameApi();
  if (mode === 'demo') {
    const banner = el('demoBanner');
    banner.hidden = false;
    banner.textContent = '시연 모드입니다. 설정이 이 브라우저에만 저장되고 서버에 반영되지 않습니다.';
  }
  new AdminApp(api).init().catch((e) => {
    console.error('[관리자] 초기화 실패', e);
  });
});
