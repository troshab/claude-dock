#!/usr/bin/env node
/* Claude Dock daemon: persistent TCP proxy for hook events */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const net = require('net')

const lib = require('./claude-dock-lib')

// ─── Paths ──────────────────────────────────────────────────────────

const DOCK_DIR = path.join(os.homedir(), '.claude', 'claude-dock')
const PID_FILE = path.join(DOCK_DIR, 'daemon.pid')
const PORT_FILE = path.join(DOCK_DIR, 'daemon.port')

// ─── State ──────────────────────────────────────────────────────────

const INACTIVITY_MS = 30 * 60 * 1000
const TABBY_PROBE_INTERVAL = 30_000
const startTime = Date.now()

let tabbyAvailable = false
let lastTabbyCheck = 0
let inactivityTimer = null
let activeConnections = 0
let server = null
let shutdownStarted = false

// ─── Tabby probe ────────────────────────────────────────────────────

function probeTabby () {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: lib.transportHost(), port: lib.TABBY_TCP_PORT })
    sock.setTimeout(500)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
}

async function checkTabby () {
  const now = Date.now()
  if (now - lastTabbyCheck < TABBY_PROBE_INTERVAL) return tabbyAvailable
  lastTabbyCheck = now
  tabbyAvailable = await probeTabby()
  return tabbyAvailable
}

// ─── Lifecycle ──────────────────────────────────────────────────────

function resetInactivityTimer () {
  if (inactivityTimer) clearTimeout(inactivityTimer)
  inactivityTimer = setTimeout(shutdown, INACTIVITY_MS)
}

let cleaned = false
function cleanup () {
  if (cleaned) return
  cleaned = true
  try { fs.unlinkSync(PID_FILE) } catch {}
  try { fs.unlinkSync(PORT_FILE) } catch {}
}

function shutdown () {
  if (shutdownStarted) return
  shutdownStarted = true
  lib.writeRuntimeDebug('daemon_shutdown', {
    active_connections: activeConnections,
    uptime_ms: Date.now() - startTime,
  })
  if (server) try { server.close() } catch {}
  cleanup()
  setTimeout(() => process.exit(0), activeConnections > 0 ? 5000 : 100)
}

function isProcessAlive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function acquireLock () {
  fs.mkdirSync(DOCK_DIR, { recursive: true })
  try {
    const existingPid = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    if (existingPid && isProcessAlive(existingPid)) return false
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8')
  return true
}

// ─── Protocol parsing ───────────────────────────────────────────────

/**
 * Parse daemon protocol data:
 *   Line 1: event_name
 *   Line 2: source|tabby_session|terminal_id|host_pid
 *   Line 3+: JSON payload
 *
 * Tolerates missing metadata line (JSON directly after event name).
 */
function parseProtocol (data) {
  const firstNl = data.indexOf('\n')
  if (firstNl < 0) return null

  const event = data.slice(0, firstNl).trim()
  if (!event) return null

  const rest = data.slice(firstNl + 1)
  const secondNl = rest.indexOf('\n')

  if (secondNl < 0) {
    // Only 2 parts: event + one more string
    const remaining = rest.trim()
    if (remaining.startsWith('{')) {
      return { event, source: '', tabbySession: '', terminalId: '', hostPid: 0, json: remaining }
    }
    const parts = remaining.split('|')
    return {
      event,
      source: (parts[0] || '').trim(),
      tabbySession: (parts[1] || '').trim(),
      terminalId: (parts[2] || '').trim(),
      hostPid: Number(parts[3]) || 0,
      json: '',
    }
  }

  const metaLine = rest.slice(0, secondNl).trim()
  const json = rest.slice(secondNl + 1).trim()

  if (metaLine.startsWith('{')) {
    return { event, source: '', tabbySession: '', terminalId: '', hostPid: 0, json: metaLine + (json ? '\n' + json : '') }
  }

  const parts = metaLine.split('|')
  return {
    event,
    source: (parts[0] || '').trim(),
    tabbySession: (parts[1] || '').trim(),
    terminalId: (parts[2] || '').trim(),
    hostPid: Number(parts[3]) || 0,
    json,
  }
}

// ─── Connection handling ────────────────────────────────────────────

function handleConnection (sock) {
  activeConnections++
  resetInactivityTimer()

  let buf = ''
  let finished = false
  let dataTimer = null

  function connDone () {
    activeConnections--
    resetInactivityTimer()
  }

  function finish () {
    if (finished) return
    finished = true
    if (dataTimer) clearTimeout(dataTimer)
    sock.removeAllListeners('data')
    sock.removeAllListeners('end')

    // Empty connection (e.g., port probe from SessionStart) — silently close
    if (!buf.trim()) {
      try { sock.end() } catch {}
      connDone()
      return
    }

    const parsed = parseProtocol(buf)
    if (!parsed || !parsed.event) {
      lib.writeRuntimeDebug('daemon_parse_failed', {
        buf_length: buf.length,
        buf_preview: lib.shortText(buf, 300),
      })
      try { sock.end() } catch {}
      connDone()
      return
    }

    if (lib.SYNC_HOOKS[parsed.event]) {
      handleSyncHook(sock, parsed)
        .catch((e) => {
          lib.writeRuntimeDebug('daemon_sync_error', {
            event: parsed.event,
            error: String(e?.message ?? e),
          })
        })
        .finally(() => {
          try { sock.end() } catch {}
          connDone()
        })
    } else {
      handleAsyncHook(parsed).catch(() => {})
      try { sock.end() } catch {}
      connDone()
    }
  }

  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    // Reset safety-net timer on each chunk. The primary trigger is 'end'
    // (connection close), but hung connections need a timeout fallback.
    // 300ms accommodates the gap between printf (metadata) and cat (JSON
    // from stdin) in bash hooks on Windows/MSYS.
    if (dataTimer) clearTimeout(dataTimer)
    dataTimer = setTimeout(finish, 300)
  })

  sock.once('end', finish)

  sock.once('error', (err) => {
    if (!finished) {
      finished = true
      if (dataTimer) clearTimeout(dataTimer)
      lib.writeRuntimeDebug('daemon_conn_error', { error: err?.message })
      connDone()
    }
  })
}

// ─── Async hook processing ──────────────────────────────────────────

function buildContext (parsed) {
  return {
    source: parsed.source || undefined,
    sourceReason: parsed.source ? 'daemon:header' : undefined,
    tabbySession: parsed.tabbySession || undefined,
    terminalId: parsed.terminalId || undefined,
    hostPid: parsed.hostPid || undefined,
  }
}

function writeEventDebug (event, out, meta, isSync) {
  lib.writeDebugLine({
    event,
    eventId: out.event_id,
    source: meta.sourceInfo.source,
    sourceReason: meta.sourceInfo.reason,
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    transcriptPath: meta.transcriptPath,
    toolName: meta.toolName,
    notificationType: meta.notificationType,
    message: meta.message,
    permissionMode: meta.permissionMode,
    tabbySession: meta.tabbySession,
    terminalId: meta.terminalId,
    hostPid: meta.hostPid,
    payloadSha1: meta.payloadSha1,
    payloadPreview: meta.payloadPreview,
    payloadBytes: meta.payloadBytes,
    processExtra: { role: 'daemon', ...(isSync ? { sync: true } : {}) },
  })
}

async function handleAsyncHook (parsed) {
  const ctx = buildContext(parsed)
  const result = lib.extractPayload(parsed.event, parsed.json, ctx)
  if (!result) {
    lib.writeRuntimeDebug('daemon_extract_failed', {
      event: parsed.event,
      json_preview: lib.shortText(parsed.json, 200),
    })
    return
  }

  const { out, meta } = result
  const available = await checkTabby()

  if (available) {
    const transport = await lib.sendEventToTransport(out, 120).catch(e => ({
      ok: false, stage: 'exception', error: String(e?.message ?? e),
    }))
    lib.writeRuntimeDebug('daemon_async_sent', {
      event: parsed.event,
      event_id: out.event_id,
      session_id: meta.sessionId || null,
      transport_ok: transport.ok,
      transport_stage: transport.stage || null,
    })
  } else {
    lib.writeRuntimeDebug('daemon_async_skip', {
      event: parsed.event,
      event_id: out.event_id,
      session_id: meta.sessionId || null,
    })
  }

  writeEventDebug(parsed.event, out, meta, false)
}

// ─── Sync hook processing ───────────────────────────────────────────

async function handleSyncHook (sock, parsed) {
  // Skip stop_hook_active loop prevention
  if (parsed.event === 'subagent_stop') {
    const data = lib.safeJsonParse(parsed.json)
    if (data && (data.stop_hook_active ?? data.stopHookActive)) {
      lib.writeRuntimeDebug('daemon_sync_skip_active', { event: parsed.event })
      sock.write('\n')
      return
    }
  }

  const ctx = buildContext(parsed)
  const result = lib.extractPayload(parsed.event, parsed.json, ctx)
  if (!result) {
    lib.writeRuntimeDebug('daemon_sync_extract_failed', { event: parsed.event })
    sock.write('\n')
    return
  }

  const { out, meta } = result
  const config = lib.SYNC_HOOKS[parsed.event]
  const available = await checkTabby()

  let responseText = ''
  if (available) {
    out.awaiting_response = true
    out.request_id = crypto.randomUUID()

    lib.writeRuntimeDebug('daemon_sync_send', {
      event: parsed.event,
      request_id: out.request_id,
      session_id: meta.sessionId || null,
      tool_name: meta.toolName || null,
    })

    const response = await lib.sendPermissionAndWait(out, config.timeoutMs)
    responseText = lib.encodeDaemonResponse(parsed.event, response)

    lib.writeRuntimeDebug('daemon_sync_result', {
      event: parsed.event,
      request_id: out.request_id,
      behavior: response?.behavior || null,
      response_text: lib.shortText(responseText, 200),
    })
  } else {
    lib.writeRuntimeDebug('daemon_sync_no_tabby', {
      event: parsed.event,
      event_id: out.event_id,
    })
  }

  sock.write(responseText + '\n')
  writeEventDebug(parsed.event, out, meta, true)
}

// ─── Startup ────────────────────────────────────────────────────────

async function main () {
  if (!acquireLock()) {
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('exit', cleanup)

  // Start TCP server immediately (before probing Tabby) so bash hooks
  // can connect as soon as the 300ms sleep expires after daemon launch.
  server = net.createServer(handleConnection)

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      cleanup()
      process.exit(0)
    }
    lib.writeRuntimeDebug('daemon_server_error', { error: err?.message })
  })

  await new Promise((resolve) => {
    server.listen(lib.DAEMON_TCP_PORT, '127.0.0.1', () => {
      const port = server.address().port
      fs.writeFileSync(PORT_FILE, String(port), 'utf8')
      lib.writeRuntimeDebug('daemon_started', { pid: process.pid, port })
      resolve()
    })
  })

  // Probe Tabby after server is listening (may take up to 500ms if Tabby is down)
  tabbyAvailable = await probeTabby()
  lastTabbyCheck = Date.now()
  lib.writeRuntimeDebug('daemon_tabby_probe', { available: tabbyAvailable })

  resetInactivityTimer()
}

main().catch((e) => {
  lib.writeRuntimeDebug('daemon_fatal', { error: String(e?.stack ?? e?.message ?? e) })
  cleanup()
  process.exit(1)
})
