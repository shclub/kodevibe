# Hooks Integration (Claude / OpenCode / Copilot CLI)

KodeVibe hooks can be targeted at one or more AI tools. When you create or edit a
hook in **Admin → Hooks**, pick the target tools (Claude / Copilot / OpenCode).
The shim installs each hook into the right place for each tool during background
sync (`doSync`).

- Hook record carries a `tools text[]` column (default `{claude}`).
- The config API (`/api/config/[agentKey]`) returns `tools` per hook.
- The Go shim filters hooks per tool via `Hook.appliesToTool(tool)`.
- Telemetry env (`ZEUDE_API_URL`, `ZEUDE_AGENT_KEY`, `ZEUDE_USER_EMAIL`,
  `ZEUDE_TEAM`) is injected for every tool.

> Installs happen in **background sync**, so run the tool once (which triggers a
> background sync) for the hook to land on disk.

---

## Event mapping

KodeVibe stores hooks with Claude-style event names. They are translated per tool:

| KodeVibe event     | Claude            | OpenCode               | Copilot CLI          |
|--------------------|-------------------|------------------------|----------------------|
| `UserPromptSubmit` | `UserPromptSubmit`| `chat.message`         | `userPromptSubmitted`|
| `PreToolUse`       | `PreToolUse`      | `tool.execute.before`  | `preToolUse`         |
| `PostToolUse`      | `PostToolUse`     | `tool.execute.after`   | `postToolUse`        |
| `SessionStart`     | `SessionStart`    | — (unsupported)        | `sessionStart`       |
| `SessionEnd`       | `SessionEnd`      | — (unsupported)        | `sessionEnd`         |
| `Stop`             | `Stop`            | — (unsupported)        | `agentStop`          |

Events without a mapping for a given tool are skipped for that tool.

---

## Claude Code

- **Where:** `~/.claude/hooks/{event}/` + registered in `~/.claude/settings.json`
- **How:** hook script is written per event; env vars are prepended into the script.
- **Code:** `installHooks()` in `internal/mcpconfig/sync.go` (filtered to `claude`).

---

## OpenCode

OpenCode uses a JS/TS **plugin** system, not bash hooks. KodeVibe generates a
plugin that shells out to the hook scripts.

- **Scripts:** `~/.config/opencode/kodevibe-hooks/{event}/{hookId}.{sh|py|js}`
- **Plugin:** `~/.config/opencode/plugin/kodevibe-hooks.js` (auto-loaded by OpenCode)
- **How:** the plugin registers `chat.message`, `tool.execute.before`,
  `tool.execute.after` hooks. Each runs the matching scripts with
  `execFileSync(runner, [scriptPath], { input: JSON.stringify(payload), env })`.
  - `runner` = `bash` / `python3` / `node` based on script type.
  - `EXTRA_ENV` (ZEUDE_*) is baked into the generated plugin and merged into
    `process.env` at exec time.
- **Code:** `SyncOpencodeHooks()` + `generateOpencodePluginJS()` in
  `internal/mcpconfig/companions.go`.

Generated plugin shape:

```js
// ~/.config/opencode/plugin/kodevibe-hooks.js
const BASE = "/Users/<you>/.config/opencode/kodevibe-hooks"
const EXTRA_ENV = { ZEUDE_API_URL: "...", ZEUDE_AGENT_KEY: "...", /* ... */ }

function runHooks(event, payload) { /* execFileSync each script in BASE/event */ }

export default async () => ({
  "chat.message":        async (input) => runHooks("UserPromptSubmit", input),
  "tool.execute.before": async (input) => runHooks("PreToolUse", input),
  "tool.execute.after":  async (input) => runHooks("PostToolUse", input),
})
```

---

## Copilot CLI

Copilot CLI supports personal hooks (GitHub, GA 2026) at `~/.copilot/hooks/*.json`.
KodeVibe writes a dedicated file so user hooks are untouched.

- **Config:** `~/.copilot/hooks/kodevibe.json`
- **Scripts:** `~/.copilot/kodevibe-hooks/{event}/{hookId}.{sh|py|js}`
- **How:** each hook becomes a `type: "command"` entry that runs the script via
  `bash`/`python3`/`node`, with `env` (ZEUDE_* + the hook's own env) and a
  `timeoutSec`.
- **Code:** `SyncCopilotHooks()` in `internal/mcpconfig/companions.go`.

Generated config shape:

```json
{
  "version": 1,
  "hooks": {
    "userPromptSubmitted": [
      {
        "type": "command",
        "bash": "bash \"/Users/<you>/.copilot/kodevibe-hooks/UserPromptSubmit/<id>.sh\"",
        "env": { "ZEUDE_API_URL": "...", "ZEUDE_AGENT_KEY": "...", "ZEUDE_USER_EMAIL": "...", "ZEUDE_TEAM": "..." },
        "timeoutSec": 15
      }
    ]
  }
}
```

Copilot CLI also supports `type: "http"` and `type: "prompt"` hooks; KodeVibe uses
`command` to reuse the same scripts across tools.

---

## Notes / Limitations

- **OpenCode** only has chat/tool events — `SessionStart`, `SessionEnd`, `Stop`
  are not delivered, so those hooks are skipped for OpenCode.
- **Script runner** relies on `bash` / `python3` / `node` being on PATH.
- Re-running sync rewrites the generated plugin/config and removes scripts for
  deleted hooks (clean slate each sync).
- Windows: Copilot supports a `powershell` field; the current generator emits
  `bash` only (macOS/Linux). Add PowerShell variants if Windows support is needed.
