#!/usr/bin/env node
/* Claude Code hook: append minimal JSONL event to ~/.claude/claude-code-zit/events.jsonl */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const net = require('net')
const { spawn } = require('child_process')

function argValue (name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  return process.argv[i + 1] ?? null
}

function getNested (obj, keys) {
  let cur = obj
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

function pickString (obj, candidates) {
  for (const c of candidates) {
    const v = Array.isArray(c) ? getNested(obj, c) : obj?.[c]
    if (typeof v === 'string' && v.trim()) {
      return v.trim()
    }
  }
  return undefined
}

function safeJsonParse (s) {
  try { return JSON.parse(s) } catch { return null }
}

function rotateIfLarge (filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath)
    if (st.size < maxBytes) return
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    fs.renameSync(filePath, `${filePath}.${ts}.bak`)
  } catch {
    // ignore
  }
}

function shortText (s, max = 400) {
  const text = String(s || '').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  if (text.length <= max) {
    return text
  }
  return text.slice(0, max) + `...(+${text.length - max} chars)`
}

function sanitizeFilePart (s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown'
}

function debugDir () {
  return path.join(os.homedir(), '.claude', 'claude-code-zit', 'debug')
}

function sessionDebugPath (sessionId, transcriptPath) {
  const sid = (sessionId || '').trim()
  if (sid) {
    return path.join(debugDir(), `session-${sanitizeFilePart(sid)}.log`)
  }
  if (transcriptPath) {
    const base = path.basename(transcriptPath).replace(/\.jsonl$/i, '')
    return path.join(debugDir(), `session-${sanitizeFilePart(base)}.log`)
  }
  return path.join(debugDir(), 'session-unknown.log')
}

function detectSource (payload) {
  const explicitArg = (argValue('--source') || '').trim().toLowerCase()
  if (explicitArg) {
    return { source: explicitArg, reason: 'arg:--source' }
  }

  const explicit = (process.env.CLAUDE_CODE_ZIT_SOURCE || '').trim().toLowerCase()
  if (explicit) {
    return { source: explicit, reason: 'env:CLAUDE_CODE_ZIT_SOURCE' }
  }

  const payloadSource = pickString(payload, [
    'source',
    ['metadata', 'source'],
    ['hook', 'source'],
  ])
  if (payloadSource) {
    return { source: payloadSource.toLowerCase(), reason: 'payload:source' }
  }

  const termProgram = (process.env.TERM_PROGRAM || '').trim().toLowerCase()
  if (termProgram.includes('tabby')) {
    return { source: 'tabby', reason: 'env:TERM_PROGRAM' }
  }

  return { source: undefined, reason: 'unknown' }
}

function collectEnvSnapshot () {
  const out = {}
  const interesting = [
    'CLAUDE_CODE_ZIT_SOURCE',
    'CLAUDE_CODE_ZIT_TABBY_SESSION',
    'CLAUDE_CODE_ZIT_TERMINAL_ID',
    'TERM_PROGRAM',
    'TERM',
    'WT_SESSION',
    'SHELL',
    'COMSPEC',
    'PROMPT',
  ]
  for (const key of interesting) {
    out[key] = process.env[key] || null
  }

  // Capture any explicit Tabby-related env keys for diagnostics.
  const tabbyKeys = Object.keys(process.env).filter(k => /tabby/i.test(k)).sort()
  if (tabbyKeys.length) {
    out.tabbyLikeEnv = tabbyKeys.map(k => `${k}=${process.env[k] ?? ''}`)
  }
  return out
}

function writeRuntimeDebug (kind, data) {
  try {
    fs.mkdirSync(debugDir(), { recursive: true })
    const filePath = path.join(debugDir(), 'hook-runtime.log')
    rotateIfLarge(filePath, 15 * 1024 * 1024)
    const line = {
      ts_iso: new Date().toISOString(),
      ts_ms: Date.now(),
      kind,
      data: data || {},
      process: {
        pid: process.pid,
        ppid: process.ppid,
      },
    }
    fs.appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf8')
  } catch {
    // must not break hook pipeline
  }
}

function writeDebugLine (info) {
  try {
    fs.mkdirSync(debugDir(), { recursive: true })
    const filePath = sessionDebugPath(info.sessionId, info.transcriptPath)
    const line = {
      ts_iso: new Date().toISOString(),
      ts_ms: Date.now(),
      event: info.event || null,
      event_id: info.eventId || null,
      source: info.source || null,
      source_reason: info.sourceReason || null,
      session_id: info.sessionId || null,
      cwd: info.cwd || null,
      transcript_path: info.transcriptPath || null,
      tool_name: info.toolName || null,
      notification_type: info.notificationType || null,
      message: info.message || null,
      permission_mode: info.permissionMode || null,
      tabby_session: info.tabbySession || null,
      terminal_id: info.terminalId || null,
      host_pid: info.hostPid || null,
      payload_sha1: info.payloadSha1 || null,
      payload_preview: info.payloadPreview || null,
      payload_bytes: info.payloadBytes || null,
      process: {
        pid: process.pid,
        ppid: process.ppid,
        argv: process.argv.slice(2),
        execPath: process.execPath,
      },
      env: collectEnvSnapshot(),
    }
    fs.appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf8')
  } catch {
    // debug must never break hooks
  }
}

function decodeHookInputBuffer (buf) {
  let input = buf.toString('utf8').replace(/^\uFEFF/, '')
  // Windows PowerShell pipes UTF-16LE by default; tolerate it.
  if (input.includes('\u0000')) {
    input = buf.toString('utf16le').replace(/^\uFEFF/, '')
  }
  return input
}

function queueDir () {
  return path.join(os.homedir(), '.claude', 'claude-code-zit', 'hook-queue')
}

const ZIT_TCP_PORT = 19542

function isInsideDocker () {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')
  } catch { return false }
}

function transportEndpoint () {
  if (isInsideDocker()) {
    return {
      kind: 'tcp',
      host: 'host.docker.internal',
      port: ZIT_TCP_PORT,
    }
  }
  const baseDir = path.join(os.homedir(), '.claude', 'claude-code-zit')
  if (process.platform === 'win32') {
    const homeKey = os.homedir().toLowerCase()
    const hash = crypto.createHash('sha1').update(homeKey).digest('hex').slice(0, 10)
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\claude-code-zit-${hash}-events-v1`,
    }
  }
  return {
    kind: 'unix',
    path: path.join(baseDir, 'hook-events.sock'),
  }
}

function sendEventToTransport (out, timeoutMs = 120) {
  const endpoint = transportEndpoint()
  return new Promise((resolve) => {
    let settled = false
    let wrote = false
    const sock = endpoint.kind === 'tcp'
      ? net.createConnection({ host: endpoint.host, port: endpoint.port })
      : net.createConnection(endpoint.path)

    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { }
      resolve({
        ok: !!result?.ok,
        kind: endpoint.kind,
        path: endpoint.path || `${endpoint.host}:${endpoint.port}`,
        stage: result?.stage || null,
        error: result?.error ? String(result.error) : null,
      })
    }

    const timer = setTimeout(() => {
      finish({ ok: false, stage: 'timeout', error: `timeout_${timeoutMs}ms` })
    }, timeoutMs)

    sock.once('connect', () => {
      try {
        sock.setNoDelay(true)
      } catch { }
      sock.write(JSON.stringify(out) + '\n', 'utf8', (err) => {
        if (err) {
          finish({ ok: false, stage: 'write', error: err?.message || String(err) })
          return
        }
        wrote = true
        sock.end()
        finish({ ok: true, stage: 'write_ok' })
      })
    })

    sock.once('error', (err) => {
      finish({ ok: false, stage: wrote ? 'io' : 'connect', error: err?.message || String(err) })
    })
  })
}

async function processPayload (event, input, inputBytes) {
  const data = safeJsonParse(input)
  if (!data || typeof data !== 'object') {
    writeRuntimeDebug('stdin_invalid_json', {
      event,
      input_bytes: inputBytes,
      input_preview: shortText(input, 600),
    })
    return 0
  }

  const cwd = pickString(data, [
    'cwd',
    ['workspace', 'current_dir'],
    ['workspace', 'currentDir'],
    ['workspace', 'cwd'],
  ])

  const sessionId = pickString(data, [
    'session_id',
    'sessionId',
    ['session', 'id'],
    ['session', 'session_id'],
  ])

  const transcriptPath = pickString(data, [
    'transcript_path',
    'transcriptPath',
    ['transcript', 'path'],
  ])

  const title = pickString(data, [
    'title',
    ['workspace', 'title'],
    ['workspace', 'name'],
  ])

  const toolName = pickString(data, [
    'tool_name',
    'toolName',
    ['tool', 'name'],
    ['tool', 'tool_name'],
  ])

  const message = pickString(data, [
    'message',
    ['notification', 'message'],
  ])

  const notificationType = pickString(data, [
    'notification_type',
    'notificationType',
    ['notification', 'type'],
  ])

  const permissionMode = pickString(data, [
    'permission_mode',
    'permissionMode',
  ])

  const sourceInfo = detectSource(data)
  const source = sourceInfo.source
  const tabbySession = (process.env.CLAUDE_CODE_ZIT_TABBY_SESSION || '').trim() || undefined
  const terminalId = (process.env.CLAUDE_CODE_ZIT_TERMINAL_ID || '').trim() || undefined
  const hostPid = Number(process.ppid) || undefined
  const payloadSha1 = crypto.createHash('sha1').update(input, 'utf8').digest('hex')
  const payloadPreview = shortText(input, 600)
  const eventId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`

  const out = {
    ts: Date.now(),
    event,
    event_id: eventId,
    source,
    tabby_session: tabbySession,
    terminal_id: terminalId,
    host_pid: hostPid,
    cwd,
    session_id: sessionId,
    title,
    transcript_path: transcriptPath,
    tool_name: toolName,
    message,
    notification_type: notificationType,
    permission_mode: permissionMode,
  }

  const endpoint = transportEndpoint()
  const transportPromise = sendEventToTransport(out, 120).catch((e) => ({
    ok: false,
    kind: endpoint.kind,
    path: endpoint.path || `${endpoint.host}:${endpoint.port}`,
    stage: 'exception',
    error: String(e?.message ?? e),
  }))

  // Keep file size bounded.
  const dir = path.join(os.homedir(), '.claude', 'claude-code-zit')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'events.jsonl')
  rotateIfLarge(filePath, 25 * 1024 * 1024)

  fs.appendFileSync(filePath, JSON.stringify(out) + '\n', 'utf8')
  const transport = await transportPromise

  writeDebugLine({
    event,
    eventId,
    source,
    sourceReason: sourceInfo.reason,
    sessionId,
    cwd,
    transcriptPath,
    toolName,
    notificationType,
    message,
    permissionMode,
    tabbySession,
    terminalId,
    hostPid,
    payloadSha1,
    payloadPreview,
    payloadBytes: inputBytes,
  })

  writeRuntimeDebug('event_written', {
    event,
    event_id: eventId,
    source: source || null,
    source_reason: sourceInfo.reason,
    session_id: sessionId || null,
    cwd: cwd || null,
    transcript_path: transcriptPath || null,
    tabby_session: tabbySession || null,
    terminal_id: terminalId || null,
    host_pid: hostPid || null,
    payload_sha1: payloadSha1,
    input_bytes: inputBytes,
    transport_ok: !!transport.ok,
    transport_kind: transport.kind || null,
    transport_stage: transport.stage || null,
    transport_error: transport.error || null,
  })

  return 0
}

async function runWorker () {
  const event = argValue('--event') || process.env.CLAUDE_CODE_ZIT_EVENT || process.env.CLAUDE_CODE_ZIT_WORKER_EVENT || 'unknown'
  const payloadFile = argValue('--payload-file') || process.env.CLAUDE_CODE_ZIT_WORKER_PAYLOAD_FILE || ''
  const expectedBytes = Number(argValue('--input-bytes') || process.env.CLAUDE_CODE_ZIT_WORKER_INPUT_BYTES || 0) || 0
  if (!payloadFile) {
    writeRuntimeDebug('worker_missing_payload_file', { event })
    return 0
  }

  let buf
  try {
    buf = fs.readFileSync(payloadFile)
  } catch (e) {
    writeRuntimeDebug('worker_payload_read_failed', {
      event,
      payload_file: payloadFile,
      error: String(e?.message ?? e),
    })
    return 0
  } finally {
    try { fs.unlinkSync(payloadFile) } catch { }
  }

  const inputBytes = expectedBytes > 0 ? expectedBytes : buf.length
  const input = decodeHookInputBuffer(buf)
  if (!input || !input.trim()) {
    writeRuntimeDebug('worker_payload_empty', {
      event,
      input_bytes: inputBytes,
      payload_file: payloadFile,
    })
    return 0
  }

  return await processPayload(event, input, inputBytes)
}

async function runDispatcher () {
  const event = argValue('--event') || process.env.CLAUDE_CODE_ZIT_EVENT || 'unknown'
  let buf
  try {
    buf = fs.readFileSync(0)
  } catch {
    writeRuntimeDebug('stdin_read_failed', { event })
    return 0
  }

  const inputBytes = buf.length
  if (!inputBytes) {
    writeRuntimeDebug('stdin_empty', { event, input_bytes: inputBytes })
    return 0
  }

  let payloadFile = ''
  try {
    const dir = queueDir()
    fs.mkdirSync(dir, { recursive: true })
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    payloadFile = path.join(dir, `hook-${id}.stdin`)
    fs.writeFileSync(payloadFile, buf)
  } catch (e) {
    writeRuntimeDebug('queue_write_failed', {
      event,
      input_bytes: inputBytes,
      error: String(e?.message ?? e),
    })
    // Fallback to inline processing if queue write fails.
    const input = decodeHookInputBuffer(buf)
    return await processPayload(event, input, inputBytes)
  }

  try {
    const child = spawn(process.execPath, [
      __filename,
      '--worker',
      '--event', event,
      '--payload-file', payloadFile,
      '--input-bytes', String(inputBytes),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_CODE_ZIT_WORKER_EVENT: event,
        CLAUDE_CODE_ZIT_WORKER_PAYLOAD_FILE: payloadFile,
        CLAUDE_CODE_ZIT_WORKER_INPUT_BYTES: String(inputBytes),
      },
    })
    child.unref()
    writeRuntimeDebug('worker_spawned', {
      event,
      input_bytes: inputBytes,
      payload_file: payloadFile,
      worker_pid: child.pid || null,
    })
    return 0
  } catch (e) {
    writeRuntimeDebug('worker_spawn_failed', {
      event,
      input_bytes: inputBytes,
      payload_file: payloadFile,
      error: String(e?.message ?? e),
    })
    // Cleanup queued payload and fallback to inline path.
    try { fs.unlinkSync(payloadFile) } catch { }
    const input = decodeHookInputBuffer(buf)
    return await processPayload(event, input, inputBytes)
  }
}

async function main () {
  if (process.argv.includes('--worker')) {
    return await runWorker()
  }
  return await runDispatcher()
}

main()
  .then((code) => {
    process.exitCode = Number(code) || 0
  })
  .catch((e) => {
    writeRuntimeDebug('hook_fatal', {
      error: String(e?.stack ?? e?.message ?? e),
    })
    process.exitCode = 0
  })
