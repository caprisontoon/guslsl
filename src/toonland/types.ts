/** 지급 수단. 투네랜드 기존 게임(당첨왕/럭키픽)의 아이템 종류와 같은 축을 쓴다 */
export type PrizeKind = 'corn' | 'inventory' | 'cash';

export type Prize = {
  id: string;
  /** 구슬에 표시되는 이름. 필드 안에서 유일해야 한다 */
  name: string;
  kind: PrizeKind;
  /** corn = 강냉이 수량, cash = 캐시 금액, inventory = 인벤토리 idx */
  payout: number;
  /** 강냉이 환산값. 통계와 기대값 계산에만 쓴다 (1캐시 = 25강냉이) */
  cornValue: number;
  /** 당첨 확률 (%) */
  probability: number;
  /** 당첨 인원 한도. 0이면 무제한 */
  winnerLimit: number;
  /** 지금까지 지급된 수량 */
  awarded: number;
  /** 프론트 노출 여부 */
  visible: boolean;
};

export type GameConfig = {
  /** 1회 플레이에 소모되는 강냉이 */
  entryFee: number;
  /** 한 판에 굴릴 구슬 수. 확률 해상도를 정한다 (100이면 1% 단위) */
  fieldSize: number;
  mapIndex: number;
  /** 꽝 구슬에 표시할 이름 */
  loseLabel: string;
  /** 꽝이어도 지급하는 기본 혜택 강냉이 */
  consolationCorn: number;
  prizes: Prize[];
  updatedAt: string;
};

/** 확률 변경 이력 한 줄. 럭키픽 기획서의 '확률 변경 내역'과 같은 역할 */
export type ConfigRevision = {
  at: string;
  /** 즉시 적용이면 null, 예약이면 반영 시각 */
  scheduledFor: string | null;
  entryFee: number;
  consolationCorn: number;
  fieldSize: number;
  /** 스냅샷. 상품명 -> 확률(%) */
  odds: { label: string; probability: number }[];
  memo: string;
};

export type Donator = {
  idx: number;
  platform: string;
  nickname: string;
  account: string;
  corn: number;
  cash: number;
};

/** 레이스에 투입되는 구슬 한 칸. 꽝이면 prize 가 null */
export type FieldSlot = {
  label: string;
  prize: Prize | null;
};

export type RoundOutcome = {
  roundId: string;
  /** 1등으로 골인한 구슬의 번호 */
  pickedNumber: number;
  /** 그 번호에 걸려 있던 상품. 꽝이면 null */
  prize: Prize | null;
  /** 실제 지급된 강냉이 (꽝 기본 혜택 포함) */
  cornDelta: number;
  entryFee: number;
};

export type HistoryEntry = {
  roundId: string;
  at: string;
  /** 게임 유형. 투네랜드 게임참여내역에 같은 축으로 들어간다 */
  game: string;
  /** 소모한 강냉이 (음수) */
  spent: number;
  /** 당첨 내역 표시용 문자열 */
  reward: string;
  result: '당첨' | '꽝';
  kind: PrizeKind | '-';
};
