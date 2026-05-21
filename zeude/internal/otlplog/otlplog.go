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
