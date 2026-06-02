# Implementation Stories — Zeude

> 각 스토리는 독립적으로 구현 가능한 단위로 분해됨.
> 우선순위: P1(즉시) > P2(단기) > P3(중기)

---

## Epic 1. Sensing — 사용 측정 & 분석

### S1-1. Agent/MCP 툴 사용 타입 수집 [P1]

**목표**: `agent`/`mcp_tool` prompt_type을 실제로 수집해 분석에 반영

**구현 스토리:**

**Story 1-1-a**: ClickHouse Materialized View 생성
```sql
-- claude_code_logs에서 tool_decision 이벤트를 집계하는 MV 생성
CREATE MATERIALIZED VIEW tool_usage_by_prompt_mv
ENGINE = SummingMergeTree()
ORDER BY (user_id, prompt_id, tool_name)
AS SELECT
  ResourceAttributes['zeude.user.id'] AS user_id,
  LogAttributes['prompt.id'] AS prompt_id,
  LogAttributes['tool_name'] AS tool_name,
  count() AS call_count
FROM claude_code_logs
WHERE Body = 'claude_code.tool_decision'
  AND LogAttributes['prompt.id'] != ''
GROUP BY user_id, prompt_id, tool_name
```
- 파일 위치: `dashboard/clickhouse/migrations/016_tool_usage_mv.sql`
- AC: MV가 신규 이벤트 실시간 반영, `Agent` / `mcp_*` 툴명 집계 가능

**Story 1-1-b**: 프롬프트 analytics 쿼리에 JOIN 추가
- 파일: `dashboard/src/lib/prompt-analytics.ts`
- `_getUserPromptTypeStats()` 함수에서 `ai_prompts`와 `tool_usage_by_prompt_mv` LEFT JOIN
- `tool_name = 'Agent'` 매칭 시 `effective_prompt_type = 'agent'` 오버라이드
- AC: 대시보드 Prompt Type 차트에 `agent` 항목 실제 수치 표시

**Story 1-1-c**: `/api/prompts/[id]` PATCH 지원 추가
- 현재 엔드포인트는 GET/DELETE만 존재
- `PATCH { promptType: 'agent' | 'mcp_tool', invokedName: string }` 수신
- ClickHouse에 새 행 INSERT (MergeTree이므로 UPDATE 불가 — `argMax` 패턴 활용)
- AC: PATCH 후 조회 시 업데이트된 타입 반환

---

### S1-2. 실시간 비용 알림 [P2]

**목표**: 일일/주간 비용 임계값 초과 시 알림

**Story 1-2-a**: 비용 임계값 설정 API
- `PATCH /api/user/settings { dailyCostLimit: number, weeklyCostLimit: number }`
- Supabase `zeude_users` 테이블에 `cost_limits JSONB` 컬럼 추가
- Migration: `dashboard/supabase/migrations/012_cost_limits.sql`

**Story 1-2-b**: 비용 체크 훅 배포
- `Stop` 이벤트 훅으로 세션 종료 시 당일 누적 비용 조회
- 임계값 초과 시 터미널에 경고 출력
- AC: $10 설정 시 초과하면 `[zeude] ⚠ 오늘 비용 $10.23 초과` 출력

---

### S1-3. 다중 소스 통합 필터 개선 [P2]

**목표**: 소스 필터를 AND 조건 다중 선택으로 변경

**Story 1-3-a**: SourceFilter 타입 확장
- 현재: `'all' | 'claude' | 'codex' | 'copilot' | 'opencode'` 단일 선택
- 변경: `SourceFilter[]` 배열로 다중 선택 지원
- `buildSourceCondition()` 함수 수정 (`clickhouse.ts`)
- AC: Claude + Copilot 동시 선택 시 두 소스 합산 집계

---

## Epic 2. Delivery — 구성 관리 & 자동 배포

### S2-1. 스킬 버전 관리 [P2]

**목표**: 스킬 변경 이력 추적 및 롤백

**Story 2-1-a**: Supabase 스킬 이력 테이블
```sql
CREATE TABLE zeude_skill_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID REFERENCES zeude_skills(id),
  version INT,
  content TEXT,
  changed_by UUID REFERENCES zeude_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
- Migration: `dashboard/supabase/migrations/013_skill_versions.sql`

**Story 2-1-b**: 스킬 저장 시 버전 자동 생성
- `PUT /api/admin/skills/[id]` 처리 시 현재 content를 `zeude_skill_versions`에 백업
- AC: 스킬 수정 시 이전 버전 보존, 최대 10개 보관

**Story 2-1-c**: 어드민 UI 롤백 버튼
- 스킬 편집 다이얼로그에 "버전 히스토리" 탭 추가
- 선택한 버전으로 content 복원
- AC: 이전 버전 선택 → 저장 시 해당 버전으로 스킬 복원

---

### S2-2. 훅 실행 결과 추적 [P2]

**목표**: 훅이 실제로 실행됐는지, 오류가 있었는지 추적

**Story 2-2-a**: 훅 실행 이벤트 수집
- `claude_code_logs`의 `claude_code.hook_execution_start` / `claude_code.hook_execution_complete` 이벤트 활용
- ClickHouse MV로 훅별 실행 횟수, 실패율 집계
- Migration: `dashboard/clickhouse/migrations/017_hook_execution_stats.sql`

**Story 2-2-b**: 어드민 훅 통계 화면
- Hook 관리 페이지에 "실행 통계" 컬럼 추가 (7일 실행 횟수, 실패율)
- AC: 실패율 > 10%인 훅에 빨간 배지 표시

---

### S2-3. MCP 서버 헬스체크 [P3]

**목표**: 등록된 MCP 서버 연결 상태 모니터링

**Story 2-3-a**: 헬스체크 API
- `GET /api/admin/mcp/[id]/health`
- 서버 command 실행 시도 후 응답 확인
- AC: 200 (정상) / 503 (연결 실패) 반환

**Story 2-3-b**: MCP 관리 화면 상태 표시
- 각 MCP 서버 행에 헬스 상태 인디케이터 (녹색/빨간 dot)
- 5분마다 자동 새로고침

---

## Epic 3. Guidance — 컨텍스트 기반 스킬 제안

### S3-1. 스킬 제안 대시보드 [P1]

**목표**: 어드민이 어떤 스킬이 얼마나 제안/채택됐는지 확인

**Story 3-1-a**: 스킬 제안 분석 API
- `GET /api/admin/analytics/skill-suggestions?days=30`
- `skill_suggestions` 테이블에서 집계:
  ```
  suggested_skill, suggest_count, auto_execute_count, select_count, adoption_rate
  ```
- AC: 제안 대비 선택률(adoption_rate) 계산

**Story 3-1-b**: 어드민 Analytics에 제안 효과 섹션 추가
- 스킬별 제안 횟수, 자동실행율, 선택율 테이블
- AC: 클릭률 낮은 스킬에 개선 필요 표시

---

### S3-2. LLM 기반 스킬 제안 [P3]

**목표**: 키워드 매칭을 보완하는 시맨틱 제안

**Story 3-2-a**: `/api/skill-suggest` 시맨틱 모드 추가
- 쿼리 파라미터 `mode=semantic` 추가
- OpenRouter / Anthropic API로 프롬프트 의도 분석
- 스킬 description과 임베딩 유사도 비교
- AC: 키워드 미매칭 시 시맨틱 fallback 동작

**Story 3-2-b**: 시맨틱 제안 A/B 테스트 플래그
- 사용자별 50% 확률로 시맨틱 모드 적용
- `skill_suggestions` 테이블에 `mode` 컬럼 추가하여 비교 추적
- AC: 모드별 채택률 비교 가능

---

## Epic 4. 대시보드 — 인사이트 & 관리

### S4-1. 세션 검색 [P1]

**목표**: 특정 날짜/소스/키워드로 세션 필터링

**Story 4-1-a**: Sessions 목록 필터 UI
- `GET /api/sessions?from=&to=&source=&keyword=` 파라미터 지원
- `keyword`는 세션 내 이벤트 Body ILIKE 검색
- AC: 날짜 범위 + 소스 필터 동시 적용 가능

**Story 4-1-b**: 세션 목록 페이지에 필터 바 추가
- 날짜 range picker, 소스 드롭다운
- URL 파라미터로 필터 상태 유지 (공유 가능)
- AC: 필터 변경 시 URL 업데이트, 새로고침해도 유지

---

### S4-2. 팀원 세션 관리자 조회 [P1]

**목표**: 어드민이 특정 팀원의 세션/프롬프트 조회

**Story 4-2-a**: `viewUser` 파라미터로 타 사용자 조회
- Sessions, Prompts, Session Detail 페이지에 `?viewUser={userId}` 지원
- 어드민 권한 검증 후 해당 사용자 데이터 반환
- AC: 이미 `/sessions/[sessionId]?viewUser=xxx` 구현됨 → Sessions 목록도 동일하게 지원

**Story 4-2-b**: 팀 관리 화면에서 팀원 세션 바로가기 링크 추가
- 팀원 행에 "세션 보기" 버튼 → `/sessions?viewUser={userId}`
- AC: 어드민만 버튼 표시

---

### S4-3. 비용 예측 [P2]

**목표**: 현재 추세 기반 월말 예상 비용 표시

**Story 4-3-a**: 비용 예측 API
- `GET /api/cost-forecast`
- 최근 7일 일평균 비용 × 잔여 일수
- AC: 95% 신뢰구간 포함 (단순 선형 추정)

**Story 4-3-b**: 메인 대시보드에 예측 카드 추가
- "이번 달 예상 비용: $XX.XX" 카드
- 전월 대비 증감율 표시
- AC: 데이터 < 3일이면 "데이터 부족" 표시

---

### S4-4. Frustration 세션 알림 [P2]

**목표**: Frustration score 높은 세션 발생 시 알림

**Story 4-4-a**: Frustration 임계값 초과 시 대시보드 배지
- 메인 대시보드에 "오늘 고좌절 세션 N개" 배지
- 클릭 시 `/prompts/frustration` 페이지로 이동
- AC: `frustration_score >= 1.0` 기준

---

## Epic 5. 리더보드 & 코호트

### S5-1. 코호트 관리 UI [P1]

**목표**: 어드민이 대시보드에서 코호트를 직접 생성/관리

**Story 5-1-a**: 코호트 관리 페이지 생성
- 경로: `/admin/cohorts`
- 코호트 목록 (cohortKey, 멤버 수, 생성일, 리더보드 링크)
- 신규 코호트 생성 폼 (cohortKey + 선택적 멤버 목록)
- AC: 생성 성공 시 리더보드 URL 복사 버튼 제공

**Story 5-1-b**: 코호트 멤버 관리
- 코호트 상세에서 멤버 추가/제거
- `DELETE /api/admin/cohorts/[key]/members/[userId]` 엔드포인트 추가
- AC: 멤버 제거 후 리더보드에서 즉시 반영

---

### S5-2. 개인 랭킹 알림 [P3]

**목표**: 주간 리더보드 순위 변동을 개발자에게 알림

**Story 5-2-a**: 주간 랭킹 요약 API
- `GET /api/my-rank` — 현재 순위, 전주 순위, 변동
- AC: 리더보드 데이터 기반 계산

**Story 5-2-b**: `Stop` 훅으로 주간 랭킹 표시
- 세션 종료 시 현재 순위 터미널 출력
- AC: 월요일 리셋 후 첫 세션에만 표시 (중복 방지)

---

## Epic 6. 인프라 & 운영 (신규)

### S6-1. ClickHouse 마이그레이션 자동화 [P1]

**목표**: ClickHouse 마이그레이션을 코드로 관리 (현재 수동 실행)

**Story 6-1-a**: 마이그레이션 실행 스크립트
- `dashboard/scripts/migrate-clickhouse.ts`
- `clickhouse/migrations/` 폴더의 SQL 파일을 순서대로 실행
- 실행 이력을 `_migrations` 테이블에 저장 (중복 실행 방지)
- AC: `pnpm migrate:clickhouse` 명령으로 실행

---

### S6-2. 헬스체크 엔드포인트 [P1]

**목표**: 배포 상태 모니터링

**Story 6-2-a**: `GET /api/health`
- Supabase 연결 확인
- ClickHouse 연결 확인
- 응답: `{ status: 'ok' | 'degraded', supabase: bool, clickhouse: bool }`
- AC: Supabase/ClickHouse 중 하나 실패 시 `degraded` + HTTP 503

---

### S6-3. 데이터 익스포트 [P2]

**목표**: 사용자가 자신의 데이터를 CSV로 다운로드

**Story 6-3-a**: 프롬프트 CSV 익스포트
- `GET /api/prompts/export?from=&to=` → CSV 스트리밍 응답
- 컬럼: timestamp, prompt_text, prompt_type, project_path, session_id
- AC: 10,000건 이상도 스트리밍으로 메모리 오버플로우 없이 처리

---

## 구현 우선순위 요약

| 스프린트 | 스토리 | 예상 일정 |
|---------|-------|---------|
| Sprint 1 | S1-1 (Agent 수집), S4-1 (세션 검색), S4-2 (팀원 조회), S5-1 (코호트 UI), S6-1 (CH 마이그레이션), S6-2 (헬스체크) | 2주 |
| Sprint 2 | S1-2 (비용 알림), S2-1 (스킬 버전), S2-2 (훅 통계), S3-1 (제안 대시보드), S4-3 (비용 예측), S4-4 (Frustration 알림) | 2주 |
| Sprint 3 | S1-3 (다중 소스), S2-3 (MCP 헬스), S5-2 (랭킹 알림), S6-3 (데이터 익스포트) | 2주 |
| Sprint 4 | S3-2 (LLM 제안) | 2주 |
