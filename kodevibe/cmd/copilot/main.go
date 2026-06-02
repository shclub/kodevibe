// Package main provides the Zeude shim for GitHub Copilot CLI.
// Syncs MCP servers into ~/.copilot/mcp-config.json and injects telemetry env vars.
package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zeude/zeude/internal/autoupdate"
	"github.com/zeude/zeude/internal/config"
	"github.com/zeude/zeude/internal/mcpconfig"
	"github.com/zeude/zeude/internal/otelenv"
	"github.com/zeude/zeude/internal/otlplog"
	"github.com/zeude/zeude/internal/resolver"
)

const (
	colorReset  = "\033[0m"
	colorBlue   = "\033[1;34m"
	colorGreen  = "\033[1;32m"
	colorYellow = "\033[1;33m"
	colorRed    = "\033[1;31m"
	colorGray   = "\033[0;90m"
)

func main() {
	if isBackgroundSyncMode() {
		mcpconfig.RunBackgroundSync()
		autoupdate.ForceCheckBinaryWithResult("copilot")
		os.Exit(0)
	}

	// copilot is always a user-facing TUI tool — show banner unless it's a
	// non-interactive flag (help/version) or a scripted invocation (no stderr tty).
	showBanner := !isHelpOrVersionFlag() && isStderrTTY()

	// 1. Fast sync
	syncResult, needsBackgroundSync := mcpconfig.FastSync()

	prefix := syncResult.Prefix
	if prefix == "" {
		prefix = "zeude"
	}

	printInfo := func(info string) {
		if showBanner {
			fmt.Fprintf(os.Stderr, "%s[%s]%s %s%s%s\n", colorBlue, prefix, colorReset, colorGray, info, colorReset)
		}
	}

	// 2. Write MCP servers to copilot config
	if syncResult.Success && len(syncResult.MCPServers) > 0 {
		if err := mcpconfig.SyncCopilotMCP(syncResult.MCPServers); err != nil {
			fmt.Fprintf(os.Stderr, "[%s] warning: copilot MCP sync failed: %v\n", prefix, err)
		}
	}

	// 3. Write Copilot hooks
	if syncResult.Success && len(syncResult.Hooks) > 0 {
		agentKey := getAgentKey()
		if agentKey != "" {
			if err := mcpconfig.SyncCopilotHooks(syncResult.Hooks, agentKey, getDashboardURL()); err != nil {
				fmt.Fprintf(os.Stderr, "[%s] warning: copilot hooks sync failed: %v\n", prefix, err)
			}
		}
	}

	// 3. Find real copilot binary
	realCopilot, err := resolver.FindRealBinaryByName("copilot")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[%s] cannot find copilot binary: %v\n", prefix, err)
		os.Exit(1)
	}

	// 4. Display status
	var statusParts []string
	if syncResult.NoAgentKey {
		statusParts = append(statusParts, fmt.Sprintf("%sno agent key%s", colorYellow, colorGray))
	} else if syncResult.Success {
		if syncResult.FromCache {
			statusParts = append(statusParts, "cached")
		}
		if syncResult.ServerCount > 0 {
			statusParts = append(statusParts, fmt.Sprintf("%d servers", syncResult.ServerCount))
		}
	} else {
		statusParts = append(statusParts, fmt.Sprintf("%ssync failed%s", colorRed, colorGray))
	}
	if len(statusParts) > 0 {
		printInfo(strings.Join(statusParts, ", "))
	}

	// 5. Welcome message + pause so the banner is visible before the TUI takes over
	if showBanner {
		showStartupBanner(syncResult, prefix)
		time.Sleep(400 * time.Millisecond)
	}

	// 6. Inject OTel env vars
	injectTelemetryEnv(syncResult)

	// 7. Send session_start telemetry (fire-and-forget — copilot doesn't emit OTel natively)
	model := getModelFromArgs()
	if model == "" {
		model = mcpconfig.GetCopilotModel()
	}
	sessionID := generateUUID()
	otlplog.SendSessionStart(otlplog.SessionStartParams{
		Endpoint:  config.GetCollectorEndpoint(config.DefaultCollectorEndpoint),
		Service:   "copilot",
		UserID:    syncResult.UserID,
		UserEmail: syncResult.UserEmail,
		Team:      syncResult.Team,
		Model:     model,
		SessionID: sessionID,
	})

	// 8. Background sync
	if needsBackgroundSync {
		mcpconfig.BackgroundSync()
	}

	// Record start time before running copilot so we can find sessions created during this invocation.
	sessionStartMs := time.Now().UnixMilli() - 2000
	endpoint := config.GetCollectorEndpoint(config.DefaultCollectorEndpoint)

	// 8.5 Start real-time session watcher (polls events.jsonl every 500ms)
	summary := &sessionSummary{}
	watcherStop := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		watchCopilotSessions(syncResult, endpoint, sessionStartMs, watcherStop, summary)
		close(watcherDone)
	}()

	// 9. Run real copilot as subprocess (not exec/replace) so we can read session data after it exits
	exitCode, err := execBinary(realCopilot, os.Args, os.Environ())
	if err != nil {
		fmt.Fprintf(os.Stderr, "[%s] failed to run copilot: %v\n", prefix, err)
		os.Exit(1)
	}

	// 10. Stop watcher and wait for final read
	close(watcherStop)
	select {
	case <-watcherDone:
	case <-time.After(5 * time.Second):
	}

	// 11. Show session summary
	if showBanner {
		printSessionSummary(summary, prefix)
	}

	os.Exit(exitCode)
}

func isBackgroundSyncMode() bool {
	for _, arg := range os.Args[1:] {
		if arg == "--background-sync" {
			return true
		}
	}
	return false
}

// isStderrTTY reports whether stderr is connected to a real terminal.
func isStderrTTY() bool {
	stat, err := os.Stderr.Stat()
	if err != nil {
		return false
	}
	return (stat.Mode() & os.ModeCharDevice) != 0
}

// isHelpOrVersionFlag reports whether the user passed a non-interactive flag.
func isHelpOrVersionFlag() bool {
	for _, arg := range os.Args[1:] {
		if arg == "-h" || arg == "--help" || arg == "--version" {
			return true
		}
	}
	return false
}

func showStartupBanner(syncResult mcpconfig.SyncResult, prefix string) {
	userName := "there"
	if syncResult.UserEmail != "" {
		parts := strings.Split(syncResult.UserEmail, "@")
		if len(parts) > 0 && parts[0] != "" {
			userName = parts[0]
		}
	}
	version := autoupdate.GetVersion()
	versionStr := ""
	if version != "dev" {
		versionStr = fmt.Sprintf(" %sv%s%s", colorGray, version, colorReset)
	}
	fmt.Fprintf(os.Stderr, "%s[%s]%s Ready! Hi %s%s%s%s %s(copilot)%s\n",
		colorBlue, prefix, colorReset, colorGreen, userName, colorReset, versionStr, colorGray, colorReset)

	if syncResult.Banner != "" {
		for _, line := range strings.Split(syncResult.Banner, "\n") {
			fmt.Fprintf(os.Stderr, "%s[%s]%s %s%s%s\n", colorBlue, prefix, colorReset, colorYellow, line, colorReset)
		}
	}
	if syncResult.NoAgentKey {
		fmt.Fprintf(os.Stderr, "%s[%s]%s %s⚠ Run: echo 'agent_key=YOUR_KEY' > ~/.zeude/credentials%s\n",
			colorBlue, prefix, colorReset, colorYellow, colorReset)
	}
}

func injectTelemetryEnv(syncResult mcpconfig.SyncResult) {
	endpoint := config.GetCollectorEndpoint(config.DefaultCollectorEndpoint)
	otelenv.SetEnvIfEmpty("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint)
	otelenv.SetEnvIfEmpty("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
	otelenv.SetEnvIfEmpty("OTEL_METRICS_EXPORTER", "otlp")
	otelenv.SetEnvIfEmpty("OTEL_LOGS_EXPORTER", "otlp")
	otelenv.SetEnvIfEmpty("OTEL_TRACES_EXPORTER", "otlp")
	otelenv.SetEnvIfEmpty("OTEL_SERVICE_NAME", "copilot")

	if syncResult.UserID != "" {
		otelenv.InjectResourceAttribute("zeude.user.id", syncResult.UserID)
	}
	if syncResult.UserEmail != "" {
		otelenv.InjectResourceAttribute("zeude.user.email", syncResult.UserEmail)
	}
	if syncResult.Team != "" {
		otelenv.InjectResourceAttribute("zeude.team", syncResult.Team)
	}
	if model := mcpconfig.GetCopilotModel(); model != "" {
		otelenv.InjectResourceAttribute("ai.model.id", model)
	}
}

// getModelFromArgs extracts the model name from --model or -m CLI args.
func getModelFromArgs() string {
	args := os.Args[1:]
	for i, arg := range args {
		if strings.HasPrefix(arg, "--model=") {
			return strings.TrimPrefix(arg, "--model=")
		}
		if (arg == "--model" || arg == "-m") && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

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

// generateUUID creates a v4 UUID using crypto/rand.
func generateUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
