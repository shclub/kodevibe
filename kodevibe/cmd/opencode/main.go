// Package main provides the Zeude shim for opencode CLI.
// Syncs MCP servers, skills, and injects telemetry env vars before exec.
package main

import (
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
		autoupdate.ForceCheckBinaryWithResult("opencode")
		os.Exit(0)
	}

	// opencode is always a user-facing TUI tool — show banner unless it's a
	// non-interactive flag (help/version) or a scripted invocation (no stderr tty).
	showBanner := !isHelpOrVersionFlag() && isStderrTTY()

	// 1. Fast sync (uses cached user info)
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

	// 2. Write MCP servers to opencode config
	if syncResult.Success && len(syncResult.MCPServers) > 0 {
		if err := mcpconfig.SyncOpencodeMCP(syncResult.MCPServers); err != nil {
			fmt.Fprintf(os.Stderr, "[%s] warning: opencode MCP sync failed: %v\n", prefix, err)
		}
	}


	// 3. Find real opencode binary
	realOpencode, err := findRealOpencode()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[%s] cannot find opencode binary: %v\n", prefix, err)
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
		if syncResult.SkillCount > 0 {
			statusParts = append(statusParts, fmt.Sprintf("%d skills", syncResult.SkillCount))
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

	// 7. Send session_start telemetry (fire-and-forget — opencode doesn't emit OTel natively)
	model := getModelFromArgs()
	if model == "" {
		model = mcpconfig.GetOpencodeModel()
	}
	endpoint := config.GetCollectorEndpoint(config.DefaultCollectorEndpoint)
	otlplog.SendSessionStart(otlplog.SessionStartParams{
		Endpoint:  endpoint,
		Service:   "opencode",
		UserID:    syncResult.UserID,
		UserEmail: syncResult.UserEmail,
		Team:      syncResult.Team,
		Model:     model,
	})

	// 8. Background sync
	if needsBackgroundSync {
		mcpconfig.BackgroundSync()
	}

	// Record start time for post-session token reporting (5-min buffer before launch)
	sessionStartMs := time.Now().UnixMilli() - 5*60*1000

	// 9. Run real opencode as a subprocess (not syscall.Exec) so we can post-process.
	exitCode, err := execBinary(realOpencode, os.Args, os.Environ())
	if err != nil {
		fmt.Fprintf(os.Stderr, "[%s] failed to run opencode: %v\n", prefix, err)
		os.Exit(1)
	}

	// 10. Report token usage from opencode's SQLite DB (fire-and-forget).
	reportOpenCodeSessions(syncResult, endpoint, sessionStartMs)

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
		if arg == "-h" || arg == "--help" || arg == "--version" || arg == "-v" {
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
	fmt.Fprintf(os.Stderr, "%s[%s]%s Ready! Hi %s%s%s%s %s(opencode)%s\n",
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
	otelenv.SetEnvIfEmpty("OTEL_SERVICE_NAME", "opencode")

	if syncResult.UserID != "" {
		otelenv.InjectResourceAttribute("zeude.user.id", syncResult.UserID)
	}
	if syncResult.UserEmail != "" {
		otelenv.InjectResourceAttribute("zeude.user.email", syncResult.UserEmail)
	}
	if syncResult.Team != "" {
		otelenv.InjectResourceAttribute("zeude.team", syncResult.Team)
	}
	if model := mcpconfig.GetOpencodeModel(); model != "" {
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

// findRealOpencode looks for opencode: first in ~/.opencode/bin/, then PATH.
func findRealOpencode() (string, error) {
	home, err := os.UserHomeDir()
	if err == nil {
		candidate := filepath.Join(home, ".opencode", "bin", "opencode")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return resolver.FindRealBinaryByName("opencode")
}
