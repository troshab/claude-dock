#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# claude-dock sandbox entrypoint
# ---------------------------------------------------------------------------
# 1. Symlink ~/.claude so Windows-style paths in settings.json / plugins
#    resolve inside the container (/DRIVE/Users/NAME/.claude -> /home/agent/.claude).
# 2. Fix dangling symlinks left by docker sandbox run (settings.json, .claude.json).
# 3. Remove .orphaned_at markers that Claude Code writes on first start.
# 4. Forward host ports to container localhost via socat.
# 5. Exec into the requested command (claude / bash / ...).
# ---------------------------------------------------------------------------

CLAUDE_HOME="/home/agent/.claude"

# --- 1. Windows path symlink ---------------------------------------------------
# Workspace is mounted at its original POSIX path (/DRIVE/Users/NAME/project).
# ~/.claude is at /home/agent/.claude.  Config files reference the Windows-style
# POSIX path - create a symlink so those resolve.

if [ -d "$CLAUDE_HOME" ]; then
  WS="${CLAUDE_DOCK_CWD:-$(pwd)}"
  if [[ "$WS" =~ ^/([a-zA-Z])/([Uu]sers/[^/]+) ]]; then
    WIN_HOME="/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    if [ -d "$WIN_HOME" ] && [ ! -e "$WIN_HOME/.claude" ]; then
      sudo ln -sf "$CLAUDE_HOME" "$WIN_HOME/.claude" 2>/dev/null || true
    fi
  fi
fi

# --- 2. Fix dangling symlinks left by docker sandbox run --------------------
# docker sandbox run creates symlinks pointing to /mnt/claude-data/ (a persistent
# volume).  When ~/.claude is bind-mounted from the host, these symlinks are
# written THROUGH the bind mount onto the host filesystem, destroying the
# original files.
#
# Strategy: if settings.json is a dangling symlink, remove it and restore from
# the most recent backup (settings.json.bak-*).  Same for ~/.claude.json.

_restore_from_backup() {
  local target="$1"
  local dir
  dir="$(dirname "$target")"
  local base
  base="$(basename "$target")"
  # Find newest backup: settings.json.bak-* or .claude.json.backup.*
  local backup
  backup="$(ls -t "$dir/${base}.bak-"* "$dir/${base}.backup."* 2>/dev/null | head -1)"
  if [ -n "$backup" ] && [ -f "$backup" ]; then
    cp "$backup" "$target" 2>/dev/null || sudo cp "$backup" "$target" 2>/dev/null || true
  fi
}

for _f in "$CLAUDE_HOME/settings.json" "$HOME/.claude.json"; do
  if [ -L "$_f" ] && [ ! -e "$_f" ]; then
    rm -f "$_f" 2>/dev/null || sudo rm -f "$_f" 2>/dev/null || true
    _restore_from_backup "$_f"
  fi
done

# --- 3. Clean orphan markers ---------------------------------------------------
find "$CLAUDE_HOME/plugins/cache" -name ".orphaned_at" -delete 2>/dev/null || true

# --- 4. Port forwarding --------------------------------------------------------
# CLAUDE_DOCK_FORWARD_PORTS is a comma-separated list of ports (e.g. "3000,5173,8080").
# Each port gets a socat background process forwarding container localhost -> host.
if [ -n "$CLAUDE_DOCK_FORWARD_PORTS" ]; then
  IFS=',' read -ra _PORTS <<< "$CLAUDE_DOCK_FORWARD_PORTS"
  for _p in "${_PORTS[@]}"; do
    _p="${_p// /}"
    if [ -n "$_p" ] && [ "$_p" -gt 0 ] 2>/dev/null; then
      socat "TCP-LISTEN:$_p,fork,reuseaddr" "TCP:host.docker.internal:$_p" &
    fi
  done
fi

# --- 5. Exec into main command -------------------------------------------------
exec "$@"
