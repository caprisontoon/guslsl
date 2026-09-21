# 서버 구현 명세 — 강냉이 레이스

엔드포인트별로 서버가 실제로 해야 하는 일을 적었습니다. 언어 중립적으로 썼으니
투네이션 스택에 그대로 옮기면 됩니다.

- API 계약: [`openapi.yaml`](./openapi.yaml)
- 테이블: [`schema.sql`](./schema.sql)
- 프론트 클라이언트: `src/toonland/httpApi.ts`

확률 환산 로직은 프론트의 `src/toonland/prizeTable.ts` 에 있는 `apportion()` 과
**같은 결과**를 내야 합니다. 그 파일이 기준 구현이고, 환산 정확도·추첨 분포·재생
결정성을 `yarn verify:odds` 로 검증합니다.

## 이 설계의 뼈대

물리 엔진이 결정적입니다. **(시드, 구슬 수, 맵)** 이 같으면 언제 어디서 돌려도 같은
칸의 구슬이 1등합니다. SIMD 빌드와 스칼라 빌드도 같은 결과를 냅니다(브라우저마다
다른 빌드를 쓰기 때문에 확인했습니다).

그래서 이렇게 합니다.

```
오프라인 배치   yarn seeds 100 5000 0  ->  (seed, winner_slot) 표를 race_seed_pool 에 적재
POST /rounds    시드 한 줄을 꺼내고, 뽑은 상품을 winner_slot 칸에 올려 labels 를 만든다
                클라이언트에 { seed, labels } 를 준다
클라이언트      그 시드로 레이스를 재생한다 -> winner_slot 의 구슬이 1등한다
POST /settle    서버는 저장해 둔 winner_slot 으로 판정한다. 클라이언트에게 묻지 않는다
```

**구슬에 상품 이름을 다 보여줘도 안전합니다.** 서버가 답을 이미 알고 있고 정산에
클라이언트 입력을 쓰지 않으므로, 브라우저를 조작해도 바꿀 게 없습니다.

백엔드가 물리 엔진을 돌릴 필요는 없습니다. 시드 풀만 미리 채워두면 됩니다.

## 절대 지켜야 할 세 가지

1. **정산은 `race_round.winner_slot` 으로만 한다.** 요청 본문의 `observedSlot` 은
   판정에 쓰지 않습니다. 저장해 두었다가 `winner_slot` 과 다르면 재생 불일치로
   지표에 남기세요. 이 비율이 0 이 아니면 결정성이 깨진 것이니 조사해야 합니다.
2. **시드 배정을 참가비 차감보다 먼저 한다.** 시드 풀이 비었거나 설정이 잘못돼
   라운드를 못 열면, 강냉이가 빠지기 전에 실패해야 합니다.
3. **라운드 토큰은 1회용이고 정산은 멱등하다.** 이미 정산된 라운드에 다시 들어오면
   새로 뽑지 않고 처음 결과를 그대로 돌려줍니다.

## 시드 풀 채우기

```shell
yarn seeds <구슬수> <개수> <맵번호> > pool.csv
# 예: yarn seeds 100 5000 0 > pool.csv
```

`map_index,field_size,seed,winner_slot` 형식의 CSV 가 나옵니다. 그대로
`race_seed_pool` 에 적재하세요. 시드 하나당 약 0.2초 걸립니다.

관리자가 **구슬 수나 맵을 바꾸면 그 조합의 시드가 따로 필요합니다.** 쓸 조합을 미리
채워두고, 남은 개수가 임계치 아래로 떨어지면 배치로 보충하세요. 조합에 맞는 시드가
없으면 라운드를 열 수 없습니다(409).

시드를 재사용해도 확률은 망가지지 않습니다(상품 배치는 매 판 새로 뽑으므로). 다만
같은 레이스 장면이 반복되어 눈에 띄므로 `used_at` 으로 안 쓴 것부터 꺼내세요.

### 물리를 건드리면 풀을 다시 만들어야 합니다

시드 풀은 **그때의 물리 설정으로** 계산한 표입니다. 물리에 영향을 주는 값이 바뀌면
저장된 `winner_slot` 이 더 이상 맞지 않고, 화면에서 1등한 구슬과 서버가 지급하는
상품이 어긋납니다. 재생 불일치 지표가 곧바로 튀어 오르니 바로 드러나기는 하지만,
그전에 실제 지급이 틀어집니다.

해당하는 것:

- `src/options.ts` 의 `useSkills` (구슬 스킬. 지금은 꺼져 있고, 켜면 결과가 바뀝니다)
- `src/data/maps.ts` 의 맵 도형
- `src/marble.ts` 의 밀도·반지름 등 물리 상수, `src/physics-box2d.ts` 의 중력·스텝
- box2d-wasm 메이저 업데이트

그래서 이 값들은 **사용자나 관리자가 바꿀 수 있는 설정이 아닙니다.** 바꿔야 한다면
배포 전에 `yarn seeds` 로 풀을 새로 만들어 교체하세요.

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
`labels` / `winner_slot` 으로 정산됩니다. 설정을 바꿔도 이미 열린 라운드에는 영향이 없습니다.

## `POST /rounds` — 라운드 열기

**순서가 중요합니다.** 시드 배정이 참가비 차감보다 먼저여야 합니다.

```
1. 로그인 확인 -> 없으면 401 UNAUTHORIZED
2. 적용 중인 설정을 읽는다
3. 당첨 한도가 남은 상품만 골라 apportion() -> [(prize|null, count)]
   개수만큼 펼쳐 배열 field 를 만든다 (길이 = fieldSize)
4. field.length < 2 이면 409 CONFIG_INVALID 로 종료
5. 시드 풀에서 (map_index, field_size) 가 맞고 안 쓴 줄을 하나 꺼낸다
   없으면 409 CONFIG_INVALID (배치로 보충 필요)
6. 이번 판의 당첨 상품을 뽑는다
   field 를 셔플한 뒤 맨 앞을 winner 로 삼으면 된다. field 의 구성이 곧 확률이므로
   가중 추첨과 같다 (암호학적 난수 권장)
7. labels 를 만든다
   labels[winner_slot] = winner 의 이름 (꽝이면 loseLabel)
   나머지 칸에는 field 에서 winner 를 하나 뺀 나머지를 셔플해서 채운다
   -> 화면에 보이는 구성이 설정 확률과 정확히 같아진다
8. 트랜잭션
   a. 회원 강냉이 잔액을 행 잠금으로 읽는다 (SELECT ... FOR UPDATE)
   b. corn < entryFee 이면 롤백하고 402 INSUFFICIENT_CORN (need, have 포함)
   c. corn -= entryFee
   d. 시드 줄에 used_at 을 찍는다
   e. race_round INSERT (id = UUID, seed, winner_slot, labels, won_prize_id,
      entry_fee, field_size, map_index, consolation_corn, member_idx)
9. { roundId, seed, labels, config, donator } 반환
```

7단계를 이렇게 하는 이유: 1등 칸에 뽑힌 상품을 먼저 박고 나머지를 채우면, 각 상품이
화면에 나오는 개수가 설정 분포와 같으면서도 1등 칸의 상품은 정확히 6단계에서 뽑은
값이 됩니다. 확률과 연출이 동시에 맞습니다.

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
         저장된 winner_slot / won_prize_id / corn_delta 로 응답을 만들어 반환
         — 상품을 다시 지급하지 않는다
   c. observed_slot = 요청 본문의 observedSlot 을 그대로 기록만 한다
      winner_slot 과 다르면 재생 불일치 지표를 올린다. 판정에는 쓰지 않는다
   d. prizeId = race_round.won_prize_id  (라운드를 열 때 이미 정해졌다)
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
   g. race_round UPDATE (settled_at, observed_slot, corn_delta, reward_label)
      — 한도 소진으로 꽝이 됐다면 won_prize_id 를 NULL 로 되돌린다
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

- [ ] `observedSlot` 에 아무 값이나 넣어도 결과가 달라지지 않는다 (판정에 안 쓰임)
- [ ] 같은 `roundId` 로 두 번 정산해도 상품이 한 번만 지급된다
- [ ] 남은 당첨 인원이 1인 상품에 동시 요청 2개를 보내면 한 명만 받는다
- [ ] 강냉이가 참가비보다 적으면 차감 없이 402 가 온다
- [ ] 시드 풀이 빈 (맵, 구슬 수) 조합은 차감 없이 409 가 온다
- [ ] 구슬 수를 1로 만든 설정은 저장 단계에서 막히고, 혹시 들어가도 차감 없이 409 가 온다
- [ ] 예약 설정이 지정 시각에 적용되고, 진행 중이던 라운드는 옛 설정으로 정산된다
- [ ] 서버 `apportion()` 결과가 프론트 `apportion()` 과 같은 개수를 낸다
- [ ] **재생 불일치율이 0 이다** (`observed_slot != winner_slot` 인 라운드 수)
      0 이 아니면 결정성이 깨진 것이다. 엔진을 고치기 전까지 배포하면 안 된다
