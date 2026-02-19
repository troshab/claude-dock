#!/usr/bin/env node
/* Claude Dock hook (fallback): direct stdin -> TCP forwarding.
 * Used when the daemon is not running or for backward compatibility. */
'use strict'

const fs = require('fs')
const lib = require('./claude-dock-lib')

function argValue (name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main () {
  const event = argValue('--event') || process.env.CLAUDE_DOCK_EVENT || 'unknown'

  let buf
  try {
    buf = fs.readFileSync(0)
  } catch {
    lib.writeRuntimeDebug('fallback_stdin_failed', { event })
    return 0
  }

  if (!buf.length) {
    lib.writeRuntimeDebug('fallback_stdin_empty', { event })
    return 0
  }

  const input = lib.decodeHookInputBuffer(buf)
  if (!input || !input.trim()) return 0

  const explicitSource = (argValue('--source') || '').trim().toLowerCase() || undefined
  const ctx = explicitSource
    ? { source: explicitSource, sourceReason: 'arg:--source' }
    : {}

  const result = lib.extractPayload(event, input, ctx)
  if (!result) {
    lib.writeRuntimeDebug('fallback_invalid_json', {
      event,
      input_bytes: buf.length,
      input_preview: lib.shortText(input, 600),
    })
    return 0
  }

  const { out, meta } = result

  // Sync bidirectional hooks: hold TCP socket, wait for dashboard response
  if (lib.SYNC_HOOKS[event]) {
    if (event === 'subagent_stop' && meta.stopHookActive) {
      lib.writeRuntimeDebug('fallback_sync_skip_active', { event })
      return 0
    }

    out.awaiting_response = true
    out.request_id = require('crypto').randomUUID()

    lib.writeRuntimeDebug('fallback_sync_send', {
      event,
      request_id: out.request_id,
      session_id: meta.sessionId || null,
    })

    const config = lib.SYNC_HOOKS[event]
    const response = await lib.sendPermissionAndWait(out, config.timeoutMs)
    const formatted = lib.formatSyncResponse(event, response)

    lib.writeRuntimeDebug('fallback_sync_result', {
      event,
      request_id: out.request_id,
      behavior: response?.behavior || null,
      exit_code: formatted.exitCode,
    })

    if (formatted.stdout) process.stdout.write(formatted.stdout + '\n')
    if (formatted.stderr) process.stderr.write(formatted.stderr + '\n')
    return formatted.exitCode
  }

  // Async hook: fire-and-forget to Tabby
  const transport = await lib.sendEventToTransport(out, 120).catch(e => ({
    ok: false, kind: 'tcp', stage: 'exception', error: String(e?.message ?? e),
  }))

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
  })

  lib.writeRuntimeDebug('fallback_event_sent', {
    event,
    event_id: out.event_id,
    transport_ok: transport.ok,
    transport_stage: transport.stage || null,
  })

  return 0
}

main()
  .then((code) => { process.exitCode = Number(code) || 0 })
  .catch((e) => {
    lib.writeRuntimeDebug('fallback_fatal', { error: String(e?.stack ?? e?.message ?? e) })
    process.exitCode = 0
  })
