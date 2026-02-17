# Claude Dock

Tabby plugin that adds:

- Pinned **Claude Dock Dashboard** tab (singleton).
- **Workspace** tabs (one per project directory).
- Per-workspace **terminal sub-tabs** (opened with `cwd = workspace.cwd`).
- Claude Code **sessions list** (working/waiting) driven by Claude hooks writing `events.jsonl`.
- Claude **usage** panel (reads `~/.claude/stats-cache.json`).

## Install

```bash
npm i -g @troshab/claude-dock
```

This single command builds the plugin, deploys Claude Code hooks, and links into Tabby.

Restart Tabby to activate.

## Dev workflow

```bash
git clone git@github.com:troshab/claude-dock.git
cd claude-dock
npm install
```

`npm install` runs build + deploy automatically. A **junction** is created:

- `<tabby-plugins>/node_modules/tabby-claude-dock` -> source dir

So you only rebuild (`npm run build`) and restart Tabby.

## What the install does

- Copies `bin/claude-dock-hook.js` to `~/.claude/plugins/cache/claude-dock/`
- Patches `~/.claude/settings.json` (creates a timestamped `.bak-*` backup) with hooks:
  - `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SessionEnd`
- Links the Tabby plugin into `<tabby-plugins>/node_modules/tabby-claude-dock`

Events are appended to `~/.claude/claude-dock/events.jsonl`.

## Notes

- Requires `tabby-local` plugin (for local terminals).
- Dashboard sort default: waiting first, oldest waiting on top; then working by most recent tool usage.
