package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/zeude/zeude/internal/config"
	"github.com/zeude/zeude/internal/mcpconfig"
	"github.com/zeude/zeude/internal/otlplog"
)

// copilotEvent represents a single line from events.jsonl.
type copilotEvent struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Timestamp string          `json:"timestamp"`
	Data      json.RawMessage `json:"data"`
}

// assistantMessageData holds token/model info from assistant.message events.
type assistantMessageData struct {
	Model         string `json:"model"`
	OutputTokens  int64  `json:"outputTokens"`
	InteractionID string `json:"interactionId"`
}

// userMessageData holds prompt text from user.message events.
type userMessageData struct {
	Content       string `json:"content"`
	InteractionID string `json:"interactionId"`
}

// sessionStartData holds session start info.
type sessionStartData struct {
	SessionID string `json:"sessionId"`
	StartTime string `json:"startTime"`
}

// sessionShutdownData holds full session metrics from session.shutdown event.
type sessionShutdownData struct {
	ShutdownType         string                       `json:"shutdownType"`
	TotalPremiumRequests int64                        `json:"totalPremiumRequests"`
	TotalApiDurationMs   int64                        `json:"totalApiDurationMs"`
	CodeChanges          shutdownCodeChanges          `json:"codeChanges"`
	ModelMetrics         map[string]shutdownModelInfo  `json:"modelMetrics"`
	CurrentTokens        int64                        `json:"currentTokens"`
	SystemTokens         int64                        `json:"systemTokens"`
	ConversationTokens   int64                        `json:"conversationTokens"`
	ToolDefinitionsTokens int64                       `json:"toolDefinitionsTokens"`
}

type shutdownCodeChanges struct {
	LinesAdded    int64    `json:"linesAdded"`
	LinesRemoved  int64    `json:"linesRemoved"`
	FilesModified []string `json:"filesModified"`
}

type shutdownModelInfo struct {
	Requests    shutdownRequests `json:"requests"`
	Usage       shutdownUsage    `json:"usage"`
	TotalNanoAiu int64           `json:"totalNanoAiu"`
}

type shutdownRequests struct {
	Count int64 `json:"count"`
	Cost  int64 `json:"cost"`
}

type shutdownUsage struct {
	InputTokens      int64 `json:"inputTokens"`
	OutputTokens     int64 `json:"outputTokens"`
	CacheReadTokens  int64 `json:"cacheReadTokens"`
	CacheWriteTokens int64 `json:"cacheWriteTokens"`
	ReasoningTokens  int64 `json:"reasoningTokens"`
}

// sessionSummary holds key metrics shown in the end-of-session banner.
type sessionSummary struct {
	premiumRequests int64
	inputTokens     int64
	outputTokens    int64
	cacheReadTokens int64
	durationMs      int64
	linesAdded      int64
	linesRemoved    int64
	apiCalls        int64
	model           string
}

// copilotSessionStateDir returns the path to ~/.copilot/session-state.
func copilotSessionStateDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".copilot", "session-state")
}

// fileOffset tracks how much of an events.jsonl file the real-time watcher has processed.
type fileOffset struct {
	offset            int64
	lastUserMsg       string
	lastInteractionID string
	sessionID         string
	model             string
	assistantMsgCount int64 // estimated premium request count
}

// watchCopilotSessions polls session-state directories for new events
// and sends real-time telemetry as they appear. Runs until stopCh is closed,
// then does one final read before returning.
func watchCopilotSessions(syncResult mcpconfig.SyncResult, endpoint string, sinceMs int64, stopCh <-chan struct{}, summary *sessionSummary) {
	stateDir := copilotSessionStateDir()
	if stateDir == "" {
		return
	}
	if endpoint == "" {
		endpoint = config.GetCollectorEndpoint(config.DefaultCollectorEndpoint)
	}

	offsets := map[string]*fileOffset{}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		readNewEvents(stateDir, offsets, syncResult, endpoint, sinceMs, summary)

		select {
		case <-stopCh:
			readNewEvents(stateDir, offsets, syncResult, endpoint, sinceMs, summary)
			return
		case <-ticker.C:
		}
	}
}

// readNewEvents reads unprocessed lines from all events.jsonl files
// and sends token usage telemetry for new events.
func readNewEvents(stateDir string, offsets map[string]*fileOffset, syncResult mcpconfig.SyncResult, endpoint string, sinceMs int64, summary *sessionSummary) {
	sinceTime := time.UnixMilli(sinceMs)

	entries, err := os.ReadDir(stateDir)
	if err != nil {
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		eventsPath := filepath.Join(stateDir, entry.Name(), "events.jsonl")

		info, err := os.Stat(eventsPath)
		if err != nil {
			continue
		}
		if info.ModTime().Before(sinceTime) {
			continue
		}

		f, err := os.Open(eventsPath)
		if err != nil {
			continue
		}

		fo, ok := offsets[eventsPath]
		if !ok {
			fo = &fileOffset{}
			offsets[eventsPath] = fo
		}

		if info.Size() < fo.offset {
			fo.offset = 0
		}

		f.Seek(fo.offset, io.SeekStart)
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

		for scanner.Scan() {
			var ev copilotEvent
			if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
				break
			}

			switch ev.Type {
			case "session.start":
				var d sessionStartData
				if err := json.Unmarshal(ev.Data, &d); err == nil {
					fo.sessionID = d.SessionID
				}

			case "user.message":
				var d userMessageData
				if err := json.Unmarshal(ev.Data, &d); err == nil {
					fo.lastUserMsg = d.Content
					fo.lastInteractionID = d.InteractionID
				}

			case "assistant.message":
				var d assistantMessageData
				if err := json.Unmarshal(ev.Data, &d); err == nil {
					if d.Model != "" {

						fo.assistantMsgCount++
					}
					sid := fo.sessionID
					if sid == "" {
						sid = entry.Name()
					}
					ts := time.Now()
					if t, err := time.Parse(time.RFC3339Nano, ev.Timestamp); err == nil {
						ts = t
					}
					pid := fo.lastInteractionID
					if pid == "" {
						pid = d.InteractionID
					}
					otlplog.SendTokenUsage(otlplog.TokenUsageParams{
						Endpoint:     endpoint,
						Service:      "copilot",
						UserID:       syncResult.UserID,
						UserEmail:    syncResult.UserEmail,
						Team:         syncResult.Team,
						SessionID:    sid,
						Model:        fo.model,
						PromptID:     pid,
						Prompt:       fo.lastUserMsg,
						OutputTokens: d.OutputTokens,
						PremiumRequests: fo.assistantMsgCount,
						Timestamp:    ts,
					})
					fo.lastUserMsg = ""
					fo.lastInteractionID = ""
				}

			case "session.shutdown":
				var d sessionShutdownData
				if err := json.Unmarshal(ev.Data, &d); err == nil {
					sid := fo.sessionID
					if sid == "" {
						sid = entry.Name()
					}

					// Send per-model metrics
					for model, mm := range d.ModelMetrics {
						otlplog.SendTokenUsage(otlplog.TokenUsageParams{
							Endpoint:         endpoint,
							Service:          "copilot",
							UserID:           syncResult.UserID,
							UserEmail:        syncResult.UserEmail,
							Team:             syncResult.Team,
							SessionID:        sid,
							Model:            model,
							PromptID:         "shutdown",
							InputTokens:      mm.Usage.InputTokens,
							OutputTokens:     mm.Usage.OutputTokens,
							CacheReadTokens:  mm.Usage.CacheReadTokens,
							CacheWriteTokens: mm.Usage.CacheWriteTokens,
							PremiumRequests:  mm.Requests.Cost,
							DurationMs:       d.TotalApiDurationMs,
							Timestamp:        time.Now(),
						})
					}

					// Populate summary for end-of-session banner
					if summary != nil {
						summary.premiumRequests = d.TotalPremiumRequests
						summary.durationMs = d.TotalApiDurationMs
						summary.linesAdded = d.CodeChanges.LinesAdded
						summary.linesRemoved = d.CodeChanges.LinesRemoved
						summary.model = fo.model
						for _, mm := range d.ModelMetrics {
							summary.inputTokens += mm.Usage.InputTokens
							summary.outputTokens += mm.Usage.OutputTokens
							summary.cacheReadTokens += mm.Usage.CacheReadTokens
							summary.apiCalls += mm.Requests.Count
						}
					}
				}
			}

			fo.offset += int64(len(scanner.Bytes())) + 1
		}
		f.Close()
	}
}

// printSessionSummary displays an end-of-session summary banner.
func printSessionSummary(summary *sessionSummary, prefix string) {
	if summary == nil || summary.premiumRequests == 0 && summary.outputTokens == 0 {
		return
	}

	fmt.Fprintf(os.Stderr, "%s[%s]%s Session complete: ", colorBlue, prefix, colorReset)

	parts := []string{}
	if summary.premiumRequests > 0 {
		parts = append(parts, fmt.Sprintf("%s%d premium requests%s", colorYellow, summary.premiumRequests, colorGray))
	}
	if summary.outputTokens > 0 {
		in := formatTokenCount(summary.inputTokens)
		out := formatTokenCount(summary.outputTokens)
		parts = append(parts, fmt.Sprintf("%s↑%s %s↓%s tokens", in, colorGray, out, colorGray))
	}
	if summary.cacheReadTokens > 0 {
		parts = append(parts, fmt.Sprintf("⚡%s cached", formatTokenCount(summary.cacheReadTokens)))
	}
	if summary.durationMs > 0 {
		parts = append(parts, formatDurationMs(summary.durationMs))
	}
	if summary.linesAdded > 0 || summary.linesRemoved > 0 {
		parts = append(parts, fmt.Sprintf("%s+%d%s/-%d lines", colorGreen, summary.linesAdded, colorGray, summary.linesRemoved))
	}

	fmt.Fprintf(os.Stderr, "%s%s%s\n", colorGray, joinParts(parts, " | "), colorReset)
}

func joinParts(parts []string, sep string) string {
	result := ""
	for i, p := range parts {
		if i > 0 {
			result += sep
		}
		result += p
	}
	return result
}

func formatTokenCount(n int64) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	if n >= 1_000 {
		return fmt.Sprintf("%.1fK", float64(n)/1_000)
	}
	return fmt.Sprintf("%d", n)
}

func formatDurationMs(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	secs := ms / 1000
	if secs < 60 {
		return fmt.Sprintf("%ds", secs)
	}
	mins := secs / 60
	secs = secs % 60
	return fmt.Sprintf("%dm %ds", mins, secs)
}
