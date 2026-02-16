# tabby-claude-code-zit

Tabby plugin that adds:

- Pinned **Claude Code Dashboard** tab (singleton).
- **Workspace** tabs (one per project directory).
- Per-workspace **terminal sub-tabs** (opened with `cwd = workspace.cwd`).
- Claude Code **sessions list** (working/waiting) driven by Claude hooks writing `events.jsonl`.
- Claude **usage** panel (reads `~/.claude/stats-cache.json`).

## Install (Windows)

1. Build + link plugin into Tabby's user plugins dir:

```powershell
cd C:\Users\tro\claude-code-zit
npm install
npm run install:tabby
```

2. Restart Tabby.

Tabby plugins dir (this machine):

- `C:\Users\tro\AppData\Roaming\tabby\plugins`
- node modules: `C:\Users\tro\AppData\Roaming\tabby\plugins\node_modules`

Dev workflow: `npm run install:tabby` creates a **junction**:

- `...\tabby\plugins\node_modules\tabby-claude-code-zit` -> `C:\Users\tro\claude-code-zit`

So you only rebuild (`npm run build`) and restart Tabby.

## Install Claude hooks (Windows)

This replaces old `claude-notify` hook commands inside `~/.claude/settings.json` with our file logger hook.

```powershell
cd C:\Users\tro\claude-code-zit
npm run install:claude-hooks
```

What it does:

- Copies `bin/claude-code-zit-hook.js` to `C:\Users\tro\.claude\hooks\claude-code-zit-hook.js`
- Patches `C:\Users\tro\.claude\settings.json` (creates a timestamped `.bak-*` backup)
- Adds hook commands for:
  - `SessionStart` -> `session_start`
  - `PreToolUse` -> `tool_start`
  - `PostToolUse` -> `tool_end`
  - `Stop` -> `stop`
  - `Notification` -> `notification`
  - `SessionEnd` -> `session_end`

Events are appended to:

- `C:\Users\tro\.claude\claude-code-zit\events.jsonl`

## Notes

- This plugin assumes `tabby-local` is enabled (to open local terminals).
- Dashboard sort default: waiting first, oldest waiting on top; then working by most recent tool usage.

