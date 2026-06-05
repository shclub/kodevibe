package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/zeude/zeude/internal/config"
	"github.com/zeude/zeude/internal/mcpconfig"
	"github.com/zeude/zeude/internal/otlplog"
)

// openCodeDBPath returns ~/.local/share/opencode/opencode.db
func openCodeDBPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "opencode", "opencode.db")
}

// openCodeTurn holds one user→assistant exchange from OpenCode.
type openCodeTurn struct {
	sessionID       string
	userMessageID   string // used as prompt.id for turn grouping in dashboard
	model           string
	promptText      string
	responseText    string
	inputTokens     int64
	outputTokens    int64
	cacheReadTokens int64
	timestampMs     int64
}

// runSQLite executes a query against dbPath via the sqlite3 CLI.
// Uses readonly mode to avoid blocking OpenCode's writes.
func runSQLite(dbPath, query string) ([][]string, error) {
	out, err := exec.Command("sqlite3", "-readonly", "-separator", "\t", dbPath, query).Output()
	if err != nil {
		return nil, err
	}
	var rows [][]string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		rows = append(rows, strings.Split(line, "\t"))
	}
	return rows, nil
}

// readTurnsSince reads user→assistant turn pairs from messages created after sinceMs.
// Filters directly on message.time_created to avoid depending on session.time_updated
// which may not be updated before opencode exits.
func readTurnsSince(dbPath string, sinceMs int64) ([]openCodeTurn, error) {
	query := fmt.Sprintf(`
SELECT
  m.session_id,
  m.id,
  COALESCE(json_extract(m.data,'$.role'),''),
  COALESCE(json_extract(m.data,'$.modelID'),''),
  COALESCE(CAST(json_extract(m.data,'$.tokens.input')  AS INTEGER),0),
  COALESCE(CAST(json_extract(m.data,'$.tokens.output') AS INTEGER),0),
  COALESCE(CAST(json_extract(m.data,'$.tokens.cache.read') AS INTEGER),0),
  COALESCE((SELECT json_extract(p.data,'$.text') FROM part p
             WHERE p.message_id=m.id AND json_extract(p.data,'$.type')='text'
             ORDER BY p.time_created LIMIT 1),''),
  m.time_created
	  COALESCE((SELECT json_extract(p.data,'$.text') FROM part p
	             WHERE p.message_id=m.id AND json_extract(p.data,'$.type')='response'
	             ORDER BY p.time_created LIMIT 1),''),
FROM message m
WHERE m.time_created >= %d
ORDER BY m.session_id, m.time_created
`, sinceMs)

	rows, err := runSQLite(dbPath, query)
	if err != nil {
		return nil, err
	}

	type msgRow struct {
		sessionID   string
		id          string
		role        string
		model       string
		inputTok    int64
		outputTok   int64
		cacheRead   int64
		text        string
			responseText string
		timeCreated int64
	}

	var msgs []msgRow
	for _, row := range rows {
		if len(row) < 10 {
			continue
		}
		msgs = append(msgs, msgRow{
			sessionID:   row[0],
			id:          row[1],
			role:        row[2],
			model:       row[3],
			inputTok:    parseInt64(row[4]),
			outputTok:   parseInt64(row[5]),
			cacheRead:   parseInt64(row[6]),
			text:        row[7],
			timeCreated: parseInt64(row[8]),
			responseText: row[9],
		})
	}

	// Pair each user message with the immediately following assistant message.
	var turns []openCodeTurn
	for i, msg := range msgs {
		if msg.role != "user" {
			continue
		}
		for j := i + 1; j < len(msgs); j++ {
			next := msgs[j]
			if next.sessionID != msg.sessionID {
				break
			}
			if next.role == "user" {
				break
			}
			if next.role == "assistant" && (next.outputTok > 0 || next.inputTok > 0) {
				turns = append(turns, openCodeTurn{
					sessionID:       msg.sessionID,
					userMessageID:   msg.id,
					model:           next.model,
					promptText:      msg.text,
						responseText:    next.responseText,
					inputTokens:     next.inputTok,
					outputTokens:    next.outputTok,
					cacheReadTokens: next.cacheRead,
					timestampMs:     next.timeCreated,
				})
				break
			}
		}
	}
	return turns, nil
}

// reportOpenCodeSessions reads turn data from OpenCode's SQLite and sends OTel events.
func reportOpenCodeSessions(syncResult mcpconfig.SyncResult, endpoint string, sinceMs int64) {
	dbPath := openCodeDBPath()
	if dbPath == "" {
		return
	}
	if _, err := os.Stat(dbPath); err != nil {
		return
	}

	// Give opencode a moment to flush WAL before reading.
	// OpenCode may write token data asynchronously just before exit.
	time.Sleep(500 * time.Millisecond)

	var turns []openCodeTurn
	var err error

	// Retry up to 3 times: token writes may lag slightly behind process exit.
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 200 * time.Millisecond)
		}
		turns, err = readTurnsSince(dbPath, sinceMs)
		if err != nil {
			break
		}
		if len(turns) > 0 {
			break
		}
	}

	if len(turns) == 0 {
		return
	}

	if endpoint == "" {
		endpoint = config.GetCollectorEndpoint(config.DefaultCollectorEndpoint)
	}

	// Check if response collection is enabled for opencode
	collectResponse := config.GetCollectResponse("opencode", true)

	for _, turn := range turns {
		// Only include response if enabled
		responseText := ""
		if collectResponse {
			responseText = turn.responseText
		}
		otlplog.SendTokenUsage(otlplog.TokenUsageParams{
			Endpoint:        endpoint,
			Service:         "opencode",
			UserID:          syncResult.UserID,
			UserEmail:       syncResult.UserEmail,
			Team:            syncResult.Team,
			SessionID:       turn.sessionID,
			PromptID:        turn.userMessageID,
			Model:           turn.model,
			Prompt:          turn.promptText,
				Response:       responseText,
			InputTokens:     turn.inputTokens,
			OutputTokens:    turn.outputTokens,
			CacheReadTokens: turn.cacheReadTokens,
			Timestamp:       time.UnixMilli(turn.timestampMs),
		})

	}
}

func parseInt64(s string) int64 {
	var v int64
	fmt.Sscan(s, &v)
	return v
}
