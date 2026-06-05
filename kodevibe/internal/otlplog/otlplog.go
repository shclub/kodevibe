// Package otlplog sends OTLP JSON log records directly to the OTel collector.
// Used by companion shims (copilot, opencode) to record session invocations
// since those tools don't emit OTel natively.
package otlplog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// TokenUsageParams holds the metadata for a token usage log record.
// Used by the opencode/copilot shims to report per-turn token counts.
type TokenUsageParams struct {
	Endpoint         string    // OTLP HTTP endpoint
	Service          string    // service name (e.g. "opencode")
	UserID           string
	UserEmail        string
	Team             string
	SessionID        string    // session ID
	PromptID         string    // turn ID (message ID), used to group events per turn
	Model            string    // model ID
	Prompt           string    // user prompt text for this turn (may be empty)
	Response         string    // assistant response text for this turn (may be empty)
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	PremiumRequests  int64
	DurationMs       int64
	Timestamp        time.Time // when this turn completed
}

// SendTokenUsage fires a single OTLP log record with token usage data.
// This is used by the opencode shim after the process exits to report
// token counts from opencode's local SQLite database.
// Errors are silently ignored — this is best-effort telemetry.
func SendTokenUsage(p TokenUsageParams) {
	if p.Endpoint == "" || p.Service == "" {
		return
	}
	if p.InputTokens == 0 && p.OutputTokens == 0 && p.PremiumRequests == 0 {
		return
	}

	resAttrs := []kv{
		{Key: "service.name", Value: kvString{p.Service}},
	}
	if p.UserID != "" {
		resAttrs = append(resAttrs, kv{Key: "zeude.user.id", Value: kvString{p.UserID}})
	}
	if p.UserEmail != "" {
		resAttrs = append(resAttrs, kv{Key: "zeude.user.email", Value: kvString{p.UserEmail}})
	}
	if p.Team != "" {
		resAttrs = append(resAttrs, kv{Key: "zeude.team", Value: kvString{p.Team}})
	}

	ts := p.Timestamp
	if ts.IsZero() {
		ts = time.Now()
	}

	logAttrs := []kv{
		{Key: "input_tokens", Value: kvString{fmt.Sprintf("%d", p.InputTokens)}},
		{Key: "output_tokens", Value: kvString{fmt.Sprintf("%d", p.OutputTokens)}},
		{Key: "cache_read_tokens", Value: kvString{fmt.Sprintf("%d", p.CacheReadTokens)}},
	}
	if p.CacheWriteTokens > 0 {
		logAttrs = append(logAttrs, kv{Key: "cache_creation_tokens", Value: kvString{fmt.Sprintf("%d", p.CacheWriteTokens)}})
	}
	if p.PremiumRequests > 0 {
		logAttrs = append(logAttrs, kv{Key: "premium_requests", Value: kvString{fmt.Sprintf("%d", p.PremiumRequests)}})
	}
	if p.DurationMs > 0 {
		logAttrs = append(logAttrs, kv{Key: "duration_ms", Value: kvString{fmt.Sprintf("%d", p.DurationMs)}})
	}
	if p.Model != "" {
		logAttrs = append(logAttrs, kv{Key: "model", Value: kvString{p.Model}})
	}
	if p.SessionID != "" {
		logAttrs = append(logAttrs, kv{Key: "session.id", Value: kvString{p.SessionID}})
	}
	if p.PromptID != "" {
		logAttrs = append(logAttrs, kv{Key: "prompt.id", Value: kvString{p.PromptID}})
	}
	if p.Prompt != "" {
		logAttrs = append(logAttrs, kv{Key: "prompt", Value: kvString{p.Prompt}})
		logAttrs = append(logAttrs, kv{Key: "prompt_length", Value: kvString{fmt.Sprintf("%d", len([]rune(p.Prompt)))}})
	}
		if p.Response != "" {
			logAttrs = append(logAttrs, kv{Key: "response", Value: kvString{p.Response}})
			logAttrs = append(logAttrs, kv{Key: "response_length", Value: kvString{fmt.Sprintf("%d", len([]rune(p.Response)))}})
		}

	payload := otlpLogsPayload{
		ResourceLogs: []otlpResourceLogs{{
			Resource: otlpResource{Attributes: resAttrs},
			ScopeLogs: []otlpScopeLogs{{
				Scope: otlpScope{Name: "zeude.shim"},
				LogRecords: []otlpLogRecord{{
					TimeUnixNano:   fmt.Sprintf("%d", ts.UnixNano()),
					SeverityNumber: 9,
					SeverityText:   "INFO",
					Body:           kvString{"api_request"},
					Attributes:     logAttrs,
				}},
			}},
		}},
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return
	}

	url := strings.TrimRight(p.Endpoint, "/") + "/v1/logs"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

type kvString struct {
	StringValue string `json:"stringValue"`
}

type kv struct {
	Key   string   `json:"key"`
	Value kvString `json:"value"`
}

type otlpResource struct {
	Attributes []kv `json:"attributes"`
}

type otlpScope struct {
	Name string `json:"name"`
}

type otlpLogRecord struct {
	TimeUnixNano   string   `json:"timeUnixNano"`
	SeverityNumber int      `json:"severityNumber"`
	SeverityText   string   `json:"severityText"`
	Body           kvString `json:"body"`
	Attributes     []kv     `json:"attributes,omitempty"`
}

type otlpScopeLogs struct {
	Scope      otlpScope       `json:"scope"`
	LogRecords []otlpLogRecord `json:"logRecords"`
}

type otlpResourceLogs struct {
	Resource  otlpResource    `json:"resource"`
	ScopeLogs []otlpScopeLogs `json:"scopeLogs"`
}

type otlpLogsPayload struct {
	ResourceLogs []otlpResourceLogs `json:"resourceLogs"`
}

// SessionStartParams holds the metadata for a session_start log record.
type SessionStartParams struct {
	Endpoint  string // OTLP HTTP endpoint (e.g. "http://localhost:4318/")
	Service   string // service name: "copilot" or "opencode"
	UserID    string
	UserEmail string
	Team      string
	Model     string // model ID at invocation time
	SessionID string // session ID
}

// SendSessionStart fires a single OTLP log record to the collector, then returns.
// Uses a 2-second timeout so it never delays tool startup.
// Errors are silently ignored — this is best-effort telemetry.
func SendSessionStart(p SessionStartParams) {
	if p.Endpoint == "" || p.Service == "" {
		return
	}

	resAttrs := []kv{
		{Key: "service.name", Value: kvString{p.Service}},
	}
	if p.UserID != "" {
		resAttrs = append(resAttrs, kv{Key: "zeude.user.id", Value: kvString{p.UserID}})
	}
	if p.UserEmail != "" {
		resAttrs = append(resAttrs, kv{Key: "zeude.user.email", Value: kvString{p.UserEmail}})
	}
	if p.Team != "" {
		resAttrs = append(resAttrs, kv{Key: "zeude.team", Value: kvString{p.Team}})
	}

	var logAttrs []kv
	if p.Model != "" {
		logAttrs = append(logAttrs, kv{Key: "model", Value: kvString{p.Model}})
	}
	if p.SessionID != "" {
		logAttrs = append(logAttrs, kv{Key: "session.id", Value: kvString{p.SessionID}})
	}

	payload := otlpLogsPayload{
		ResourceLogs: []otlpResourceLogs{{
			Resource: otlpResource{Attributes: resAttrs},
			ScopeLogs: []otlpScopeLogs{{
				Scope: otlpScope{Name: "zeude.shim"},
				LogRecords: []otlpLogRecord{{
					TimeUnixNano:   fmt.Sprintf("%d", time.Now().UnixNano()),
					SeverityNumber: 9,
					SeverityText:   "INFO",
					Body:           kvString{"session_start"},
					Attributes:     logAttrs,
				}},
			}},
		}},
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return
	}

	url := strings.TrimRight(p.Endpoint, "/") + "/v1/logs"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}
