import {
  type DailyStat,
  type GameApi,
  InsufficientCornError,
  type PrizeStat,
  type Settled,
  type StartedRound,
} from './api';
import type { ConfigRevision, Donator, GameConfig, HistoryEntry } from './types';

export type HttpApiOptions = {
  /** 도네이터용 엔드포인트 프리픽스 */
  baseUrl: string;
  /** 관리자용 엔드포인트 프리픽스. 없으면 baseUrl 을 쓴다 */
  adminBaseUrl?: string;
  /** 세션 쿠키로 인증하면 'include' */
  credentials?: RequestCredentials;
  /** Bearer 토큰 등 요청마다 붙일 헤더 */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
};

/** 서버가 실패를 돌려줄 때의 공통 형태 */
type ErrorBody = {
  error?: {
    code?: string;
    message?: string;
    need?: number;
    have?: number;
  };
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 투네이션 서버에 붙는 GameApi 구현.
 *
 * 엔드포인트 경로와 응답 형태는 server/openapi.yaml 에 정의돼 있다. 서버가 그 계약을
 * 지키면 이 클래스는 그대로 쓸 수 있고, 경로 규칙이 다르면 아래 path 문자열만 고치면 된다.
 *
 * 번호 -> 상품 매핑은 여기로 내려오지 않는다. startRound 는 구슬 수만 받고,
 * 당첨 판정은 settleRound 응답으로만 알 수 있다.
 */
export class ToonationGameApi implements GameApi {
  constructor(private readonly options: HttpApiOptions) {}

  private get adminBase(): string {
    return this.options.adminBaseUrl ?? this.options.baseUrl;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const extra = this.options.headers ? await this.options.headers() : {};
    const response = await fetch(url, {
      method,
      credentials: this.options.credentials,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) throw await this.toError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** 서버 오류 코드를 게임이 아는 예외로 바꾼다 */
  private async toError(response: Response): Promise<Error> {
    let parsed: ErrorBody = {};
    try {
      parsed = (await response.json()) as ErrorBody;
    } catch {
      // 본문이 JSON 이 아니면 상태 코드만으로 처리한다
    }
    const code = parsed.error?.code ?? `HTTP_${response.status}`;
    const message = parsed.error?.message ?? `요청이 실패했습니다 (${response.status})`;

    if (code === 'INSUFFICIENT_CORN') {
      return new InsufficientCornError(parsed.error?.need ?? 0, parsed.error?.have ?? 0);
    }
    return new ApiError(response.status, code, message);
  }

  loadConfig(): Promise<GameConfig> {
    return this.request('GET', `${this.options.baseUrl}/config`);
  }

  saveConfig(config: GameConfig, revision: ConfigRevision): Promise<GameConfig> {
    return this.request('PUT', `${this.adminBase}/config`, { config, revision });
  }

  pendingConfig(): Promise<{ config: GameConfig; applyAt: string } | null> {
    return this.request('GET', `${this.adminBase}/config/pending`);
  }

  getDonator(): Promise<Donator> {
    return this.request('GET', `${this.options.baseUrl}/me`);
  }

  startRound(): Promise<StartedRound> {
    return this.request('POST', `${this.options.baseUrl}/rounds`);
  }

  settleRound(roundId: string, pickedNumber: number): Promise<Settled> {
    return this.request('POST', `${this.options.baseUrl}/rounds/${encodeURIComponent(roundId)}/settle`, {
      pickedNumber,
    });
  }

  listHistory(limit = 50): Promise<HistoryEntry[]> {
    return this.request('GET', `${this.options.baseUrl}/history?limit=${limit}`);
  }

  listRevisions(): Promise<ConfigRevision[]> {
    return this.request('GET', `${this.adminBase}/revisions`);
  }

  dailyStats(): Promise<DailyStat[]> {
    return this.request('GET', `${this.adminBase}/stats/daily`);
  }

  prizeStats(): Promise<PrizeStat[]> {
    return this.request('GET', `${this.adminBase}/stats/prizes`);
  }
}
