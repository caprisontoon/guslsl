# 투네이션 백엔드 연동 가이드

강냉이 레이스는 백엔드에 대한 의존을 `GameApi` 인터페이스 하나로 모아 두었습니다.
이 인터페이스만 구현해서 갈아끼우면 게임·관리자 화면 코드는 그대로 둔 채 투네이션
서버에 붙습니다.

## 1. 갈아끼우는 지점

기본 구현은 브라우저 저장소로 도는 `LocalGameApi` 입니다. 서버 없이 전체 흐름을
시연할 수 있게 넣어둔 것이고, 실제 서비스에서는 쓰지 않습니다.

```ts
// src/index.ts
const api = new LocalGameApi();          // -> new ToonationGameApi()

// src/admin/index.ts
new AdminApp(new LocalGameApi()).init(); // -> new ToonationGameApi()
```

`GameApi` 정의는 `src/toonland/api.ts` 에 있습니다.

## 2. 서버가 해줘야 하는 일

| 메서드 | 서버가 하는 일 | 제안 엔드포인트 |
|---|---|---|
| `loadConfig()` | 현재 적용 중인 게임 설정을 내려준다 | `GET /api/toonland/race/config` |
| `saveConfig(config, revision)` | 설정을 저장하고 변경 이력을 남긴다. 예약이면 예약 테이블에 넣는다 | `PUT /api/admin/toonland/race/config` |
| `pendingConfig()` | 예약 대기 중인 설정 | `GET /api/admin/toonland/race/config/pending` |
| `getDonator()` | 로그인한 도네이터의 닉네임·등급·강냉이·캐시 | `GET /api/me` |
| `startRound()` | **참가비만큼 강냉이를 차감**하고 라운드 토큰을 발급한다. 잔액이 모자라면 실패 | `POST /api/toonland/race/rounds` |
| `settleRound(roundId, prizeId)` | 결과를 확정하고 상품을 지급한다. 같은 라운드는 한 번만 정산 | `POST /api/toonland/race/rounds/{id}/settle` |
| `listHistory()` | 게임참여내역 | `GET /api/toonland/race/history` |
| `listRevisions()` | 확률 변경 이력 | `GET /api/admin/toonland/race/revisions` |
| `dailyStats()` / `prizeStats()` | 도전 통계, 상품별 통계 | `GET /api/admin/toonland/race/stats/*` |

강냉이 차감은 `startRound()` 에서 **즉시** 일어나야 합니다. 당첨왕 기획서의 "칸 구매 시
강냉이 즉시 차감"과 같은 정책입니다. 라운드가 중간에 끊겨도 참가비는 소모된 것으로
처리하고, 그렇게 하기 싫다면 일정 시간 뒤 미정산 라운드를 환불하는 배치를 따로 두세요.

`settleRound()` 는 반드시 **멱등**해야 합니다. 같은 `roundId` 로 두 번 들어오면 두 번째는
이미 지급한 결과를 그대로 돌려주고, 상품을 다시 주지 않아야 합니다.

## 3. 보안: 결과를 누가 정하는가

**지금 코드는 클라이언트가 레이스를 돌리고 그 결과를 서버에 알려주는 구조입니다.**
사내 시연이나 신뢰된 환경에서는 괜찮지만, 실제 서비스에 그대로 올리면
브라우저를 조작해 항상 1등 상품을 신고할 수 있습니다. 배포 전에 아래 중 하나로
반드시 막아야 합니다.

### 방법 A — 번호 구슬 + 서버 매핑 (권장)

구슬에 상품 이름 대신 **번호**를 표시하고, 번호 → 상품 매핑은 서버만 압니다.
클라이언트는 "몇 번 구슬이 1등했다"만 보고하고, 서버가 그 번호를 상품으로 바꿉니다.

조작하려 해도 구슬이 전부 똑같아 보이므로 어떤 번호를 신고해도 확률이 같습니다.
라운드 토큰이 1회용이라 마음에 들 때까지 다시 굴릴 수도 없습니다.
당첨왕의 "게임이 끝나면 번호판이 뒤집히며 당첨 번호가 공개되는" 연출과도 맞습니다.

코드는 `FieldSlot` 이 이미 `label`(화면 표시)과 `prize`(실제 상품)를 분리해 두었기 때문에
`src/toonland/prizeTable.ts` 의 `buildField()` 에서 `label` 을 번호로 바꾸고,
`src/toonland/game.ts` 의 `labelToPrize` 를 서버 응답으로 대체하면 됩니다.

### 방법 B — 서버가 먼저 뽑고 연출만 클라이언트가

`startRound()` 응답에 당첨 결과를 담아 내려주고, 화면은 그 결과가 나오도록 연출합니다.
가장 확실하지만, 물리 결과를 미리 정한 값에 맞추려면 재생이 결정적이어야 해서
(`physics-box2d.ts` 의 구슬 밀도 난수, `marble.ts` 의 스킬 발동 난수) 엔진에 시드를
넣는 작업이 추가로 필요합니다.

어느 쪽이든 **확률 테이블은 서버가 들고 있어야 합니다.** 클라이언트가 내려받는 설정은
화면 표시용이고, 당첨 판정의 근거가 되어서는 안 됩니다.

## 4. 확률이 지켜지는 원리

관리자가 넣은 확률(%)은 `apportion()` 이 최대잔여법으로 **구슬 개수**로 환산합니다.
개수의 합은 언제나 정확히 `fieldSize` 이고, 각 상품의 실제 확률은 `개수 / fieldSize` 입니다.

출발 칸에는 유불리가 있지만(아래 칸이 결승선에 가깝습니다), 라벨을 칸에 배정하는 순열이
균등하고 물리와 독립이므로 상품별 당첨 확률은 정확히 개수 비율이 됩니다.

서버에서 직접 뽑을 때도 같은 분포를 쓰면 됩니다. `apportion()` 결과의 개수를 가중치로
하는 가중 추첨과 동치입니다.

```shell
yarn verify:odds 2000    # 실제 물리로 2000판을 돌려 설정 확률과 실측을 대조
```

`fieldSize` 가 확률 해상도를 정합니다. 100이면 1% 단위, 200이면 0.5% 단위까지 오차 없이
표현됩니다. 표현할 수 없는 확률은 관리자 화면이 저장 전에 경고합니다.

## 5. 데이터 형태

타입은 `src/toonland/types.ts` 에 있습니다. 서버 응답을 그대로 이 모양으로 맞추면
변환 코드가 필요 없습니다.

```ts
type Prize = {
  id: string;
  name: string;        // 구슬에 표시된다. 필드 안에서 유일해야 하고 / 와 * 는 못 쓴다
  kind: 'corn' | 'inventory' | 'cash';
  payout: number;      // corn=강냉이 수량, cash=캐시 금액, inventory=인벤토리 idx
  cornValue: number;   // 강냉이 환산값 (1캐시 = 25강냉이). 통계·기대수지용
  probability: number; // 당첨 확률 %
  winnerLimit: number; // 당첨 인원. 0이면 무제한
  awarded: number;     // 지금까지 지급된 수량
  visible: boolean;
};
```

`winnerLimit` 에 도달한 상품은 클라이언트가 자동으로 필드에서 빼고 그 확률을 꽝으로
넘깁니다. 서버도 지급 시점에 같은 한도를 확인해서, 동시에 들어온 요청이 한도를 넘겨
지급하지 않도록 막아야 합니다.

## 6. 화면 붙이기

두 화면 모두 정적 파일이라 투네이션 프론트에 iframe 으로 얹거나, 마크업을 기존
투네랜드 레이아웃에 옮겨 붙일 수 있습니다.

- 게임 화면 `index.html` — 헤더(도네이터 정보·강냉이 잔액)는 투네랜드 공통 헤더로
  교체하면 됩니다. 캔버스는 `[data-race-canvas]` 안에 붙습니다.
- 관리자 화면 `admin.html` — 좌측 네비게이션은 기존 관리자 레이아웃에 맞춰
  `투네랜드 > 투네랜드 강냉이 레이스` 항목으로 들어갑니다.

색·모서리·그림자는 `assets/style.scss`, `assets/admin.scss` 최상단의 CSS 변수만 바꾸면
전체가 따라옵니다.
