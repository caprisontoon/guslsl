# 투네이션 백엔드 연동 가이드

강냉이 레이스는 백엔드에 대한 의존을 `GameApi` 인터페이스 하나로 모아 두었습니다.
프론트에는 이미 HTTP 구현(`ToonationGameApi`)이 들어 있으니, **서버만 계약대로
만들면 코드 수정 없이 붙습니다.**

| 파일 | 내용 |
|---|---|
| [`server/openapi.yaml`](./server/openapi.yaml) | API 계약. 경로·요청·응답·오류 코드 |
| [`server/SERVER_SPEC.md`](./server/SERVER_SPEC.md) | 엔드포인트별 알고리즘, 트랜잭션 경계, 점검 목록 |
| [`server/schema.sql`](./server/schema.sql) | 게임 전용 테이블 DDL |
| `src/toonland/httpApi.ts` | 프론트 HTTP 클라이언트 (이미 구현됨) |
| `src/toonland/api.ts` | `GameApi` 인터페이스 정의 |

## 1. 붙이는 방법

HTML 에 메타 태그만 넣으면 됩니다. 빌드를 다시 하지 않아도 되고, 배포 환경마다
다른 값을 쓸 수 있습니다.

```html
<meta name="toonland-api-base" content="/api/toonland/race">
<meta name="toonland-admin-api-base" content="/api/admin/toonland/race">
<meta name="toonland-api-credentials" content="include">
<meta name="toonland-charge-url" content="/charge">
```

`index.html` 과 `admin.html` 의 `<head>` 에 주석으로 넣어뒀으니 풀어서 경로만
맞추면 됩니다.

태그가 없으면 브라우저 저장소로 도는 **시연 모드**이고, 화면 상단에 그 사실을 알리는
띠가 뜹니다. 실서버로 착각한 채 테스트하는 일을 막기 위한 장치입니다.

Bearer 토큰을 쓴다면 `src/toonland/apiFactory.ts` 에서 `ToonationGameApi` 에
`headers` 콜백을 넘기세요.

```ts
new ToonationGameApi({
  baseUrl,
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
});
```

## 2. 서버가 해줘야 하는 일

| 메서드 | 서버가 하는 일 | 제안 엔드포인트 |
|---|---|---|
| `loadConfig()` | 현재 적용 중인 게임 설정을 내려준다 | `GET /api/toonland/race/config` |
| `saveConfig(config, revision)` | 설정을 저장하고 변경 이력을 남긴다. 예약이면 예약 테이블에 넣는다 | `PUT /api/admin/toonland/race/config` |
| `pendingConfig()` | 예약 대기 중인 설정 | `GET /api/admin/toonland/race/config/pending` |
| `getDonator()` | 로그인한 도네이터의 닉네임·등급·강냉이·캐시 | `GET /api/me` |
| `startRound()` | **참가비만큼 강냉이를 차감**하고 라운드 토큰을 발급한다. 잔액이 모자라면 실패 | `POST /api/toonland/race/rounds` |
| `settleRound(roundId, pickedNumber)` | 번호에 걸린 상품을 찾아 지급한다. 같은 라운드는 한 번만 정산 | `POST /api/toonland/race/rounds/{id}/settle` |
| `listHistory()` | 게임참여내역 | `GET /api/toonland/race/history` |
| `listRevisions()` | 확률 변경 이력 | `GET /api/admin/toonland/race/revisions` |
| `dailyStats()` / `prizeStats()` | 도전 통계, 상품별 통계 | `GET /api/admin/toonland/race/stats/*` |

강냉이 차감은 `startRound()` 에서 **즉시** 일어나야 합니다. 당첨왕 기획서의 "칸 구매 시
강냉이 즉시 차감"과 같은 정책입니다. 라운드가 중간에 끊겨도 참가비는 소모된 것으로
처리하고, 그렇게 하기 싫다면 일정 시간 뒤 미정산 라운드를 환불하는 배치를 따로 두세요.

`settleRound()` 는 반드시 **멱등**해야 합니다. 같은 `roundId` 로 두 번 들어오면 두 번째는
이미 지급한 결과를 그대로 돌려주고, 상품을 다시 주지 않아야 합니다.

## 3. 당첨 판정은 서버가 한다

구슬에는 **번호만** 적혀 있습니다. 번호 → 상품 매핑은 서버만 알고, 클라이언트에는
내려가지 않습니다.

```
startRound()   서버: 확률대로 상품 목록을 만들고 번호에 무작위 배정 -> 매핑은 서버에 보관
               서버: 참가비 차감, 라운드 토큰 + 구슬 수(fieldSize)만 응답
클라이언트     1..fieldSize 번호 구슬로 레이스. 어떤 번호가 뭔지 모른다
settleRound()  클라이언트: "18번이 1등했다" 만 보고
               서버: 매핑에서 18번의 상품을 찾아 지급하고 결과를 응답
```

브라우저를 조작해 다른 번호를 신고해도 이득이 없습니다. 매핑이 매 판 새로 섞이고
숨겨져 있으므로 어떤 번호를 고르든 기대값이 같고, 라운드 토큰은 1회용이라 결과가
마음에 들 때까지 다시 신고할 수도 없습니다. 당첨왕의 "게임이 끝나면 번호판이 뒤집히며
당첨 번호가 공개되는" 연출과도 같은 구조입니다.

서버 구현에서 지켜야 할 것은 세 가지입니다.

1. **매핑을 응답에 담지 마세요.** `startRound()` 응답에 상품 배열이나 번호별 정보가
   들어가면 이 설계의 의미가 없어집니다. 내려줄 것은 `fieldSize` 뿐입니다.
2. **번호 범위를 검증하세요.** `1 <= pickedNumber <= fieldSize` 가 아니면 거부합니다.
3. **라운드 토큰을 1회용으로 만드세요.** 정산된 라운드에 다시 들어온 요청은 새로 뽑지
   않고 기존 결과를 그대로 돌려줘야 합니다.

기본 구현(`LocalGameApi`)이 이 세 가지를 모두 지키고 있으니 참고하면 됩니다.
다만 매핑을 메모리에 들고 있어서 새로고침하면 라운드가 사라지므로, 서버에서는
라운드 테이블에 저장하세요.

원한다면 정산 응답에 번호별 상품 전체를 실어 보내 당첨왕처럼 **번호판 공개 연출**을
할 수도 있습니다. 정산이 끝난 뒤라면 매핑을 공개해도 안전합니다.

**확률 테이블은 서버가 들고 있어야 합니다.** 클라이언트가 내려받는 설정은 화면에
상품 목록과 확률을 보여주기 위한 것이고, 당첨 판정의 근거가 되어서는 안 됩니다.

## 4. 확률이 지켜지는 원리

관리자가 넣은 확률(%)은 `apportion()` 이 최대잔여법으로 **구슬 개수**로 환산합니다.
개수의 합은 언제나 정확히 `fieldSize` 이고, 각 상품의 실제 확률은 `개수 / fieldSize` 입니다.

배정은 두 단계이고 둘 다 균등한 셔플입니다.

1. 서버가 상품 목록을 **번호**에 배정합니다 (`LocalGameApi.startRound`).
2. 엔진이 번호를 **출발 칸**에 배치합니다 (`setMarbles`).

출발 칸에는 유불리가 있습니다. 2000판을 돌려보면 칸별 승리 수가 0회에서 116회까지
갈립니다(균등하면 20회). 그런데도 상품별 당첨 확률은 개수 비율과 일치합니다. 두 배정
순열이 균등하고 물리와 독립이라 칸의 유불리가 상쇄되기 때문입니다.

서버에서 `apportion()` 대신 가중 추첨을 써도 같습니다. 개수를 가중치로 하는 추첨과
동치입니다.

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
  name: string;        // 상품 목록과 결과 화면에 쓰인다. 유일해야 하고 / 와 * 는 못 쓴다
  kind: 'corn' | 'inventory' | 'cash';
  payout: number;      // corn=강냉이 수량, cash=캐시 금액, inventory=인벤토리 idx
  cornValue: number;   // 강냉이 환산값 (1캐시 = 25강냉이). 통계·기대수지용
  probability: number; // 당첨 확률 %
  winnerLimit: number; // 당첨 인원. 0이면 무제한
  awarded: number;     // 지금까지 지급된 수량
  visible: boolean;
};
```

`winnerLimit` 에 도달한 상품은 라운드를 열 때 필드에서 빠지고 그 확률은 꽝으로
넘어갑니다. 지급 시점에도 한도를 한 번 더 확인해서, 동시에 들어온 요청이 한도를 넘겨
지급하지 않도록 막아야 합니다.

## 6. 화면 붙이기

두 화면 모두 정적 파일이라 투네이션 프론트에 iframe 으로 얹거나, 마크업을 기존
투네랜드 레이아웃에 옮겨 붙일 수 있습니다.

강냉이가 부족할 때는 `toonland-charge-url` 로 지정한 캐시 충전 페이지를 새 창으로
엽니다. 지정하지 않으면 안내 토스트만 띄웁니다.

- 게임 화면 `index.html` — 헤더(도네이터 정보·강냉이 잔액)는 투네랜드 공통 헤더로
  교체하면 됩니다. 캔버스는 `[data-race-canvas]` 안에 붙고, 결과 모달은 1등 번호를
  `#resultNumber` 에, 상품을 `#resultPrize` 에 채웁니다.
- 관리자 화면 `admin.html` — 좌측 네비게이션은 기존 관리자 레이아웃에 맞춰
  `투네랜드 > 투네랜드 강냉이 레이스` 항목으로 들어갑니다.

색·모서리·그림자는 `assets/style.scss`, `assets/admin.scss` 최상단의 CSS 변수만 바꾸면
전체가 따라옵니다.
