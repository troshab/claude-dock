#!/bin/bash
# dock-send.sh — send hook events to claude-dock daemon via TCP
# Executed from hook commands: bash "${CLAUDE_PLUGIN_ROOT}/dock-send.sh" EVENT [OPTIONS]
# Cross-platform: /dev/tcp (Git Bash/Windows) -> nc (Linux/Docker) -> socat (fallback)
#
# Usage:
#   bash dock-send.sh session_start --start-daemon   # async + start daemon if needed
#   bash dock-send.sh user_prompt                     # async fire-and-forget
#   bash dock-send.sh permission_request --sync 590   # sync, wait up to 590s
#   bash dock-send.sh task_completed --sync 30 --block # sync with BLOCK: handling

_DOCK_EVENT="${1:-unknown}"; [ $# -gt 0 ] && shift
_DOCK_SYNC=0
_DOCK_START=false
_DOCK_BLOCK=false

while [ $# -gt 0 ]; do
  case "$1" in
    --sync) _DOCK_SYNC="${2:-30}"; shift 2;;
    --start-daemon) _DOCK_START=true; shift;;
    --block) _DOCK_BLOCK=true; shift;;
    *) shift;;
  esac
done

_DOCK_PORT=19543
_DOCK_HOST=127.0.0.1
_DOCK_META="${CLAUDE_DOCK_SOURCE:-}|${CLAUDE_DOCK_TABBY_SESSION:-}|${CLAUDE_DOCK_TERMINAL_ID:-}|${CLAUDE_DOCK_HOST_PID:-}"

# ── Buffer stdin + protocol header into temp file ──
_DOCK_TMP=$(mktemp 2>/dev/null || echo "/tmp/_dock_$$")
{ printf '%s\n%s\n' "$_DOCK_EVENT" "$_DOCK_META"; cat; } > "$_DOCK_TMP" 2>/dev/null

# ── Start daemon if needed ──
if $_DOCK_START; then
  _dock_alive=false
  # Probe: try /dev/tcp, then nc -z
  if (exec 3<>/dev/tcp/$_DOCK_HOST/$_DOCK_PORT) 2>/dev/null; then
    _dock_alive=true
  elif nc -z $_DOCK_HOST $_DOCK_PORT 2>/dev/null; then
    _dock_alive=true
  fi
  if ! $_dock_alive; then
    _DP=$(cygpath -w "${CLAUDE_PLUGIN_ROOT}" 2>/dev/null || printf '%s' "${CLAUDE_PLUGIN_ROOT}")
    node "$_DP/claude-dock-daemon.js" </dev/null &>/dev/null &
    sleep 0.3
  fi
fi

# ── Send ──
_DOCK_RESP=""

if [ "$_DOCK_SYNC" -gt 0 ]; then
  # ── Sync: bidirectional, wait for response ──
  if { exec 3<>/dev/tcp/$_DOCK_HOST/$_DOCK_PORT; } 2>/dev/null; then
    cat "$_DOCK_TMP" >&3
    read -t "$_DOCK_SYNC" _DOCK_RESP <&3 || true
    exec 3>&- 2>/dev/null
  elif command -v nc >/dev/null 2>&1; then
    _DOCK_RESP=$(nc -w "$_DOCK_SYNC" $_DOCK_HOST $_DOCK_PORT < "$_DOCK_TMP" 2>/dev/null) || true
  elif command -v socat >/dev/null 2>&1; then
    _DOCK_RESP=$(socat -T"$_DOCK_SYNC" - "TCP:$_DOCK_HOST:$_DOCK_PORT" < "$_DOCK_TMP" 2>/dev/null) || true
  fi
else
  # ── Async: fire-and-forget ──
  cat "$_DOCK_TMP" > /dev/tcp/$_DOCK_HOST/$_DOCK_PORT 2>/dev/null ||
    nc -w 2 $_DOCK_HOST $_DOCK_PORT < "$_DOCK_TMP" 2>/dev/null ||
    socat -T2 - "TCP:$_DOCK_HOST:$_DOCK_PORT" < "$_DOCK_TMP" 2>/dev/null ||
    true
fi

rm -f "$_DOCK_TMP" 2>/dev/null

# ── Handle response ──
if [ -n "$_DOCK_RESP" ]; then
  if $_DOCK_BLOCK; then
    case "$_DOCK_RESP" in
      BLOCK:*) printf '%s\n' "${_DOCK_RESP#BLOCK:}" >&2; exit 2;;
    esac
  fi
  printf '%s\n' "$_DOCK_RESP"
fi

return 0 2>/dev/null || exit 0
