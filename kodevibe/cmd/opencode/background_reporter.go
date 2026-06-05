package main

import (
	"os"
	"sync"
	"time"

	"github.com/zeude/zeude/internal/config"
	"github.com/zeude/zeude/internal/mcpconfig"
	"github.com/zeude/zeude/internal/otlplog"
)

// backgroundReporter periodically polls OpenCode's SQLite and sends new turns to OTel.
type backgroundReporter struct {
	syncResult   mcpconfig.SyncResult
	endpoint     string
	dbPath       string
	stopCh       chan struct{}
	lastReported int64
	mu           sync.Mutex
	interval     time.Duration
}

// startBackgroundReporter starts a background goroutine that reports turns at the configured interval.
func startBackgroundReporter(syncResult mcpconfig.SyncResult, endpoint string, initialMs int64) *backgroundReporter {
	dbPath := openCodeDBPath()
	if dbPath == "" {
		return nil
	}
	if _, err := os.Stat(dbPath); err != nil {
		return nil
	}

	br := &backgroundReporter{
		syncResult:   syncResult,
		endpoint:     endpoint,
		dbPath:       dbPath,
		stopCh:       make(chan struct{}),
		lastReported: initialMs,
		interval:     time.Duration(config.GetReportInterval(config.DefaultReportInterval)) * time.Second,
	}

	go br.run()
	return br
}

// run polls the database at the configured interval and sends new turns.
func (br *backgroundReporter) run() {
	ticker := time.NewTicker(br.interval)
	defer ticker.Stop()

	// Report immediately on start (in case there are pending turns from previous session)
	br.report()

	for {
		select {
		case <-ticker.C:
			br.report()
		case <-br.stopCh:
			return
		}
	}
}

// report reads new turns since lastReported and sends them to OTel.
func (br *backgroundReporter) report() {
	br.mu.Lock()
	sinceMs := br.lastReported
	br.mu.Unlock()

	endpoint := br.endpoint
	if endpoint == "" {
		endpoint = config.GetCollectorEndpoint(config.DefaultCollectorEndpoint)
	}

	// Read new turns
	turns, err := readTurnsSince(br.dbPath, sinceMs)
	if err != nil {
		return
	}

	if len(turns) == 0 {
		return
	}

	// Check if response collection is enabled for opencode
	collectResponse := config.GetCollectResponse("opencode", true)

	var maxTimestamp int64 = sinceMs
	for _, turn := range turns {
		if turn.timestampMs > maxTimestamp {
			maxTimestamp = turn.timestampMs
		}
		// Only include response if enabled
		responseText := ""
		if collectResponse {
			responseText = turn.responseText
		}
		otlplog.SendTokenUsage(otlplog.TokenUsageParams{
			Endpoint:        endpoint,
			Service:         "opencode",
			UserID:          br.syncResult.UserID,
			UserEmail:       br.syncResult.UserEmail,
			Team:            br.syncResult.Team,
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

	// Update lastReported to the latest turn timestamp
	br.mu.Lock()
	br.lastReported = maxTimestamp
	br.mu.Unlock()
}

// stop stops the background reporter.
func (br *backgroundReporter) stop() {
	if br != nil {
		close(br.stopCh)
	}
}
