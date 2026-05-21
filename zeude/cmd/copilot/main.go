// Package main provides the Zeude shim for GitHub Copilot CLI.
// Syncs MCP servers into ~/.copilot/mcp-config.json and injects telemetry env vars.
package main

import (
	"fmt"
	"os"
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
	otlplog.SendSessionStart(otlplog.SessionStartParams{
		Endpoint:  config.GetCollectorEndpoint(config.DefaultCollectorEndpoint),
		Service:   "copilot",
		UserID:    syncResult.UserID,
		UserEmail: syncResult.UserEmail,
		Team:      syncResult.Team,
		Model:     model,
	})

	// 8. Background sync
	if needsBackgroundSync {
		mcpconfig.BackgroundSync()
	}

	// 9. Exec real copilot
	if err := execBinary(realCopilot, os.Args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "[%s] failed to exec copilot: %v\n", prefix, err)
		os.Exit(1)
	}
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
