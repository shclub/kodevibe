# Architecture — Zeude

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          DEVELOPER MACHINE                           │
│                                                                      │
│  claude (shim)  ──exec──▶  real claude  ──OTel──▶  OTLP Collector  │
│  ~/.zeude/bin              (original)               (via HTTP)       │
│        │                                                             │
│        │ startup: sync skills/hooks/mcp                              │
│        ▼                                                             │
│  UserPromptSubmit Hook  ──▶  POST /api/prompts  (프롬프트 저장)     │
│  Skill Hint Hook        ──▶  GET  /api/skill-suggest                │
└──────────────────────────────────────────────────────────────────────┘
                    │ HTTP                        │ OTLP HTTP
                    ▼                             ▼
┌──────────────────────────┐       ┌─────────────────────────────┐
│    Zeude Dashboard       │       │   OpenTelemetry Collector    │
│    (Next.js / Vercel)    │       │   (otelcol-contrib)          │
│                          │       └──────────────┬──────────────┘
│  /api/*  ──▶  Supabase   │                      │ ClickHouse exporter
│  /api/*  ──▶  ClickHouse │                      ▼
│                          │       ┌─────────────────────────────┐
└──────────────────────────┘       │   ClickHouse                │
                │                  │   claude_code_logs (raw)    │
                ▼                  │   ai_prompts                │
┌──────────────────────────┐       │   skill_suggestions         │
│   Supabase (PostgreSQL)  │       │   pricing_model             │
│                          │       │   Materialized Views        │
│   zeude_users            │       └─────────────────────────────┘
│   zeude_mcp_servers      │
│   zeude_skills           │
│   zeude_hooks            │
│   zeude_cohort_members   │
│   zeude_invites          │
└──────────────────────────┘
```

---

## 2. Technology Stack

| Layer | Technology | 역할 |
|-------|-----------|------|
| **CLI Shim** | Go 1.21+ | claude/copilot/opencode/codex 래퍼 |
| **Dashboard** | Next.js 15 (App Router) | 웹 UI + API Routes |
| **Auth** | Custom session (Supabase) | OTT 기반 인증, Agent Key 인증 |
| **RDBMS** | Supabase (PostgreSQL) | 사용자/스킬/훅/설정 저장 |
| **OLAP** | ClickHouse | 텔레메트리/분석 데이터 저장 |
| **Telemetry** | OpenTelemetry (OTLP HTTP) | Claude Code 네이티브 OTel 수집 |
| **UI Library** | shadcn/ui + Tailwind CSS | 컴포넌트 |
| **State** | TanStack Query | 서버 상태 캐싱 |
| **Package Manager** | pnpm | 프론트엔드 |
| **Container** | Docker Compose | 로컬/배포 환경 |

---

## 3. Component Architecture

### 3.1 Go CLI Shim (`cmd/claude`, `cmd/copilot`, `cmd/opencode`)

```
main() 실행 흐름:
  1. 백그라운드 동기화 모드 여부 확인
  2. FastSync (캐시 기반, <100ms) → MCP/Skills/Hooks 설정 로드
  3. 실제 바이너리 경로 탐색 (resolver)
  4. 텔레메트리 환경변수 주입 (OTEL_EXPORTER_OTLP_ENDPOINT 등)
  5. 백그라운드 동기화 프로세스 spawn (네트워크 포함 full sync)
  6. exec() — 현재 프로세스를 실제 바이너리로 교체
```

**핵심 내부 패키지:**
- `internal/mcpconfig`: MCP 서버 설정 동기화 및 skills/hooks 파일 배포
- `internal/identity`: Agent Key로 사용자 인증 및 캐시
- `internal/autoupdate`: 버전 확인 및 자동 업데이트
- `internal/otlplog`: Copilot/OpenCode용 수동 OTLP 로그 전송
- `internal/otelenv`: OTel 환경변수 주입
- `internal/resolver`: 실제 바이너리 경로 탐색

**설계 원칙:**
- `exec()` 사용 — 프로세스 교체로 오버헤드 최소화
- Fail-open — 동기화 실패해도 Claude Code는 정상 실행
- 에러 무시 — 텔레메트리는 best-effort

---

### 3.2 Next.js Dashboard (`dashboard/src`)

```
src/
├── app/
│   ├── (dashboard)/          # 일반 사용자 화면
│   │   ├── page.tsx          # 메인 (오늘 통계)
│   │   ├── sessions/         # 세션 목록 + 상세
│   │   ├── prompts/          # 프롬프트 히스토리 + Frustration
│   │   └── leaderboard/      # 리더보드 (코호트 지원)
│   ├── (admin)/              # 어드민 전용
│   │   └── admin/
│   │       ├── analytics/    # 팀 분석
│   │       ├── skills/       # 스킬 관리
│   │       ├── hooks/        # 훅 관리
│   │       ├── mcp/          # MCP 서버 관리
│   │       └── team/         # 사용자 관리
│   └── api/                  # API Routes
│       ├── config/_/         # Shim용 설정 API (skills+hooks+mcp 통합)
│       ├── prompts/          # 프롬프트 수집 (POST) + 검색 (GET)
│       ├── leaderboard/      # 리더보드 데이터
│       ├── skill-suggest/    # 스킬 제안 엔진
│       ├── skill-suggestions/# 제안 이벤트 기록
│       └── admin/
│           ├── analytics/    # 팀 분석 API
│           └── cohorts/      # 코호트 관리
├── lib/
│   ├── clickhouse.ts         # ClickHouse 쿼리 (세션, 리더보드)
│   ├── prompt-analytics.ts   # ai_prompts 기반 분석
│   ├── prompt-utils.ts       # 프롬프트 타입 감지
│   └── session.ts            # 세션/인증
└── hooks/                    # React Query hooks
```

**인증 레이어:**
- 웹 브라우저: One-Time Token → Session Cookie (Supabase)
- CLI Shim: `Agent Key` (`zd_` + 64자 hex) → HTTP header `Authorization: Bearer`

---

### 3.3 데이터 수집 파이프라인

#### Path A: Claude Code 네이티브 OTel (주 경로)
```
Claude Code
  └─ OTel SDK (내장)
       └─ OTLP HTTP ──▶ OTel Collector
                              └─ ClickHouse Exporter
                                    └─ claude_code_logs 테이블
```

이벤트 종류 (`Body` 필드):
- `claude_code.user_prompt` — 사용자 입력
- `claude_code.api_request` — Claude API 호출 (토큰/비용 포함)
- `claude_code.tool_decision` — 툴 실행 결정 (Bash, Read, Agent 등)
- `claude_code.compaction` — 컨텍스트 압축
- `session_start` — 세션 시작

#### Path B: 프롬프트 훅 (보완 경로)
```
UserPromptSubmit Hook (bash)
  └─ POST /api/prompts
        └─ ClickHouse INSERT ──▶ ai_prompts 테이블
```
프롬프트 텍스트, 타입, 프로젝트 경로를 `claude_code_logs`와 별도 저장 (richer metadata).

#### Path C: Copilot/OpenCode 수동 OTel
```
Copilot/OpenCode shim
  └─ internal/otlplog.SendTokenUsage()
        └─ OTLP HTTP (직접 전송, 5초 타임아웃)
              └─ claude_code_logs 테이블
```

---

## 4. Database Schema

### 4.1 Supabase (PostgreSQL)

| 테이블 | 주요 컬럼 | 용도 |
|--------|----------|------|
| `zeude_users` | id, email, agent_key, team, role, disabled_skills | 사용자 |
| `zeude_mcp_servers` | name, command, args, env, teams, is_global | MCP 서버 설정 |
| `zeude_skills` | name, slug, content, files, keywords, teams | 스킬 |
| `zeude_hooks` | name, event, script_content, script_type, teams | 훅 |
| `zeude_cohort_members` | cohort_key, user_id, created_at | 코호트 멤버십 |
| `zeude_invites` | token, team, role, expires_at, used_at | 초대 링크 |
| `zeude_sessions` | token, user_id, expires_at | 웹 세션 |

### 4.2 ClickHouse

| 테이블/뷰 | 엔진 | 용도 |
|-----------|------|------|
| `claude_code_logs` | MergeTree | OTel 원본 로그 (모든 이벤트) |
| `ai_prompts` | MergeTree | 프롬프트 히스토리 (TTL 180일) |
| `skill_suggestions` | MergeTree | 스킬 제안 이벤트 (TTL 90일) |
| `pricing_model` | ReplacingMergeTree | 모델별 토큰 단가 |
| `token_usage_hourly` | MV | 시간별 토큰 집계 |
| `efficiency_metrics` | MV | 세션 효율성 지표 |
| `frustration_analysis` | MV | 좌절 패턴 분석 |

**설계 특이사항:**
- `ai_prompts`는 `MergeTree` (ReplacingMergeTree 아님) → PATCH 업데이트는 새 행 삽입
  - 조회 시 반드시 `argMax(field, timestamp)` + `GROUP BY prompt_id` 로 중복 제거 필요
- `claude_code_logs`의 사용자 식별: `ResourceAttributes['zeude.user.id']` 또는 `LogAttributes['user.email']`
- 비용 계산: 쿼리 시점에 `pricing_model` JOIN으로 실시간 계산

---

## 5. 핵심 데이터 흐름

### 5.1 세션 상세 페이지 렌더링
```
브라우저 요청 (/sessions/{sessionId})
  └─ getSessionDetails(email, userId, sessionId)
        └─ ClickHouse: claude_code_logs WHERE session.id = ?
              └─ groupIntoTurns(events)  ← prompt_id 기준 Turn 그루핑
                    └─ TurnCard 렌더링 (Turn별 API call, Tool 사용 표시)
```

### 5.2 리더보드 (코호트 모드)
```
GET /api/leaderboard?cohort=bootcamp-2025
  └─ resolveCohortFilter(cohortKey)
        └─ Supabase: zeude_cohort_members WHERE cohort_key = ?
        └─ Supabase: zeude_users WHERE id IN (memberIds)
  └─ buildCohortWhereClause(userIds, userEmails)
  └─ ClickHouse: 코호트 등록 시점부터 토큰 집계
  └─ JSON 응답 (topTokenUsers, topSkills, cohort 메타데이터)
```

### 5.3 스킬 제안 흐름
```
사용자 프롬프트 입력
  └─ UserPromptSubmit Hook 실행 (bash)
        └─ GET /api/skill-suggest?prompt={text}
              └─ 2-Tier 키워드 매칭 (primary/secondary keywords)
              └─ 매칭 스킬 반환
        └─ Hook: 스킬 힌트 출력 or auto-execute
        └─ POST /api/skill-suggestions (이벤트 기록)
```

---

## 6. 인증 & 보안

| 시나리오 | 인증 방식 |
|---------|----------|
| 웹 브라우저 로그인 | OTT(One-Time Token) → 세션 쿠키 |
| CLI Shim 인증 | `~/.zeude/credentials`의 `agent_key` 헤더 전송 |
| Admin API | 세션 쿠키 + `role === 'admin'` 검사 |
| 공개 Install | `/releases/install.sh` (Agent Key 포함) |

- 코호트 키: URL-safe 문자만 허용, 64자 제한 (`sanitizeCohortKey`)
- SQL Injection: ClickHouse parameterized query (`{param:Type}`) 사용
- API Key 보호: `extra_headers`의 API Key는 서버 사이드에서만 주입

---

## 7. 배포 구조

```
zeude/deployments/
├── docker-compose.mac.yaml   # 로컬 개발 (ClickHouse + OTel Collector)
└── ...                       # K8s / 프로덕션 설정

Next.js Dashboard: Vercel (또는 self-hosted)
ClickHouse: ClickHouse Cloud 또는 self-hosted
Supabase: Supabase Cloud 또는 self-hosted
OTel Collector: otelcol-contrib (Docker)
CLI Binary: GitHub Releases (자동 배포)
```

**설치 흐름 (개발자 머신):**
```bash
curl -fsSL https://dashboard-url/releases/install.sh | ZEUDE_AGENT_KEY=zd_xxx bash
# → ~/.zeude/bin/claude 설치
# → PATH prepend (shell rc 파일 수정)
# → 이후 claude 실행 시 zeude shim이 먼저 실행
```

---

## 8. 확장 포인트

| 영역 | 현재 | 확장 방법 |
|------|------|----------|
| AI 도구 지원 | claude, copilot, opencode, codex | 새 shim binary 추가 (`cmd/newtool`) |
| 프롬프트 타입 | natural/skill/command | ClickHouse JOIN으로 agent/mcp_tool 감지 추가 |
| 리더보드 기준 | 토큰 수 | 스킬 사용 횟수, 세션 품질 점수 등 추가 가능 |
| 텔레메트리 소스 | OTel OTLP | Webhook, Kafka 등 추가 collector 연결 가능 |
| 코칭 기능 | 키워드 기반 제안 | LLM 기반 프롬프트 품질 분석으로 발전 가능 |
