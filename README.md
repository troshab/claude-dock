# Claude Dock

[![npm](https://img.shields.io/npm/v/@troshab/claude-dock)](https://www.npmjs.com/package/@troshab/claude-dock)
[![Docker](https://github.com/troshab/claude-dock/actions/workflows/docker.yml/badge.svg)](https://github.com/troshab/claude-dock/actions/workflows/docker.yml)
[![License](https://img.shields.io/badge/license-PolyForm--Noncommercial-blue)](LICENSE)

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

This does everything in one step:
- Installs Claude Code hooks plugin to `~/.claude/plugins/cache/`
- Registers `claude-dock` in Claude Code `enabledPlugins`
- Links the Tabby plugin into Tabby's plugin directory

3. Restart Tabby to activate.

## Uninstall

```bash
npm rm -g @troshab/claude-dock
```

Removes hooks, plugin registration, and Tabby link.
