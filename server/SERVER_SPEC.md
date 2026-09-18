# 서버 구현 명세 — 강냉이 레이스

엔드포인트별로 서버가 실제로 해야 하는 일을 적었습니다. 언어 중립적으로 썼으니
투네이션 스택에 그대로 옮기면 됩니다.

- API 계약: [`openapi.yaml`](./openapi.yaml)
- 테이블: [`schema.sql`](./schema.sql)
- 프론트 클라이언트: `src/toonland/httpApi.ts`

확률 환산 로직은 프론트의 `src/toonland/prizeTable.ts` 에 있는 `apportion()` 과
**같은 결과**를 내야 합니다. 그 파일이 기준 구현이고, 실물 물리 8000판으로 검증돼
있습니다 (`yarn verify:odds 8000`).

## 절대 지켜야 할 세 가지

이 세 가지가 깨지면 브라우저 조작으로 상위 상품을 뽑을 수 있습니다.

1. **번호 → 상품 매핑을 응답에 담지 않는다.** `POST /rounds` 가 내려줄 것은
   `fieldSize` 뿐입니다. 디버그 로그나 에러 응답에도 새지 않게 하세요.
2. **번호 범위를 검증한다.** `1 <= pickedNumber <= fieldSize` 가 아니면 거부합니다.
3. **라운드 토큰은 1회용이고 정산은 멱등하다.** 이미 정산된 라운드에 다시 들어오면
   새로 뽑지 않고 처음 결과를 그대로 돌려줍니다.

## 확률 → 구슬 개수 환산 (`apportion`)

최대잔여법입니다. 개수 합이 정확히 `fieldSize` 가 되고, 각 상품의 실제 확률은
`개수 / fieldSize` 입니다.

```
입력: prizes (노출 중이고 당첨 한도가 남은 것만), fieldSize
1. losePercent = max(0, 100 - sum(prize.probability))
2. entries = prizes + [꽝(losePercent)]
3. total = sum(entries.probability)
   total <= 0 이면 전부 꽝으로 채우고 종료
4. raw[i]   = entries[i].probability / total * fieldSize
   count[i] = floor(raw[i])
5. left = fieldSize - sum(count)
   raw 의 소수부가 큰 순서로 left 개에 1씩 더한다
6. 결과: [(prize|null, count)]
```

주의할 점:

- **당첨 한도가 찬 상품은 3단계 이전에 빼야 합니다.** 그 확률은 자동으로 꽝에 흡수됩니다.
- 확률 합계가 100%를 넘으면 정규화되어 꽝이 0개가 됩니다. 저장 시점에 막는 게 맞지만
  (아래 `PUT /config` 검증), 런타임에서도 터지지 않고 동작합니다.
- 소수부가 같을 때의 순서만 다르면 개수가 1개 차이날 수 있습니다. 확률에 영향을 주는
  수준은 아니지만, 프론트와 정확히 같은 결과를 원하면 `prizeTable.ts` 의
  정렬(`b.frac - a.frac`, 동률이면 원래 순서 유지)을 그대로 따르세요.

## `GET /config`

적용 중인 설정을 내려줍니다.

```
1. 예약 승격: apply_at <= now() 인 예약 행이 있으면
   그중 가장 이른 것을 적용 중(apply_at = NULL)으로 올리고, 이전 적용 행은 지운다.
   -> 매 요청에서 하기보다 1분 주기 배치로 돌리는 편이 낫습니다.
2. apply_at IS NULL 인 행을 GameConfig 로 직렬화해 반환
3. prizes 의 awarded 는 race_prize_award 의 현재값으로 채운다
   (JSON 안의 awarded 는 신뢰하지 않는다)
```

응답은 공개 정보입니다. 게임 화면이 상품 목록과 확률을 보여주는 데만 쓰고,
당첨 판정의 근거로는 쓰지 않습니다.

## `PUT /config` (관리자)

```
1. 운영자 권한 확인
2. 검증 — 하나라도 실패하면 400 CONFIG_INVALID
   - fieldSize >= 2, entryFee >= 0, consolationCorn >= 0
   - 상품 확률 합계 <= 100
   - 상품 이름: 비어있지 않고, 필드 안에서 유일하고, / 와 * 를 포함하지 않고,
     꽝 이름과 같지 않음
   - 각 상품 probability >= 0
   (프론트 `validateConfig()` 와 같은 규칙입니다. 프론트 검증은 UX 용이고
    서버가 다시 해야 합니다)
3. 트랜잭션
   a. revision.scheduledFor 가 NULL 이면
        기존 적용 행(apply_at IS NULL)을 지우고 새 행을 apply_at = NULL 로 넣는다
      값이 있으면
        apply_at = scheduledFor 로 예약 행을 넣는다 (적용 행은 그대로)
   b. race_config_revision 에 이력 한 줄
   c. race_prize_award 를 상품 목록과 동기화
        새 상품 -> INSERT (awarded = 0)
        winnerLimit 변경 -> UPDATE winner_limit
        삭제된 상품 -> 행은 남겨둔다 (통계와 과거 라운드가 참조한다)
4. 저장된 설정 반환 (updatedAt 갱신)
```

진행 중인 라운드는 자기 시작 시점의 `entry_fee` / `consolation_corn` /
`prize_by_number` 로 정산됩니다. 설정을 바꿔도 이미 열린 라운드에는 영향이 없습니다.

## `POST /rounds` — 라운드 열기

**순서가 중요합니다.** 매핑 생성이 참가비 차감보다 먼저여야 합니다.

```
1. 로그인 확인 -> 없으면 401 UNAUTHORIZED
2. 적용 중인 설정을 읽는다
3. 당첨 한도가 남은 상품만 골라 apportion() -> [(prize|null, count)]
4. prizeByNumber = 개수만큼 펼친 배열을 셔플
   (Fisher-Yates, 암호학적 난수 사용 권장)
5. prizeByNumber.length < 2 이면 409 CONFIG_INVALID 로 종료
   — 차감 전이므로 강냉이가 빠지지 않는다
6. 트랜잭션
   a. 회원 강냉이 잔액을 행 잠금으로 읽는다 (SELECT ... FOR UPDATE)
   b. corn < entryFee 이면 롤백하고 402 INSUFFICIENT_CORN (need, have 포함)
   c. corn -= entryFee
   d. race_round INSERT (id = UUID, prize_by_number, entry_fee, field_size,
      consolation_corn, member_idx)
7. { roundId, fieldSize, config, donator } 반환
   — prizeByNumber 는 넣지 않는다
```

라운드가 중간에 끊겨도 참가비는 소모된 것으로 처리합니다 (당첨왕의 "칸 구매 시 즉시
차감"과 같은 정책). 환불하고 싶다면 `settled_at IS NULL AND created_at < now() - 30분`
인 라운드를 찾아 되돌리는 배치를 따로 두세요. 그때도 정산과 겹치지 않게 라운드 행을
잠그고 처리해야 합니다.

## `POST /rounds/{roundId}/settle` — 결과 확정

```
1. 로그인 확인
2. 트랜잭션
   a. race_round 를 행 잠금으로 읽는다 (SELECT ... FOR UPDATE)
      없거나 member_idx 가 다르면 404 ROUND_NOT_FOUND
   b. settled_at 이 이미 있으면 (멱등 경로)
         저장된 picked_number / won_prize_id / corn_delta 로 응답을 만들어 반환
         — 상품을 다시 지급하지 않는다
   c. pickedNumber 검증: 정수이고 1..field_size 범위
         아니면 400 NUMBER_OUT_OF_RANGE
   d. prizeId = prize_by_number[pickedNumber - 1]
   e. 상품이 있으면 당첨 한도를 원자적으로 잡는다
         UPDATE race_prize_award
            SET awarded = awarded + 1
          WHERE prize_id = ?
            AND (winner_limit = 0 OR awarded < winner_limit)
         영향 행이 0이면 방금 소진된 것 -> 꽝으로 처리한다 (prizeId = NULL)
   f. 지급
         corn      : 회원 강냉이 += payout,  cornDelta = payout
         cash      : 회원 캐시   += payout,  cornDelta = 0
         inventory : 회원 인벤토리에 payout(아이템 idx) 지급, cornDelta = 0
         꽝        : 회원 강냉이 += consolation_corn, cornDelta = consolation_corn
   g. race_round UPDATE (settled_at, picked_number, won_prize_id, corn_delta,
      reward_label)
3. { outcome, donator } 반환
```

`e` 단계가 당첨 인원 동시성 처리입니다. 두 명이 같은 순간에 마지막 하나를 노려도
`UPDATE ... WHERE awarded < winner_limit` 이 한 명만 통과시킵니다. 통과하지 못한
쪽은 꽝으로 떨어지고 기본 혜택을 받습니다.

인벤토리 지급은 투네이션 기존 지급 경로를 재사용하세요. 럭키픽 기획서에
"회원 인벤토리 물품 습득 타입에 투네랜드 추가" 항목이 있으니 같은 타입 체계를
쓰면 됩니다.

## `GET /me`

투네이션 로그인 세션에서 회원을 찾아 `Donator` 로 반환합니다.

```
{ idx, platform, nickname, account, corn, cash }
```

`account` 는 화면에 그대로 노출되지 않지만, 당첨왕 기획서의 마스킹 규칙
(첫 두 글자만 남기고 나머지 `*`)이 필요하면 서버에서 마스킹해 내려주세요.

## `GET /history`

```
SELECT ... FROM race_round
 WHERE member_idx = ? AND settled_at IS NOT NULL
 ORDER BY settled_at DESC
 LIMIT ?        -- limit 은 200 으로 상한
```

`HistoryEntry` 로 변환:

| 필드 | 값 |
|---|---|
| `roundId` | `race_round.id` |
| `at` | `settled_at` |
| `game` | `'강냉이 레이스'` |
| `spent` | `-entry_fee` |
| `reward` | `reward_label` |
| `result` | `won_prize_id IS NULL ? '꽝' : '당첨'` |
| `kind` | 상품 종류, 꽝이면 `'-'` |

투네랜드 공통 게임참여내역에도 넣으려면 같은 레코드를 기존 테이블에 함께 적으면 됩니다.

## 관리자 조회 3종

```
GET /revisions      race_config_revision ORDER BY created_at DESC  (30개씩 페이징)
GET /stats/daily    race_round 를 DATE(settled_at) 로 묶어 집계
GET /stats/prizes   race_round 를 won_prize_id 로 묶어 당첨 횟수 집계
```

`stats/daily` 예시:

```sql
SELECT DATE(settled_at)                          AS date,
       COUNT(*)                                  AS rounds,
       SUM(won_prize_id IS NOT NULL)             AS wins,
       SUM(won_prize_id IS NULL)                 AS losses,
       SUM(entry_fee)                            AS cornSpent,
       SUM(corn_delta)                           AS cornPaid
  FROM race_round
 WHERE settled_at IS NOT NULL
 GROUP BY DATE(settled_at)
 ORDER BY date DESC;
```

럭키픽 기획서에 있는 CSV 다운로드가 필요하면 같은 쿼리 결과를 내려주면 됩니다.

## 프론트 붙이기

서버가 준비되면 HTML 에 메타 태그만 넣으면 실서버로 붙습니다. 빌드를 다시 하지
않아도 됩니다.

```html
<meta name="toonland-api-base" content="/api/toonland/race">
<meta name="toonland-admin-api-base" content="/api/admin/toonland/race">
<meta name="toonland-api-credentials" content="include">
```

태그가 없으면 브라우저 저장소로 도는 시연 모드이고, 화면 상단에 그 사실을 알리는
띠가 뜹니다. Bearer 토큰을 쓴다면 `src/toonland/apiFactory.ts` 에서
`ToonationGameApi` 에 `headers` 콜백을 넘기세요.

## 점검 목록

붙인 뒤 이것들을 확인하세요.

- [ ] `POST /rounds` 응답 어디에도 번호별 상품 정보가 없다
- [ ] 같은 `roundId` 로 두 번 정산해도 상품이 한 번만 지급된다
- [ ] `pickedNumber` 를 0, `fieldSize + 1`, 소수, 문자열로 보내면 거부된다
- [ ] 남은 당첨 인원이 1인 상품에 동시 요청 2개를 보내면 한 명만 받는다
- [ ] 강냉이가 참가비보다 적으면 차감 없이 402 가 온다
- [ ] 구슬 수를 1로 만든 설정은 저장 단계에서 막히고, 혹시 들어가도 차감 없이 409 가 온다
- [ ] 예약 설정이 지정 시각에 적용되고, 진행 중이던 라운드는 옛 설정으로 정산된다
- [ ] 서버 `apportion()` 결과가 프론트 `apportion()` 과 같은 개수를 낸다
