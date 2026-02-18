# Claude Dock

[Tabby](https://github.com/Eugeny/tabby) plugin that adds:

- Pinned **Claude Dock Dashboard** tab (singleton).
- **Workspace** tabs (one per project directory).
- Per-workspace **terminal sub-tabs** (opened with `cwd = workspace.cwd`).
- Claude Code **sessions list** (working/waiting) driven by Claude hooks (realtime via TCP).
- Claude **usage** panel (reads `~/.claude/stats-cache.json`).

![Dashboard](https://raw.githubusercontent.com/troshab/claude-dock/main/claude-dock-screenshot-1.jpg)

![Workspace](https://raw.githubusercontent.com/troshab/claude-dock/main/claude-dock-screenshot-2.jpg)

## Install

1. Install [Tabby terminal](https://github.com/Eugeny/tabby/releases/latest)
2. Install the plugin:

```bash
npm i -g @troshab/claude-dock
```

This builds the plugin, deploys Claude Code hooks, and links into Tabby.

3. Restart Tabby to activate.

## What the install does

- Copies `bin/claude-dock-hook.js` to `~/.claude/plugins/cache/claude-dock/`
- Patches `~/.claude/settings.json` (creates a timestamped `.bak-*` backup) with hooks:
  - `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SessionEnd`
- Links the Tabby plugin into `<tabby-plugins>/node_modules/tabby-claude-dock`

Events are delivered in realtime via TCP to `127.0.0.1:19542`.
Docker containers send events to `host.docker.internal:19542`.
