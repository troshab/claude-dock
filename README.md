# Claude Dock

Tabby plugin that adds:

- Pinned **Claude Dock Dashboard** tab (singleton).
- **Workspace** tabs (one per project directory).
- Per-workspace **terminal sub-tabs** (opened with `cwd = workspace.cwd`).
- Claude Code **sessions list** (working/waiting) driven by Claude hooks (realtime via named pipe/TCP).
- Claude **usage** panel (reads `~/.claude/stats-cache.json`).

## Install

```bash
npm i -g @troshab/claude-dock
```

This single command builds the plugin, deploys Claude Code hooks, and links into Tabby.

Restart Tabby to activate.

## What the install does

- Copies `bin/claude-dock-hook.js` to `~/.claude/plugins/cache/claude-dock/`
- Patches `~/.claude/settings.json` (creates a timestamped `.bak-*` backup) with hooks:
  - `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SessionEnd`
- Links the Tabby plugin into `<tabby-plugins>/node_modules/tabby-claude-dock`

Events are delivered in realtime via named pipe (Windows) or unix socket (Linux/Mac).
Docker containers send events via TCP to `host.docker.internal:19542`.

