# Test Plan — Zeude

---

## 1. 테스트 전략 개요

| 레이어 | 도구 | 커버리지 목표 |
|--------|------|-------------|
| 단위 테스트 | Vitest (TS), Go `testing` | 비즈니스 로직 80%+ |
| 통합 테스트 | Vitest + Supabase local, ClickHouse test container | API Route 핵심 경로 |
| E2E 테스트 | Playwright | 주요 사용자 플로우 5개 |
| 성능 테스트 | k6 | Shim startup < 100ms |

---

## 2. 단위 테스트

### 2.1 `prompt-utils.ts` — detectPromptType

이미 `file-validation.test.ts` 패턴 참고하여 작성.

```typescript
// dashboard/src/lib/prompt-utils.test.ts

describe('detectPromptType', () => {
  // Natural language
  it('일반 문장은 natural 반환', () => {
    expect(detectPromptType('zeude cohort 기능 설명해줘')).toEqual({
      promptType: 'natural', invokedName: ''
    })
  })

  // Skill
  it('/skill-name은 skill 반환', () => {
    expect(detectPromptType('/code-review --fix')).toEqual({
      promptType: 'skill', invokedName: 'code-review'
    })
  })

  it('네임스페이스 스킬 /ns:skill은 skill 반환', () => {
    expect(detectPromptType('/bmad:workflow')).toEqual({
      promptType: 'skill', invokedName: 'bmad:workflow'
    })
  })

  // Built-in command
  it('/help는 command 반환', () => {
    expect(detectPromptType('/help')).toEqual({
      promptType: 'command', invokedName: 'help'
    })
  })

  it('/clear는 command 반환', () => {
    expect(detectPromptType('/clear')).toEqual({
      promptType: 'command', invokedName: 'clear'
    })
  })

  // Edge cases
  it('빈 문자열은 natural 반환', () => {
    expect(detectPromptType('')).toEqual({
      promptType: 'natural', invokedName: ''
    })
  })

  it('슬래시만 있으면 natural 반환', () => {
    expect(detectPromptType('/')).toEqual({
      promptType: 'natural', invokedName: ''
    })
  })
})

describe('sanitizeCohortKey', () => {
  it('URL-safe 문자만 허용', () => {
    expect(sanitizeCohortKey('bootcamp-2025')).toBe('bootcamp-2025')
  })

  it('특수문자 제거', () => {
    expect(sanitizeCohortKey('team<script>')).toBe('teamscript')
  })

  it('64자 초과 잘림', () => {
    expect(sanitizeCohortKey('a'.repeat(100))).toHaveLength(64)
  })
})
```

---

### 2.2 `prompt-analytics.ts` — buildUserWhereClause

```typescript
describe('buildUserWhereClause', () => {
  it('userId만 있으면 user_id 조건', () => {
    const { clause } = buildUserWhereClause({ userId: 'u1' })
    expect(clause).toBe('user_id = {userId:String}')
  })

  it('userEmail만 있으면 user_email 조건', () => {
    const { clause } = buildUserWhereClause({ userEmail: 'a@b.com' })
    expect(clause).toBe('user_email = {userEmail:String}')
  })

  it('둘 다 있으면 OR 조건', () => {
    const { clause } = buildUserWhereClause({ userId: 'u1', userEmail: 'a@b.com' })
    expect(clause).toContain('OR')
  })

  it('둘 다 없으면 항상 false 조건', () => {
    const { clause } = buildUserWhereClause({})
    expect(clause).toBe('1 = 0')
  })
})
```

---

### 2.3 Go 단위 테스트 — `internal/otlplog`

```go
// internal/otlplog/otlplog_test.go

func TestSendTokenUsage_EmptyEndpoint(t *testing.T) {
  // endpoint가 없으면 즉시 리턴 (패닉 없음)
  SendTokenUsage(TokenUsageParams{
    Endpoint: "",
    Service: "test",
    InputTokens: 100,
  })
  // 패닉 없이 완료되면 성공
}

func TestSendTokenUsage_ZeroTokens(t *testing.T) {
  // 0 토큰이면 즉시 리턴
  called := false
  // HTTP mock으로 검증
  SendTokenUsage(TokenUsageParams{
    Endpoint: "http://mock",
    Service: "test",
    InputTokens: 0,
    OutputTokens: 0,
    PremiumRequests: 0,
  })
  assert.False(t, called, "0 토큰이면 HTTP 요청 안 함")
}

func TestSanitizeCohortKey(t *testing.T) {
  // Go 쪽은 대시보드와 동일한 로직이 없으나
  // 만약 Go로 이식 시 동일 테스트 적용
}
```

---

### 2.4 Go 단위 테스트 — `internal/identity`

```go
func TestResolveIdentity_NoAgentKey(t *testing.T) {
  // ZEUDE_AGENT_KEY 없고 credentials 파일 없을 때
  // NoAgentKey: true 반환
  identity := ResolveIdentity()
  assert.True(t, identity.NoAgentKey)
}

func TestResolveIdentity_InvalidAgentKey(t *testing.T) {
  // 잘못된 형식의 agent key
  os.Setenv("ZEUDE_AGENT_KEY", "invalid")
  defer os.Unsetenv("ZEUDE_AGENT_KEY")
  identity := ResolveIdentity()
  assert.True(t, identity.NoAgentKey)
}
```

---

## 3. 통합 테스트

### 3.1 `/api/prompts` — POST (프롬프트 수집)

```typescript
// dashboard/src/app/api/prompts/route.test.ts

describe('POST /api/prompts', () => {
  it('유효한 프롬프트 저장 성공', async () => {
    const res = await POST(new Request('http://localhost/api/prompts', {
      method: 'POST',
      body: JSON.stringify({
        prompt: '/code-review --fix',
        sessionId: 'test-session',
        cwd: '/Users/test/project',
      }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.prompt_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('prompt 없으면 400', async () => {
    const res = await POST(new Request('...', {
      method: 'POST',
      body: JSON.stringify({}),
    }))
    expect(res.status).toBe(400)
  })

  it('잘못된 UUID promptId는 400', async () => {
    const res = await POST(new Request('...', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello', promptId: 'not-a-uuid' }),
    }))
    expect(res.status).toBe(400)
  })

  it('skill 타입 자동 감지', async () => {
    const res = await POST(...)  // prompt: '/zeude'
    // ClickHouse에 prompt_type = 'skill' 저장 검증
  })
})
```

---

### 3.2 `/api/admin/cohorts` — POST (코호트 생성)

```typescript
describe('POST /api/admin/cohorts', () => {
  it('어드민만 생성 가능', async () => {
    // member 세션으로 요청
    const res = await POST(memberSession, { cohortKey: 'test' })
    expect(res.status).toBe(403)
  })

  it('cohortKey 최소 3자', async () => {
    const res = await POST(adminSession, { cohortKey: 'ab' })
    expect(res.status).toBe(400)
  })

  it('정상 생성 후 leaderboardUrl 반환', async () => {
    const res = await POST(adminSession, { cohortKey: 'test-cohort' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.leaderboardUrl).toBe('/leaderboard?cohort=test-cohort')
    expect(body.totalMembers).toBeGreaterThan(0)
  })

  it('특수문자 cohortKey 정제', async () => {
    const res = await POST(adminSession, { cohortKey: 'test<xss>' })
    const body = await res.json()
    expect(body.cohortKey).toBe('testxss')
  })
})
```

---

### 3.3 `/api/leaderboard` — 코호트 필터링

```typescript
describe('GET /api/leaderboard', () => {
  it('cohort 없으면 주간 윈도우 기준', async () => {
    const res = await GET('?source=claude')
    const body = await res.json()
    expect(body.cohort).toBeUndefined()
    expect(body.weekWindow).toBeDefined()
  })

  it('존재하는 cohort는 코호트 데이터 반환', async () => {
    // 코호트 생성 후 조회
    const res = await GET('?cohort=test-cohort')
    const body = await res.json()
    expect(body.cohort.cohortKey).toBe('test-cohort')
    expect(body.cohort.memberCount).toBeGreaterThan(0)
  })

  it('멤버 0인 cohort는 빈 리더보드', async () => {
    const res = await GET('?cohort=empty-cohort')
    const body = await res.json()
    expect(body.topTokenUsers).toHaveLength(0)
    expect(body.cohort.memberCount).toBe(0)
  })
})
```

---

### 3.4 Go 통합 테스트 — Shim Startup

```go
// internal/oteltest/shim_startup_test.go

func TestShimStartup_UnderHundredMs(t *testing.T) {
  // FastSync with warm cache
  start := time.Now()
  result, _ := mcpconfig.FastSync()
  elapsed := time.Since(start)

  assert.Less(t, elapsed, 100*time.Millisecond,
    "캐시 히트 시 100ms 미만이어야 함")
  _ = result
}

func TestShimStartup_FailOpen(t *testing.T) {
  // 네트워크 없는 환경에서도 실행 가능
  os.Setenv("ZEUDE_ENDPOINT", "http://non-existent-host:9999")
  defer os.Unsetenv("ZEUDE_ENDPOINT")

  // panic 없이 완료 (fail-open)
  result, _ := mcpconfig.FastSync()
  assert.NotNil(t, result)
}
```

---

## 4. E2E 테스트 (Playwright)

### 4.1 로그인 플로우

```typescript
// e2e/auth.spec.ts
test('OTT 로그인 성공', async ({ page }) => {
  // 1. /auth 페이지 접근
  await page.goto('/auth')
  // 2. 이메일 입력
  await page.fill('[data-testid=email-input]', 'test@zep.us')
  await page.click('[data-testid=send-ott-btn]')
  // 3. OTT 입력 (테스트 환경에서 이메일 수신 모킹)
  await page.fill('[data-testid=ott-input]', TEST_OTT)
  await page.click('[data-testid=verify-btn]')
  // 4. 대시보드 리다이렉트 확인
  await expect(page).toHaveURL('/')
  await expect(page.locator('h1')).toContainText('Dashboard')
})
```

### 4.2 세션 상세 조회

```typescript
test('세션 목록에서 상세 페이지 이동', async ({ page }) => {
  await page.goto('/sessions')
  // 첫 번째 세션 클릭
  await page.click('[data-testid=session-row]:first-child')
  // 상세 페이지 확인
  await expect(page).toHaveURL(/\/sessions\/[a-f0-9-]+/)
  await expect(page.locator('[data-testid=turn-card]')).toHaveCountGreaterThan(0)
})
```

### 4.3 스킬 생성 및 배포 확인

```typescript
test('어드민이 스킬 생성 후 목록에 표시', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/admin/skills')
  await page.click('[data-testid=new-skill-btn]')
  await page.fill('[data-testid=skill-name]', 'Test Skill')
  await page.fill('[data-testid=skill-slug]', 'test-skill')
  await page.fill('[data-testid=skill-content]', '# Test\nHello world')
  await page.click('[data-testid=save-skill-btn]')
  // 목록에 새 스킬 표시
  await expect(page.locator('text=Test Skill')).toBeVisible()
})
```

### 4.4 리더보드 코호트 필터

```typescript
test('코호트 URL로 필터된 리더보드 표시', async ({ page }) => {
  await page.goto('/leaderboard?cohort=bootcamp-2025')
  await expect(page.locator('[data-testid=cohort-badge]')).toContainText('bootcamp-2025')
  await expect(page.locator('[data-testid=leaderboard-title]')).toContainText('Cohort scoped')
})
```

### 4.5 소스 필터 동작

```typescript
test('소스 필터 변경 시 데이터 갱신', async ({ page }) => {
  await page.goto('/')
  const initialToken = await page.locator('[data-testid=token-count]').textContent()
  // Copilot으로 필터 변경
  await page.selectOption('[data-testid=source-filter]', 'copilot')
  await page.waitForResponse('/api/analytics*')
  const newToken = await page.locator('[data-testid=token-count]').textContent()
  // 값이 변경되었거나 (소스 데이터 있는 경우) 0으로 변경됨
  expect(newToken).not.toBeNull()
})
```

---

## 5. 성능 테스트

### 5.1 Shim Startup (k6 불필요, Go benchmark 사용)

```go
func BenchmarkFastSync(b *testing.B) {
  // 캐시 워밍
  mcpconfig.FastSync()

  b.ResetTimer()
  for i := 0; i < b.N; i++ {
    mcpconfig.FastSync()
  }
  // 목표: < 10ms/op (캐시 히트)
}
```

### 5.2 ClickHouse 쿼리 성능 (k6)

```javascript
// perf/leaderboard.js
import http from 'k6/http'
import { check } from 'k6'

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<2000'],  // 95%ile < 2초
    http_req_failed: ['rate<0.01'],      // 오류율 < 1%
  },
}

export default function () {
  const res = http.get('https://your-dashboard/api/leaderboard', {
    headers: { Cookie: `session=${SESSION_TOKEN}` },
  })
  check(res, {
    'status 200': r => r.status === 200,
    'has topTokenUsers': r => JSON.parse(r.body).topTokenUsers !== undefined,
  })
}
```

---

## 6. 테스트 환경 구성

### 로컬 테스트 환경

```bash
# ClickHouse 로컬 실행
docker-compose -f docker-compose.mac.yaml up clickhouse -d

# Supabase 로컬 실행
npx supabase start

# 테스트 실행
pnpm test              # Vitest (단위 + 통합)
pnpm test:e2e          # Playwright E2E
go test ./...          # Go 단위 테스트
go test -bench=. ./... # Go 벤치마크
```

### CI 환경 (GitHub Actions)

```yaml
# .github/workflows/test.yml
jobs:
  test:
    services:
      clickhouse:
        image: clickhouse/clickhouse-server:23
        ports: ['8123:8123']
    steps:
      - run: pnpm test --coverage
      - run: go test ./...
      - run: pnpm test:e2e
        env:
          PLAYWRIGHT_BASE_URL: http://localhost:3000
```

---

## 7. 테스트 커버리지 기준

| 모듈 | 목표 커버리지 | 비고 |
|------|-------------|------|
| `lib/prompt-utils.ts` | 100% | 핵심 분류 로직 |
| `lib/prompt-analytics.ts` | 70% | DB 의존성 제외 |
| `app/api/prompts/` | 80% | 통합 테스트 포함 |
| `app/api/admin/cohorts/` | 80% | 통합 테스트 포함 |
| `app/api/leaderboard/` | 70% | ClickHouse 의존 |
| `internal/otlplog/` | 90% | Go 단위 테스트 |
| `internal/identity/` | 80% | Go 단위 테스트 |
| `internal/mcpconfig/` | 70% | 파일시스템 의존 |

---

## 8. 알려진 테스트 불가 영역

| 영역 | 이유 | 대안 |
|------|------|------|
| OTel 텔레메트리 수집 end-to-end | Claude Code 실제 실행 필요 | oteltest 패키지의 integration test 활용 |
| Shim exec() 이후 동작 | exec()은 프로세스 교체라 mock 불가 | exec 전까지만 테스트 |
| ClickHouse MV 실시간 반영 | 비동기 처리 | FINAL 키워드 또는 수동 OPTIMIZE 후 확인 |
| 이메일 기반 OTT 발송 | 외부 메일 서버 필요 | 테스트 환경에서 OTT DB 직접 삽입 |
