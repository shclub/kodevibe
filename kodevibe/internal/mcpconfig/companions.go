package mcpconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// SyncOpencodeMCP writes Zeude-managed MCP servers into ~/.config/opencode/opencode.json.
// OpenCode format: { "mcp": { "name": { "type": "local"|"remote", "command": [...], "environment": {} } } }
func SyncOpencodeMCP(servers map[string]MCPServer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	configPath := filepath.Join(home, ".config", "opencode", "opencode.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		return err
	}

	// Read existing config (preserve user settings)
	raw := map[string]interface{}{}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &raw)
	}

	// Build mcp section
	mcp := map[string]interface{}{}

	// Preserve interface{} existing user-defined MCP entries (non-zeude-managed)
	if existing, ok := raw["mcp"].(map[string]interface{}); ok {
		for k, v := range existing {
			mcp[k] = v
		}
	}

	// Overwrite with Zeude-managed servers
	for name, srv := range servers {
		if srv.URL != "" {
			// Remote server
			mcp[name] = map[string]interface{}{
				"type": "remote",
				"url":  srv.URL,
			}
		} else {
			// Local server: opencode wants command as array [cmd, arg1, arg2...]
			cmd := []string{srv.Command}
			cmd = append(cmd, srv.Args...)
			entry := map[string]interface{}{
				"type":    "local",
				"command": cmd,
			}
			if len(srv.Env) > 0 {
				entry["environment"] = srv.Env
			}
			mcp[name] = entry
		}
	}

	raw["mcp"] = mcp

	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(configPath, data, 0644)
}

// SyncCopilotMCP writes Zeude-managed MCP servers into ~/.copilot/mcp-config.json.
// Copilot format: { "mcpServers": { "name": { "command": "...", "args": [...], "env": {} } } }
func SyncCopilotMCP(servers map[string]MCPServer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	configPath := filepath.Join(home, ".copilot", "mcp-config.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		return err
	}

	// Read existing config
	type copilotConfig struct {
		MCPServers map[string]interface{} `json:"mcpServers"`
	}
	cfg := copilotConfig{MCPServers: map[string]interface{}{}}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	if cfg.MCPServers == nil {
		cfg.MCPServers = map[string]interface{}{}
	}

	// Overwrite with Zeude-managed servers (same format as Claude Code)
	for name, srv := range servers {
		if srv.URL != "" {
			cfg.MCPServers[name] = map[string]interface{}{
				"type": "http",
				"url":  srv.URL,
			}
		} else {
			entry := map[string]interface{}{
				"command": srv.Command,
				"args":    srv.Args,
			}
			if len(srv.Env) > 0 {
				entry["env"] = srv.Env
			}
			cfg.MCPServers[name] = entry
		}
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(configPath, data, 0644)
}

// GetCurrentModel reads the model currently configured in ~/.claude.json.
// Returns empty string if not set.
func GetCurrentModel() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Model              string `json:"model"`
		DefaultModel       string `json:"defaultModel"`
		ClaudeCodeSettings struct {
			DefaultModel string `json:"defaultModel"`
		} `json:"claudeCodeSettings"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return ""
	}
	if cfg.Model != "" {
		return cfg.Model
	}
	if cfg.DefaultModel != "" {
		return cfg.DefaultModel
	}
	if m := cfg.ClaudeCodeSettings.DefaultModel; m != "" {
		return m
	}
	return ""
}

// GetCopilotModel reads the model from ~/.copilot/settings.json.
// Returns empty string if not set.
func GetCopilotModel() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".copilot", "settings.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return ""
	}
	return cfg.Model
}

// GetOpencodeModel reads the first configured provider+model from opencode.json.
// Returns "provider/model" or empty string.
func GetOpencodeModel() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".config", "opencode", "opencode.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Model    string            `json:"model"`
		Provider map[string]struct {
			Models map[string]interface{} `json:"models"`
		} `json:"provider"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return ""
	}
	if cfg.Model != "" {
		return cfg.Model
	}
	// Grab first provider/model
	for provider, p := range cfg.Provider {
		for model := range p.Models {
			return fmt.Sprintf("%s/%s", provider, model)
		}
	}
	return ""
}

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
			// Skip unknown events
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
