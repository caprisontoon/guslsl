import { shuffle } from '../utils/utils';
import { buildField } from './prizeTable';
import type { ConfigRevision, Donator, GameConfig, HistoryEntry, Prize, RoundOutcome } from './types';

export type StartedRound = {
  roundId: string;
  /** 굴릴 구슬 수. 구슬에는 1..fieldSize 번호만 적힌다 */
  fieldSize: number;
  config: GameConfig;
  donator: Donator;
};

export type Settled = {
  outcome: RoundOutcome;
  donator: Donator;
};

export type DailyStat = {
  date: string;
  rounds: number;
  wins: number;
  losses: number;
  cornSpent: number;
  cornPaid: number;
};
export type PrizeStat = { label: string; wins: number };

/**
 * 게임이 백엔드에 기대하는 것 전부. 투네이션 서버에 붙일 때는 이 인터페이스만 구현하면 되고,
 * 게임/관리자 화면 코드는 그대로 둔다. 기본 구현(LocalGameApi)은 브라우저 저장소를 쓰므로
 * 서버 없이도 전체 흐름을 그대로 돌려볼 수 있다.
 */
export interface GameApi {
  loadConfig(): Promise<GameConfig>;
  saveConfig(config: GameConfig, revision: ConfigRevision): Promise<GameConfig>;
  /** 예약 대기 중인 설정. 없으면 null */
  pendingConfig(): Promise<{ config: GameConfig; applyAt: string } | null>;
  getDonator(): Promise<Donator>;
  /** 참가비를 차감하고 라운드를 연다. 강냉이가 모자라면 예외 */
  startRound(): Promise<StartedRound>;
  /**
   * 1등으로 골인한 구슬 번호를 넘겨 결과를 확정하고 상품을 지급한다.
   * 번호 -> 상품 매핑은 서버만 알고 있으므로, 어떤 번호를 넘겨도 확률은 같다.
   */
  settleRound(roundId: string, pickedNumber: number): Promise<Settled>;
  listHistory(limit?: number): Promise<HistoryEntry[]>;
  listRevisions(): Promise<ConfigRevision[]>;
  dailyStats(): Promise<DailyStat[]>;
  prizeStats(): Promise<PrizeStat[]>;
}

export class InsufficientCornError extends Error {
  constructor(
    public readonly need: number,
    public readonly have: number
  ) {
    super(`강냉이가 부족합니다. 필요: ${need}, 보유: ${have}`);
    this.name = 'InsufficientCornError';
  }
}

const KEYS = {
  config: 'toonland.race.config',
  pending: 'toonland.race.pendingConfig',
  donator: 'toonland.race.donator',
  history: 'toonland.race.history',
  revisions: 'toonland.race.revisions',
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[toonland] 저장 실패', e);
  }
}

export const DEFAULT_CONFIG: GameConfig = {
  entryFee: 1000,
  fieldSize: 100,
  mapIndex: 0,
  loseLabel: '꽝',
  consolationCorn: 50,
  updatedAt: new Date(0).toISOString(),
  prizes: [
    {
      id: 'p1',
      name: '강냉이 10000',
      kind: 'corn',
      payout: 10000,
      cornValue: 10000,
      probability: 1,
      winnerLimit: 0,
      awarded: 0,
      visible: true,
    },
    {
      id: 'p2',
      name: '강냉이 5000',
      kind: 'corn',
      payout: 5000,
      cornValue: 5000,
      probability: 4,
      winnerLimit: 0,
      awarded: 0,
      visible: true,
    },
    {
      id: 'p3',
      name: '강냉이 2000',
      kind: 'corn',
      payout: 2000,
      cornValue: 2000,
      probability: 10,
      winnerLimit: 0,
      awarded: 0,
      visible: true,
    },
    {
      id: 'p4',
      name: '강냉이 1000',
      kind: 'corn',
      payout: 1000,
      cornValue: 1000,
      probability: 20,
      winnerLimit: 0,
      awarded: 0,
      visible: true,
    },
    {
      id: 'p5',
      name: '캐시 100',
      kind: 'cash',
      payout: 100,
      cornValue: 2500,
      probability: 2,
      winnerLimit: 50,
      awarded: 0,
      visible: true,
    },
  ],
};

const DEFAULT_DONATOR: Donator = {
  idx: 213546,
  platform: 'Twitch',
  nickname: '유부개구리',
  account: 'akfbfj98',
  corn: 150000,
  cash: 400,
};

export const GAME_NAME = '강냉이 레이스';

/** 브라우저 저장소로 동작하는 기본 구현. 서버 연동 전 단독 실행/시연용 */
export class LocalGameApi implements GameApi {
  /**
   * 열려 있는 라운드. prizeByNumber 는 클라이언트에 내려주지 않는다.
   * 구슬에는 번호만 적혀 있고 어떤 번호가 무슨 상품인지는 여기만 알기 때문에,
   * 조작해서 다른 번호를 신고해도 기대값이 달라지지 않는다.
   */
  private openRounds = new Map<string, { fee: number; prizeByNumber: (Prize | null)[] }>();

  async loadConfig(): Promise<GameConfig> {
    this.promoteScheduled();
    const stored = read<GameConfig | null>(KEYS.config, null);
    if (!stored) {
      write(KEYS.config, DEFAULT_CONFIG);
      return structuredClone(DEFAULT_CONFIG);
    }
    // 저장된 설정에 새 필드가 없을 수 있으므로 기본값 위에 덮는다
    return { ...structuredClone(DEFAULT_CONFIG), ...stored };
  }

  /** 예약 시각이 지난 설정을 현재 설정으로 올린다 */
  private promoteScheduled(): void {
    const pending = read<{ config: GameConfig; applyAt: string } | null>(KEYS.pending, null);
    if (!pending) return;
    if (new Date(pending.applyAt).getTime() <= Date.now()) {
      write(KEYS.config, pending.config);
      localStorage.removeItem(KEYS.pending);
    }
  }

  async pendingConfig(): Promise<{ config: GameConfig; applyAt: string } | null> {
    this.promoteScheduled();
    return read<{ config: GameConfig; applyAt: string } | null>(KEYS.pending, null);
  }

  async saveConfig(config: GameConfig, revision: ConfigRevision): Promise<GameConfig> {
    const next = { ...config, updatedAt: new Date().toISOString() };
    if (revision.scheduledFor) {
      write(KEYS.pending, { config: next, applyAt: revision.scheduledFor });
    } else {
      write(KEYS.config, next);
      localStorage.removeItem(KEYS.pending);
    }
    write(KEYS.revisions, [revision, ...read<ConfigRevision[]>(KEYS.revisions, [])].slice(0, 200));
    return next;
  }

  async getDonator(): Promise<Donator> {
    return read<Donator>(KEYS.donator, DEFAULT_DONATOR);
  }

  private saveDonator(d: Donator): void {
    write(KEYS.donator, d);
  }

  async startRound(): Promise<StartedRound> {
    const config = await this.loadConfig();
    const donator = await this.getDonator();
    if (donator.corn < config.entryFee) {
      throw new InsufficientCornError(config.entryFee, donator.corn);
    }

    // 확률대로 구성한 상품 목록을 번호에 무작위로 배정한다. 매 판 새로 섞으므로
    // 특정 번호가 계속 좋은 상품을 물고 있는 일은 없다.
    // 참가비 차감보다 먼저 해야 한다. 구슬이 0개인 설정이면 레이스가 끝나지 않아
    // 정산이 영영 안 오는데, 그 전에 강냉이를 빼면 그냥 잃는 셈이 된다
    const prizeByNumber = shuffle(buildField(config).map((slot) => slot.prize));
    if (prizeByNumber.length < 2) {
      throw new Error('게임 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.');
    }

    const next = { ...donator, corn: donator.corn - config.entryFee };
    this.saveDonator(next);

    const roundId = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    this.openRounds.set(roundId, { fee: config.entryFee, prizeByNumber });
    return { roundId, fieldSize: prizeByNumber.length, config, donator: next };
  }

  async settleRound(roundId: string, pickedNumber: number): Promise<Settled> {
    const open = this.openRounds.get(roundId);
    if (!open) throw new Error(`알 수 없는 라운드입니다: ${roundId}`);
    // 라운드 토큰은 1회용이다. 결과가 마음에 들 때까지 다시 신고할 수 없어야 한다
    this.openRounds.delete(roundId);

    if (!Number.isInteger(pickedNumber) || pickedNumber < 1 || pickedNumber > open.prizeByNumber.length) {
      throw new Error(`구슬 번호가 범위를 벗어났습니다: ${pickedNumber}`);
    }

    const config = await this.loadConfig();
    // 상품 객체는 이 라운드 시작 시점의 사본이므로, 지급 수량을 올릴 대상은 현재 설정에서 다시 찾는다
    const drawn = open.prizeByNumber[pickedNumber - 1];
    const prize = drawn ? (config.prizes.find((p) => p.id === drawn.id) ?? null) : null;
    let donator = await this.getDonator();

    let cornDelta = 0;
    let reward: string;
    if (prize) {
      if (prize.kind === 'corn') {
        cornDelta = prize.payout;
        donator = { ...donator, corn: donator.corn + prize.payout };
      } else if (prize.kind === 'cash') {
        donator = { ...donator, cash: donator.cash + prize.payout };
      }
      reward = this.rewardLabel(prize);
      prize.awarded += 1;
      write(KEYS.config, config);
    } else {
      cornDelta = config.consolationCorn;
      donator = { ...donator, corn: donator.corn + config.consolationCorn };
      reward = config.consolationCorn > 0 ? `기본 혜택 +${config.consolationCorn} 강냉이` : '-';
    }
    this.saveDonator(donator);

    const entry: HistoryEntry = {
      roundId,
      at: new Date().toISOString(),
      game: GAME_NAME,
      spent: -open.fee,
      reward,
      result: prize ? '당첨' : '꽝',
      kind: prize ? prize.kind : '-',
    };
    write(KEYS.history, [entry, ...read<HistoryEntry[]>(KEYS.history, [])].slice(0, 500));

    return {
      outcome: { roundId, pickedNumber, prize, cornDelta, entryFee: open.fee },
      donator,
    };
  }

  private rewardLabel(prize: Prize): string {
    if (prize.kind === 'corn') return `${prize.name} (+${prize.payout.toLocaleString()} 강냉이)`;
    if (prize.kind === 'cash') return `${prize.name} (+${prize.payout.toLocaleString()} 캐시)`;
    return prize.name;
  }

  async listHistory(limit = 50): Promise<HistoryEntry[]> {
    return read<HistoryEntry[]>(KEYS.history, []).slice(0, limit);
  }

  async listRevisions(): Promise<ConfigRevision[]> {
    return read<ConfigRevision[]>(KEYS.revisions, []);
  }

  async dailyStats(): Promise<DailyStat[]> {
    const byDate = new Map<string, DailyStat>();
    for (const h of read<HistoryEntry[]>(KEYS.history, [])) {
      const date = h.at.slice(0, 10);
      const row = byDate.get(date) ?? { date, rounds: 0, wins: 0, losses: 0, cornSpent: 0, cornPaid: 0 };
      row.rounds += 1;
      if (h.result === '당첨') row.wins += 1;
      else row.losses += 1;
      row.cornSpent += -h.spent;
      byDate.set(date, row);
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  async prizeStats(): Promise<PrizeStat[]> {
    const byLabel = new Map<string, number>();
    for (const h of read<HistoryEntry[]>(KEYS.history, [])) {
      const label = h.result === '꽝' ? '꽝' : h.reward;
      byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    }
    return [...byLabel.entries()].map(([label, wins]) => ({ label, wins })).sort((a, b) => b.wins - a.wins);
  }

  /** 시연용. 오늘 날짜로 강냉이를 채워 넣는다 */
  async topUp(amount: number): Promise<Donator> {
    const donator = await this.getDonator();
    const next = { ...donator, corn: donator.corn + amount };
    this.saveDonator(next);
    return next;
  }
}
