-- 투네랜드 강냉이 레이스 - 게임 전용 테이블
--
-- MySQL 8 문법으로 썼습니다. 투네이션 DB 가 다른 엔진이면 타입만 바꾸면 됩니다
-- (JSON -> jsonb, DATETIME -> timestamptz, AUTO_INCREMENT -> identity).
--
-- 강냉이 잔액과 인벤토리는 투네이션에 이미 있는 테이블을 씁니다. 여기서 만드는 것은
-- 이 게임에만 필요한 설정/라운드/지급 기록입니다. 기존 테이블 이름을 알려주시면
-- 아래 주석의 참조 지점을 실제 이름으로 바꿔 드리겠습니다.

-- ---------------------------------------------------------------------------
-- 게임 설정
-- ---------------------------------------------------------------------------

-- 현재 적용 중인 설정과 예약 설정을 한 테이블에 둔다.
-- apply_at 이 NULL 이면 적용 중, 값이 있으면 그 시각에 적용될 예약이다.
CREATE TABLE race_config (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  entry_fee       INT          NOT NULL COMMENT '1회 참가비 (강냉이)',
  field_size      INT          NOT NULL COMMENT '구슬 수. 확률 해상도',
  map_index       INT          NOT NULL DEFAULT 0,
  lose_label      VARCHAR(20)  NOT NULL DEFAULT '꽝',
  consolation_corn INT         NOT NULL DEFAULT 0 COMMENT '꽝 기본 혜택 강냉이',
  prizes          JSON         NOT NULL COMMENT 'Prize[] 스냅샷. openapi.yaml 의 Prize 스키마',
  apply_at        DATETIME     NULL COMMENT 'NULL = 적용 중, 값 = 예약',
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT       NULL COMMENT '운영자 회원 idx',

  CONSTRAINT chk_race_config_field_size CHECK (field_size >= 2),
  CONSTRAINT chk_race_config_entry_fee CHECK (entry_fee >= 0),
  INDEX idx_race_config_apply (apply_at, updated_at)
);

-- 확률 변경 이력. 관리자 화면의 '확률 변경 이력' 탭이 이걸 읽는다.
-- 상품을 지우거나 이름을 바꿔도 당시 확률 구성이 남아야 하므로 스냅샷으로 박아둔다.
CREATE TABLE race_config_revision (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scheduled_for    DATETIME     NULL COMMENT 'NULL = 즉시 적용',
  entry_fee        INT          NOT NULL,
  consolation_corn INT          NOT NULL,
  field_size       INT          NOT NULL,
  odds             JSON         NOT NULL COMMENT '[{label, probability}] 스냅샷',
  memo             VARCHAR(120) NOT NULL DEFAULT '',
  created_by       BIGINT       NULL COMMENT '운영자 회원 idx',

  INDEX idx_race_revision_created (created_at DESC)
);

-- ---------------------------------------------------------------------------
-- 라운드
-- ---------------------------------------------------------------------------

-- 한 판. prize_by_number 가 이 설계의 핵심이고 절대 클라이언트로 내려가지 않는다.
--
-- 구슬에는 번호만 적혀 있고, 어떤 번호가 무슨 상품인지는 이 컬럼에만 있다.
-- 그래서 브라우저를 조작해 다른 번호를 신고해도 기대값이 달라지지 않는다.
CREATE TABLE race_round (
  id               CHAR(36)     PRIMARY KEY COMMENT '라운드 토큰 (UUID)',
  member_idx       BIGINT       NOT NULL COMMENT '투네이션 회원 idx',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  entry_fee        INT          NOT NULL COMMENT '차감한 참가비. 설정이 바뀌어도 이 값으로 정산',
  field_size       INT          NOT NULL,
  consolation_corn INT          NOT NULL COMMENT '라운드 시작 시점의 기본 혜택',
  prize_by_number  JSON         NOT NULL COMMENT '[prizeId|null] * field_size. 응답에 절대 포함하지 말 것',

  -- 정산 결과. settled_at 이 NULL 이면 아직 안 끝난 라운드다.
  settled_at       DATETIME     NULL,
  picked_number    INT          NULL,
  won_prize_id     VARCHAR(40)  NULL COMMENT '꽝이면 NULL',
  corn_delta       INT          NULL COMMENT '지급된 강냉이 (꽝 기본 혜택 포함)',
  reward_label     VARCHAR(120) NULL COMMENT '게임참여내역에 보여줄 문자열',

  INDEX idx_race_round_member (member_idx, created_at DESC),
  INDEX idx_race_round_settled (settled_at),
  -- 미정산 라운드를 환불하는 배치가 쓸 인덱스
  INDEX idx_race_round_stale (settled_at, created_at)
);

-- 상품별 지급 수량. 당첨 인원(winnerLimit) 한도를 동시성 안전하게 관리한다.
--
-- Prize.awarded 를 race_config.prizes JSON 안에서 올리면 동시 요청이 겹칠 때
-- 한도를 넘겨 지급할 수 있다. 행 단위로 분리해서 UPDATE ... WHERE 로 잠근다.
CREATE TABLE race_prize_award (
  prize_id     VARCHAR(40) PRIMARY KEY,
  winner_limit INT         NOT NULL DEFAULT 0 COMMENT '0 = 무제한',
  awarded      INT         NOT NULL DEFAULT 0,
  updated_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT chk_race_award_nonneg CHECK (awarded >= 0)
);

-- ---------------------------------------------------------------------------
-- 초기 데이터
-- ---------------------------------------------------------------------------

-- 프론트 기본값과 같은 설정. 상품 확률 합계 37%, 꽝 63%.
INSERT INTO race_config (entry_fee, field_size, map_index, lose_label, consolation_corn, prizes, apply_at)
VALUES (
  1000, 100, 0, '꽝', 50,
  JSON_ARRAY(
    JSON_OBJECT('id','p1','name','강냉이 10000','kind','corn','payout',10000,'cornValue',10000,'probability',1,'winnerLimit',0,'awarded',0,'visible',true),
    JSON_OBJECT('id','p2','name','강냉이 5000','kind','corn','payout',5000,'cornValue',5000,'probability',4,'winnerLimit',0,'awarded',0,'visible',true),
    JSON_OBJECT('id','p3','name','강냉이 2000','kind','corn','payout',2000,'cornValue',2000,'probability',10,'winnerLimit',0,'awarded',0,'visible',true),
    JSON_OBJECT('id','p4','name','강냉이 1000','kind','corn','payout',1000,'cornValue',1000,'probability',20,'winnerLimit',0,'awarded',0,'visible',true),
    JSON_OBJECT('id','p5','name','캐시 100','kind','cash','payout',100,'cornValue',2500,'probability',2,'winnerLimit',50,'awarded',0,'visible',true)
  ),
  NULL
);

INSERT INTO race_prize_award (prize_id, winner_limit, awarded) VALUES
  ('p1', 0, 0),
  ('p2', 0, 0),
  ('p3', 0, 0),
  ('p4', 0, 0),
  ('p5', 50, 0);
