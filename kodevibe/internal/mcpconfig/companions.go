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

// AgentKey returns the configured agent key (exported wrapper).
func AgentKey() string { return getAgentKey() }

// DashboardURL returns the configured dashboard URL (exported wrapper).
func DashboardURL() string { return getDashboardURL() }

// opencodeEventMap maps Claude-style hook events to OpenCode plugin hook names.
var opencodeEventMap = map[string]string{
	"UserPromptSubmit": "chat.message",
	"PreToolUse":       "tool.execute.before",
	"PostToolUse":      "tool.execute.after",
}

// SyncOpencodeHooks installs hooks targeting OpenCode as a generated plugin.
// Hook scripts are written under ~/.config/opencode/kodevibe-hooks/{event}/ and a
// plugin at ~/.config/opencode/plugin/kodevibe-hooks.js runs them on matching events.
// Telemetry env (ZEUDE_*) is injected by the plugin at exec time.
func SyncOpencodeHooks(allHooks []Hook, apiURL, agentKey, userEmail, team string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	ocDir := filepath.Join(home, ".config", "opencode")
	hooksBase := filepath.Join(ocDir, "kodevibe-hooks")
	pluginDir := filepath.Join(ocDir, "plugin")
	pluginPath := filepath.Join(pluginDir, "kodevibe-hooks.js")

	// Filter to OpenCode hooks on supported events
	var hooks []Hook
	for _, h := range allHooks {
		if h.appliesToTool("opencode") {
			if _, ok := opencodeEventMap[h.Event]; ok {
				hooks = append(hooks, h)
			}
		}
	}

	// Always start clean so deleted hooks are removed
	_ = os.RemoveAll(hooksBase)

	if len(hooks) == 0 {
		_ = os.Remove(pluginPath)
		return nil, nil
	}

	// Write each hook script
	installed := make([]string, 0, len(hooks))
	for _, h := range hooks {
		ext := "sh"
		if h.ScriptType == "python" {
			ext = "py"
		} else if h.ScriptType == "node" || h.ScriptType == "javascript" {
			ext = "js"
		}
		evDir := filepath.Join(hooksBase, h.Event)
		if err := os.MkdirAll(evDir, 0755); err != nil {
			return nil, err
		}
		scriptPath := filepath.Join(evDir, h.ID+"."+ext)
		if err := os.WriteFile(scriptPath, []byte(h.Script), 0755); err != nil {
			return nil, err
		}
		installed = append(installed, h.ID)
	}

	// Generate plugin JS
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		return nil, err
	}
	plugin := generateOpencodePluginJS(hooksBase, apiURL, agentKey, userEmail, team)
	if err := writeFileAtomic(pluginPath, []byte(plugin), 0644); err != nil {
		return nil, err
	}
	return installed, nil
}

// copilotEventMap maps Claude-style hook events to Copilot CLI hook event names.
var copilotEventMap = map[string]string{
	"UserPromptSubmit": "userPromptSubmitted",
	"PreToolUse":       "preToolUse",
	"PostToolUse":      "postToolUse",
	"SessionStart":     "sessionStart",
	"SessionEnd":       "sessionEnd",
	"Stop":             "agentStop",
}

// SyncCopilotHooks installs hooks targeting Copilot CLI into ~/.copilot/hooks/kodevibe.json.
// Each hook's script is written to ~/.copilot/kodevibe-hooks/{event}/ and invoked via a
// command-type hook entry; ZEUDE_* telemetry env is injected per entry.
func SyncCopilotHooks(allHooks []Hook, apiURL, agentKey, userEmail, team string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	hooksJSONDir := filepath.Join(home, ".copilot", "hooks")
	scriptsBase := filepath.Join(home, ".copilot", "kodevibe-hooks")
	jsonPath := filepath.Join(hooksJSONDir, "kodevibe.json")

	var hooks []Hook
	for _, h := range allHooks {
		if h.appliesToTool("copilot") {
			if _, ok := copilotEventMap[h.Event]; ok {
				hooks = append(hooks, h)
			}
		}
	}

	_ = os.RemoveAll(scriptsBase)
	if len(hooks) == 0 {
		_ = os.Remove(jsonPath)
		return nil, nil
	}

	baseEnv := map[string]string{
		"ZEUDE_API_URL":    apiURL,
		"ZEUDE_AGENT_KEY":  agentKey,
		"ZEUDE_USER_EMAIL": userEmail,
		"ZEUDE_TEAM":       team,
	}

	installed := make([]string, 0, len(hooks))
	hooksObj := map[string][]map[string]interface{}{}
	for _, h := range hooks {
		ev := copilotEventMap[h.Event]
		ext, runner := "sh", "bash"
		if h.ScriptType == "python" {
			ext, runner = "py", "python3"
		} else if h.ScriptType == "node" || h.ScriptType == "javascript" {
			ext, runner = "js", "node"
		}
		evDir := filepath.Join(scriptsBase, h.Event)
		if err := os.MkdirAll(evDir, 0755); err != nil {
			return nil, err
		}
		scriptPath := filepath.Join(evDir, h.ID+"."+ext)
		if err := os.WriteFile(scriptPath, []byte(h.Script), 0755); err != nil {
			return nil, err
		}

		env := map[string]string{}
		for k, v := range baseEnv {
			env[k] = v
		}
		for k, v := range h.Env {
			env[k] = v
		}

		hooksObj[ev] = append(hooksObj[ev], map[string]interface{}{
			"type":       "command",
			"bash":       fmt.Sprintf("%s %q", runner, scriptPath),
			"env":        env,
			"timeoutSec": 15,
		})
		installed = append(installed, h.ID)
	}

	out := map[string]interface{}{"version": 1, "hooks": hooksObj}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(hooksJSONDir, 0755); err != nil {
		return nil, err
	}
	if err := writeFileAtomic(jsonPath, data, 0644); err != nil {
		return nil, err
	}
	return installed, nil
}

// generateOpencodePluginJS builds the OpenCode plugin that runs hook scripts.
func generateOpencodePluginJS(hooksBase, apiURL, agentKey, userEmail, team string) string {
	env := map[string]string{
		"ZEUDE_API_URL":    apiURL,
		"ZEUDE_AGENT_KEY":  agentKey,
		"ZEUDE_USER_EMAIL": userEmail,
		"ZEUDE_TEAM":       team,
	}
	envJSON, _ := json.Marshal(env)
	baseJSON, _ := json.Marshal(hooksBase)

	return fmt.Sprintf(`// Auto-generated by KodeVibe. Runs managed hook scripts on OpenCode events.
import { execFileSync } from "node:child_process"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const BASE = %s
const EXTRA_ENV = %s

function runHooks(event, payload) {
  const dir = join(BASE, event)
  if (!existsSync(dir)) return
  let files = []
  try { files = readdirSync(dir) } catch { return }
  for (const f of files) {
    const p = join(dir, f)
    const cmd = f.endsWith(".py") ? "python3" : f.endsWith(".js") ? "node" : "bash"
    try {
      execFileSync(cmd, [p], {
        input: JSON.stringify(payload || {}),
        env: { ...process.env, ...EXTRA_ENV },
        timeout: 15000,
        stdio: ["pipe", "ignore", "ignore"],
      })
    } catch {}
  }
}

export default async () => ({
  "chat.message": async (input) => { runHooks("UserPromptSubmit", input) },
  "tool.execute.before": async (input) => { runHooks("PreToolUse", input) },
  "tool.execute.after": async (input) => { runHooks("PostToolUse", input) },
})
`, string(baseJSON), string(envJSON))
}
