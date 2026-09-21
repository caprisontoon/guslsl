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
| `settleRound(roundId, observedSlot)` | 서버가 저장해 둔 1등 칸으로 판정해 지급한다. 같은 라운드는 한 번만 정산 | `POST /api/toonland/race/rounds/{id}/settle` |
| `listHistory()` | 게임참여내역 | `GET /api/toonland/race/history` |
| `listRevisions()` | 확률 변경 이력 | `GET /api/admin/toonland/race/revisions` |
| `dailyStats()` / `prizeStats()` | 도전 통계, 상품별 통계 | `GET /api/admin/toonland/race/stats/*` |

강냉이 차감은 `startRound()` 에서 **즉시** 일어나야 합니다. 당첨왕 기획서의 "칸 구매 시
강냉이 즉시 차감"과 같은 정책입니다. 라운드가 중간에 끊겨도 참가비는 소모된 것으로
처리하고, 그렇게 하기 싫다면 일정 시간 뒤 미정산 라운드를 환불하는 배치를 따로 두세요.

`settleRound()` 는 반드시 **멱등**해야 합니다. 같은 `roundId` 로 두 번 들어오면 두 번째는
이미 지급한 결과를 그대로 돌려주고, 상품을 다시 주지 않아야 합니다.

## 3. 당첨 판정은 서버가 한다

구슬에는 **상품 이름이 그대로 보입니다.** 그래도 조작할 수 없는 이유는, 서버가 1등 칸을
**미리 알고 있고** 정산에 클라이언트 입력을 쓰지 않기 때문입니다.

물리 엔진이 결정적이라 가능한 구조입니다. `(시드, 구슬 수, 맵)` 이 같으면 언제 어디서
돌려도 같은 칸이 1등합니다. 브라우저마다 다른 wasm 빌드(SIMD / 스칼라)를 쓰는데
둘의 결과가 일치하는 것도 확인했습니다.

```
오프라인 배치  yarn seeds 100 5000 0  ->  (시드, 1등 칸) 표를 race_seed_pool 에 적재
startRound()   시드 한 줄을 꺼내고, 균등 추첨으로 뽑은 상품을 그 1등 칸에 올린다
               클라이언트에는 { seed, labels } 만 준다 (1등 칸은 알려주지 않는다)
클라이언트     그 시드로 레이스를 재생한다 -> 서버가 아는 칸의 구슬이 1등한다
settleRound()  서버가 저장해 둔 값으로 판정한다. 클라이언트에게 묻지 않는다
```

백엔드가 물리 엔진을 돌릴 필요는 없습니다. 시드 표만 미리 채워두면 되므로 어떤
스택이든 붙일 수 있습니다.

시드 표는 **그때의 물리 설정으로** 계산한 값이라, 물리에 영향을 주는 것(`useSkills`,
맵 도형, 물리 상수, box2d 버전)을 바꾸면 표를 새로 만들어야 합니다. 자세한 목록은
[server/SERVER_SPEC.md](./server/SERVER_SPEC.md) 참고.

서버 구현에서 지켜야 할 것은 세 가지입니다.

1. **정산은 서버가 저장한 1등 칸으로만 한다.** 요청 본문의 `observedSlot` 은 화면에서
   실제로 1등한 칸이고, 판정에 쓰면 안 됩니다. 저장해 두었다가 서버 값과 다르면
   **재생 불일치**로 지표에 남기세요. 이 값이 0 이 아니면 결정성이 깨진 것입니다.
2. **시드 배정을 참가비 차감보다 먼저 한다.** 시드 풀이 비었거나 설정이 잘못돼
   라운드를 못 열면, 강냉이가 빠지기 전에 실패해야 합니다.
3. **라운드 토큰을 1회용으로 만들고 `settleRound()` 를 멱등하게 구현한다.**

자세한 절차와 점검 목록은 [`server/SERVER_SPEC.md`](./server/SERVER_SPEC.md) 에 있습니다.

## 4. 확률이 지켜지는 원리

관리자가 넣은 확률(%)은 `apportion()` 이 최대잔여법으로 **구슬 개수**로 환산합니다.
개수의 합은 언제나 정확히 `fieldSize` 이고, 각 상품의 실제 확률은 `개수 / fieldSize` 입니다.

서버는 그 구성에서 **균등하게 하나를 뽑아** 이번 판의 당첨 상품을 정합니다. 물리는
확률에 관여하지 않습니다. 시드는 어느 칸이 1등할지만 정하고, 뽑힌 상품을 그 칸에
올려놓을 뿐입니다.

```shell
yarn verify:odds    # 환산 + 추첨 분포 + 재생 결정성
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
