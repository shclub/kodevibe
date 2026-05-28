# GitHub Copilot CLI Hook Support 구현

## 개요
Zeude 관측 가능성 플랫폼에서 GitHub Copilot CLI의 사용 데이터를 수집하기 위한 Hook 시스템 구현.

## 구현 배경

### Copilot CLI Hook 시스템
GitHub Copilot CLI는 Claude Code보다 더 강력한 Hook 시스템을 제공합니다:

- **설정 위치**: `~/.copilot/hooks/`
- **지원 이벤트**: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `permissionRequest`, `agentStop`, `subagentStop`, `notification`
- **Hook 타입**: 
  - `command`: bash/PowerShell 스크립트 실행
  - `http`: URL로 직접 POST (네이티브 지원)
  - `prompt`: 텍스트 자동 제출

### Claude Code vs Copilot CLI vs OpenCode 비교

| 도구 | Hook 시스템 | Plan/Act 구분 | HTTP Hook | zeude 현재 지원 |
|------|------------|---------------|-----------|----------------|
| Claude Code | ✅ (~/.claude/hooks/) | 🔶 Hook으로 간접 감지 | ❌ | ✅ 구현됨 |
| Copilot CLI | ✅ (~/.copilot/hooks/) | ✅ (이벤트 직접) | ✅ 네이티브 지원 | ✅ **신규 구현** |
| OpenCode | ❌ | ✅ SQLite에 직접 기록 | - | ✅ SQLite 읽기 |

## 구현 내용

### 1. Logo Size 변경
- **파일**: `zeude/dashboard/src/app/(dashboard)/layout.tsx`
- **변경**: `className="h-10"` → `className="h-14"` (약 40% 확대)
- **Tailwind 클래스**: h-10=40px, h-14=56px

### 2. Copilot Hook Sync 함수 구현

#### SyncCopilotHooks() 함수
**파일**: `zeude/internal/mcpconfig/companions.go`

```go
// SyncCopilotHooks writes Zeude-managed hooks into ~/.copilot/hooks/zeude.json.
// Copilot hook format: { "version": 1, "hooks": { "eventName": [{"type": "http", "url": "..."}] } }
func SyncCopilotHooks(hooks []Hook, agentKey, dashboardURL string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	hooksDir := filepath.Join(home, ".copilot", "hooks")
	if err := os.MkdirAll(hooksDir, 0755); err != nil {
		return err
	}

	// Build hooks config
	type copilotHook struct {
		Type       string `json:"type"`
		URL        string `json:"url,omitempty"`
		Bash       string `json:"bash,omitempty"`
		TimeoutSec int    `json:"timeoutSec,omitempty"`
	}

	hooksConfig := map[string][]copilotHook{}

	for _, hook := range hooks {
		// Convert Zeude hook events to Copilot hook events
		copilotEvent := ""
		switch hook.Event {
		case "UserPromptSubmit":
			copilotEvent = "userPromptSubmitted"
		case "PreToolUse":
			copilotEvent = "preToolUse"
		case "PostToolUse":
			copilotEvent = "postToolUse"
		case "Stop":
			copilotEvent = "sessionEnd"
		case "Notification":
			copilotEvent = "notification"
		case "SubagentStop":
			copilotEvent = "subagentStop"
		default:
			continue
		}

		// Create HTTP hook that posts to zeude server
		hooksConfig[copilotEvent] = append(hooksConfig[copilotEvent], copilotHook{
			Type:       "http",
			URL:        fmt.Sprintf("%s/api/hook/copilot", dashboardURL),
			TimeoutSec: 5,
		})
	}

	// Build final config
	config := map[string]interface{}{
		"version": 1,
		"hooks":   hooksConfig,
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	configPath := filepath.Join(hooksDir, "zeude.json")
	return writeFileAtomic(configPath, data, 0644)
}
```

### 3. SyncResult 구조체 확장

**파일**: `zeude/internal/mcpconfig/sync.go`

```go
type SyncResult struct {
	UserID      string
	UserEmail   string
	Team        string
	Banner      string
	Prefix      string
	MCPServers  map[string]MCPServer
	Hooks       []Hook              // ← 추가: Hooks for Copilot CLI
	Success     bool
	ServerCount int
	SkillCount  int
	HookCount   int
	AgentCount  int
	FromCache   bool
	NoAgentKey  bool
}
```

### 4. Copilot Shim 수정

**파일**: `zeude/cmd/copilot/main.go`

#### Hook Sync 호출 추가
```go
// 3. Write Copilot hooks
if syncResult.Success && len(syncResult.Hooks) > 0 {
	agentKey := getAgentKey()
	if agentKey != "" {
		if err := mcpconfig.SyncCopilotHooks(syncResult.Hooks, agentKey, getDashboardURL()); err != nil {
			fmt.Fprintf(os.Stderr, "[%s] warning: copilot hooks sync failed: %v\n", prefix, err)
		}
	}
}
```

#### Helper 함수 추가
```go
// getDashboardURL returns the dashboard URL from env, config file, or default.
func getDashboardURL() string {
	if url := os.Getenv("ZEUDE_DASHBOARD_URL"); url != "" {
		return strings.TrimSuffix(url, "/")
	}
	// Read from ~/.zeude/config (dashboard_url= line)
	home, err := os.UserHomeDir()
	if err == nil {
		if data, err := os.ReadFile(filepath.Join(home, ".zeude", "config")); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "dashboard_url=") {
					if url := strings.TrimSpace(strings.TrimPrefix(line, "dashboard_url=")); url != "" {
						return strings.TrimSuffix(url, "/")
					}
				}
			}
		}
	}
	return config.DefaultDashboardURL
}

// getAgentKey reads the agent key from ~/.zeude/credentials.
func getAgentKey() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	credPath := filepath.Join(home, ".zeude", "credentials")
	data, err := os.ReadFile(credPath)
	if err != nil {
		return ""
	}

	// Parse credentials file (format: agent_key=zd_xxx)
	content := strings.ReplaceAll(string(data), "\r\n", "\n")
	content = strings.ReplaceAll(content, "\r", "\n")
	lines := strings.Split(content, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "agent_key=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "agent_key="))
		}
		// Also handle "agent_key = value" format
		if strings.HasPrefix(line, "agent_key") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}

	return ""
}
```

## Hook 이벤트 매핑

| Zeude Hook 이벤트 | Copilot CLI 이벤트 | 설명 |
|------------------|-------------------|------|
| `UserPromptSubmit` | `userPromptSubmitted` | 프롬프트 제출 시 |
| `PreToolUse` | `preToolUse` | 툴 실행 직전 |
| `PostToolUse` | `postToolUse` | 툴 실행 직후 |
| `Stop` | `sessionEnd` | 세션 종료 시 |
| `Notification` | `notification` | 알림 이벤트 |
| `SubagentStop` | `subagentStop` | 서브에이전트 완료 |

## 생성되는 Hook 설정 파일

**위치**: `~/.copilot/hooks/zeude.json`

```json
{
  "version": 1,
  "hooks": {
    "userPromptSubmitted": [
      {
        "type": "http",
        "url": "https://your-dashboard-url/api/hook/copilot",
        "timeoutSec": 5
      }
    ],
    "preToolUse": [
      {
        "type": "http",
        "url": "https://your-dashboard-url/api/hook/copilot",
        "timeoutSec": 5
      }
    ],
    "postToolUse": [
      {
        "type": "http",
        "url": "https://your-dashboard-url/api/hook/copilot",
        "timeoutSec": 5
      }
    ],
    "sessionEnd": [
      {
        "type": "http",
        "url": "https://your-dashboard-url/api/hook/copilot",
        "timeoutSec": 5
      }
    ],
    "notification": [
      {
        "type": "http",
        "url": "https://your-dashboard-url/api/hook/copilot",
        "timeoutSec": 5
      }
    ],
    "subagentStop": [
      {
        "type": "http",
        "url": "https://your-dashboard-url/api/hook/copilot",
        "timeoutSec": 5
      }
    ]
  }
}
```

## 빌드 및 배포

### Dashboard 빌드
```bash
cd /Users/jakelee/observability/zeude/zeude/dashboard
rm -rf .next
POSTGRES_PASSWORD=postgres CLICKHOUSE_PASSWORD=clickhouse pnpm run build
```

### Copilot Shim 빌드
```bash
cd /Users/jakelee/observability/zeude/zeude
go build -o ~/.zeude/bin/copilot ./cmd/copilot/
```

### Docker Compose 재시작
```bash
cd /Users/jakelee/observability/zeude
docker compose -f docker-compose.mac.yaml up -d --build dashboard
```

## 다음 단계

### 1. Dashboard Hook 수신 API 구현
Copilot HTTP hook을 수신할 API endpoint 구현 필요:
- **Endpoint**: `POST /api/hook/copilot`
- **기능**: Copilot CLI로부터의 HTTP POST 수신 및 OTel로 변환

### 2. OpenCode Plan/Build Mode 수집
`session_report.go`에 message 레벨 plan/build 집계 추가:
```sql
SELECT
  json_extract(data, '$.mode') as mode,
  COUNT(*) as turns,
  SUM(json_extract(data, '$.tokens.input')) as input_tokens,
  SUM(json_extract(data, '$.tokens.output')) as output_tokens
FROM message
WHERE session_id = {sessionId}
GROUP BY mode
```

### 3. Dashboard UI 개선
- Plan/Build 모드별 토큰 사용량 시각화
- Copilot 프롬프트 내용 표시
- Hook 수집 상태 모니터링

## 파일 변경 목록

1. `zeude/dashboard/src/app/(dashboard)/layout.tsx` - Logo size 변경
2. `zeude/internal/mcpconfig/companions.go` - SyncCopilotHooks() 함수 추가
3. `zeude/internal/mcpconfig/sync.go` - SyncResult.Hooks 필드 추가
4. `zeude/cmd/copilot/main.go` - Hook sync 호출 및 helper 함수 추가

## 참고 자료

- [GitHub Copilot Hooks Reference](https://docs.github.com/en/copilot/reference/hooks-configuration)
- hook.md - Copilot CLI hook 시스템 분석 내용
