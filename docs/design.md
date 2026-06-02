# Design Specification — Zeude Dashboard

> UI 컴포넌트 스펙 및 API 계약서.
> 기술: Next.js 15, shadcn/ui, Tailwind CSS, TanStack Query

---

## 1. 디자인 시스템

### 공통 레이아웃
```
┌─────────────────────────────────────────────────────┐
│  [Zeude Logo]  Dashboard  Sessions  Prompts  Leaderboard  │  ← Nav (사용자)
│               Analytics  Skills  Hooks  MCP  Team        │  ← Nav (어드민 추가)
├─────────────────────────────────────────────────────┤
│                                                     │
│                  <Page Content>                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 컬러 시스템 (Tailwind)
| 용도 | 클래스 |
|------|--------|
| 소스: Claude | `bg-blue-100 text-blue-700` |
| 소스: Copilot | `bg-purple-100 text-purple-700` |
| 소스: OpenCode | `bg-green-100 text-green-700` |
| 소스: Codex | `bg-orange-100 text-orange-700` |
| 타입: natural | `bg-gray-100 text-gray-700` |
| 타입: skill | `bg-blue-100 text-blue-700` |
| 타입: command | `bg-violet-100 text-violet-700` |
| 타입: agent | `bg-pink-100 text-pink-700` |
| 타입: mcp_tool | `bg-orange-100 text-orange-700` |
| Frustration High | `bg-red-50 border-red-200 text-red-800` |
| Frustration Low | `bg-yellow-50 border-yellow-200 text-yellow-800` |

---

## 2. 화면 스펙

### 2.1 메인 대시보드 (`/`)

```
┌─────────────────────────────────────────────────────────────┐
│  오늘 통계                              [소스 필터 드롭다운] │
├──────────┬──────────┬──────────┬──────────────────────────-─┤
│  토큰    │  비용    │  세션    │  이번 달 예상 비용 (NEW)   │
│  123.4K  │  $1.23   │  5       │  $24.50 (+12% vs 지난달)  │
├──────────┴──────────┴──────────┴──────────────────────────-─┤
│  Prompt Type 분포                                            │
│  ████████░░░░  natural 65%                                  │
│  ████░░░░░░░░  skill   25%                                  │
│  ██░░░░░░░░░░  command 8%                                   │
│  █░░░░░░░░░░░  agent   2%  (NEW)                            │
├─────────────────────────────────────────────────────────────┤
│  최근 세션 목록          [고좌절 세션 N개 ⚠ 배지] (NEW)    │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 14:23  claude  /observability/zeude  5턴  $0.42       │ │
│  │ 13:11  copilot /my-project          12턴  $1.20       │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**컴포넌트:**
- `<CostForecastCard>` (NEW): 예측 비용 + 전월 대비
- `<PromptTypePieChart>`: 파이차트, `agent`/`mcp_tool` 슬라이스 추가
- `<FrustrationAlertBadge>` (NEW): 고좌절 세션 수 뱃지

---

### 2.2 세션 목록 (`/sessions`)

```
┌─────────────────────────────────────────────────────────────┐
│  Sessions                                                   │
│                                                             │
│  [날짜 from] ~ [날짜 to]  [소스 ▾]  [키워드 검색...]  (NEW) │
├─────────────────────────────────────────────────────────────┤
│  시작시간          소스     턴   비용    세션 ID             │
│  ─────────────────────────────────────────────────────────  │
│  05/29 14:23 KST  claude   5   $0.42  f285e047... [→]      │
│  05/29 13:11 KST  copilot  12  $1.20  a1b2c3d4... [→]      │
│                                                 [더 보기]   │
└─────────────────────────────────────────────────────────────┘
```

**API 연결:**
```typescript
GET /api/sessions
  ?from=2026-05-01
  &to=2026-05-29
  &source=claude
  &keyword=zeude
  &viewUser={userId}   // 어드민만
  &limit=20
  &offset=0

Response: {
  sessions: SessionSummary[]
  total: number
  hasMore: boolean
}
```

---

### 2.3 세션 상세 (`/sessions/[sessionId]`)

현재 구현 완료. 추가 사항:

```
┌─────────────────────────────────────────────────────────────┐
│  ← Sessions   Session Detail                                │
│  f285e047-...  [jake@zep.us]  05/29 14:23 → 14:45         │
│                               [14 turns] [87 events]        │
├──────────┬──────────┬──────────┬───────────────────────────┤
│  Duration│  Cost    │  Input   │  Output                   │
│  22m 13s │  $0.42   │  245.3K  │  12.1K                    │
├─────────────────────────────────────────────────────────────┤
│  Model Usage  │  Commands Used  │  ⚡ Context compacted 2×  │
├─────────────────────────────────────────────────────────────┤
│  Turn 1  14:23:01                              $0.03        │
│  [User] Prompt · 523 chars                                  │
│  [Bot]  claude-sonnet-4-6  · 3.2s  ↑45.2K ↓ 1.2K         │
│  [🔧]  Bash Read Write  · 3 tool calls                     │
├─────────────────────────────────────────────────────────────┤
│  Turn 2  ...                                                │
└─────────────────────────────────────────────────────────────┘
```

---

### 2.4 프롬프트 히스토리 (`/prompts`)

```
┌─────────────────────────────────────────────────────────────┐
│  Prompts                                [소스 필터 ▾]       │
│  [키워드 검색...]                        [날짜 범위 ▾]       │
├──────┬─────────────────────────────────────────────────────┤
│  타입│  프롬프트 내용 (일부)              시간    프로젝트  │
│  ────┼───────────────────────────────────────────────────  │
│  📝  │  zeude cohort 기능의 역할이 머야?  14:23   /zeude   │
│  🔧  │  /code-review --fix               13:11   /zeude   │
│  🤖  │  /harness-lab 새 스킬 설계...     12:05   /project │
├──────┴─────────────────────────────────────────────────────┤
│  Prompt Type 추이 (7일)                                     │
│   50 ┤  ·  ·                                               │
│   25 ┤     · ·  ·  ·                                       │
│    0 └────────────────▶ 날짜                                │
│       — natural  — skill  — command  — agent               │
└─────────────────────────────────────────────────────────────┘
```

**아이콘 매핑:**
- `natural`: 📝 (`MessageSquare` lucide)
- `skill`: 🔧 (`Wrench` lucide)
- `command`: `$` (`Terminal` lucide)
- `agent`: 🤖 (`Bot` lucide)
- `mcp_tool`: 🔌 (`Plug` lucide)

---

### 2.5 어드민 Analytics (`/admin/analytics`)

**탭 구조:**
```
[Overview] [Skill Adoption] [Suggestions] [Frustration]  ← 탭 추가
```

**Suggestions 탭 (NEW):**
```
┌─────────────────────────────────────────────────────────────┐
│  Skill Suggestion Effectiveness                [30일 ▾]    │
├─────────────────┬───────────┬────────────┬─────────────────┤
│  스킬명         │  제안 횟수 │  채택률    │  자동실행율     │
│  ─────────────────────────────────────────────────────────  │
│  /code-review   │  142      │  67%  ████ │  23%  ██        │
│  /zeude         │  89       │  45%  ███  │  12%  █         │
│  /harness-lab   │  34       │  12%  █    │  0%             │
└─────────────────┴───────────┴────────────┴─────────────────┘
```

---

### 2.6 코호트 관리 (`/admin/cohorts`) — NEW

```
┌─────────────────────────────────────────────────────────────┐
│  Cohorts                              [+ 새 코호트 만들기]  │
├─────────────────────────────────────────────────────────────┤
│  키           │  멤버  │  시작일      │  리더보드          │
│  ─────────────────────────────────────────────────────────  │
│  bootcamp-25  │  23    │  05/01 KST  │  [링크 복사] [→]   │
│  team-alpha   │  8     │  05/15 KST  │  [링크 복사] [→]   │
└─────────────────────────────────────────────────────────────┘

[새 코호트 만들기] 다이얼로그:
┌───────────────────────────────┐
│  코호트 키 (영문, 숫자, -_:)  │
│  [bootcamp-2026-q2         ]  │
│                               │
│  멤버 (선택사항)              │
│  [전체 active 사용자 ▾     ]  │
│  ○ 전체 active 사용자        │
│  ● 특정 사용자 선택           │
│  [멀티셀렉트 드롭다운]        │
│                               │
│  [취소]  [코호트 생성]        │
└───────────────────────────────┘
```

---

### 2.7 스킬 버전 히스토리 (스킬 편집 다이얼로그 내) — NEW

```
[기본 정보] [내용] [키워드] [버전 히스토리]  ← 탭 추가

버전 히스토리 탭:
┌─────────────────────────────────────────────────────────────┐
│  v5  2026-05-29 14:23  jake@zep.us  (현재)                  │
│  v4  2026-05-28 09:11  jane@zep.us  [이 버전으로 복원]      │
│  v3  2026-05-27 15:33  jake@zep.us  [이 버전으로 복원]      │
│  v2  2026-05-20 11:00  jake@zep.us  [이 버전으로 복원]      │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. API 계약서

### 3.1 세션 목록 API (확장)

```typescript
// GET /api/sessions
interface SessionListRequest {
  from?: string          // ISO date
  to?: string            // ISO date
  source?: SourceFilter  // 'all' | 'claude' | 'copilot' | 'opencode' | 'codex'
  keyword?: string       // 세션 내 이벤트 검색
  viewUser?: string      // 어드민만 — 조회할 사용자 UUID
  limit?: number         // default: 20, max: 100
  offset?: number        // default: 0
}

interface SessionListResponse {
  sessions: {
    session_id: string
    source: string
    started_at: string
    ended_at: string
    turn_count: number
    event_count: number
    total_cost: number
    input_tokens: number
    output_tokens: number
    is_closed: number
  }[]
  total: number
  hasMore: boolean
}
```

### 3.2 프롬프트 PATCH API (신규)

```typescript
// PATCH /api/prompts/[id]
interface PromptPatchRequest {
  promptType: 'natural' | 'skill' | 'command' | 'agent' | 'mcp_tool'
  invokedName?: string
}

interface PromptPatchResponse {
  success: true
  prompt_id: string
}

// 에러 응답
interface ErrorResponse {
  error: string
  // 에러 코드
  // 400: Invalid promptType
  // 401: Not authenticated
  // 404: Prompt not found
}
```

### 3.3 코호트 API (신규)

```typescript
// GET /api/admin/cohorts
interface CohortListResponse {
  cohorts: {
    cohortKey: string
    memberCount: number
    createdAt: string
    createdBy: string
    leaderboardUrl: string
  }[]
}

// DELETE /api/admin/cohorts/[key]/members/[userId]
// 204 No Content on success

// GET /api/admin/cohorts/[key]/members
interface CohortMembersResponse {
  cohortKey: string
  members: {
    userId: string
    email: string
    name: string | null
    joinedAt: string
  }[]
}
```

### 3.4 비용 예측 API (신규)

```typescript
// GET /api/cost-forecast
interface CostForecastResponse {
  currentMonthActual: number    // 이번 달 현재까지 실제 비용 (USD)
  forecastMonthEnd: number      // 월말 예상 비용 (USD)
  previousMonthTotal: number    // 지난달 총 비용 (USD)
  changePercent: number         // 전월 대비 변동율
  dataPoints: number            // 예측에 사용된 일수 (< 3이면 불신뢰)
  reliable: boolean             // dataPoints >= 3
}
```

### 3.5 헬스체크 API (신규)

```typescript
// GET /api/health
// 200 OK (정상) | 503 Service Unavailable (degraded)
interface HealthResponse {
  status: 'ok' | 'degraded'
  supabase: boolean
  clickhouse: boolean
  timestamp: string
}
```

### 3.6 스킬 제안 통계 API (신규)

```typescript
// GET /api/admin/analytics/skill-suggestions?days=30&team=all
interface SkillSuggestionStatsResponse {
  skills: {
    suggestedSkill: string
    suggestCount: number
    autoExecuteCount: number
    selectCount: number
    adoptionRate: number     // selectCount / suggestCount
    autoExecuteRate: number  // autoExecuteCount / suggestCount
    lastSuggested: string
  }[]
  period: { from: string; to: string }
}
```

---

## 4. 컴포넌트 목록 (신규 추가)

| 컴포넌트 | 위치 | 설명 |
|---------|------|------|
| `<CostForecastCard>` | `components/dashboard/cost-forecast.tsx` | 월말 예측 비용 카드 |
| `<FrustrationAlertBadge>` | `components/dashboard/frustration-badge.tsx` | 고좌절 세션 수 배지 |
| `<SessionFilterBar>` | `components/sessions/filter-bar.tsx` | 날짜/소스/키워드 필터 |
| `<CohortTable>` | `components/admin/cohort-table.tsx` | 코호트 목록 테이블 |
| `<CreateCohortDialog>` | `components/admin/create-cohort-dialog.tsx` | 코호트 생성 다이얼로그 |
| `<SkillVersionHistory>` | `components/admin/skill-version-history.tsx` | 스킬 버전 히스토리 탭 |
| `<SkillSuggestionTable>` | `components/admin/skill-suggestion-table.tsx` | 제안 효과 테이블 |
| `<PromptTypeIcon>` | `components/ui/prompt-type-icon.tsx` | 타입별 아이콘 컴포넌트 |

---

## 5. 네비게이션 구조 (최종)

```
사용자 메뉴:
  / (Dashboard)
  /sessions
  /prompts
  /prompts/frustration
  /leaderboard

어드민 추가 메뉴:
  /admin/analytics
  /admin/skills
  /admin/hooks
  /admin/mcp
  /admin/team
  /admin/cohorts     ← NEW
```
