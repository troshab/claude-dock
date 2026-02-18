#!/usr/bin/env node
/* Claude Dock hook: forward events to Tabby via TCP transport */

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
  return path.join(os.homedir(), '.claude', 'claude-dock', 'debug')
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

function summarizeToolInput (input, toolName) {
  if (!input || typeof input !== 'object') return undefined
  const tool = (toolName || '').toLowerCase()
  try {
    if (tool === 'bash') {
      return JSON.stringify({
        command: shortText(input.command || '', 300),
        ...(input.description ? { description: shortText(input.description, 100) } : {}),
        ...(input.timeout ? { timeout: input.timeout } : {}),
        ...(input.run_in_background ? { run_in_background: true } : {}),
      })
    }
    if (tool === 'edit') {
      return JSON.stringify({
        file_path: input.file_path || '',
        old_string: shortText(input.old_string || '', 80),
        new_string: shortText(input.new_string || '', 80),
        ...(input.replace_all ? { replace_all: true } : {}),
      })
    }
    if (tool === 'write') {
      return JSON.stringify({
        file_path: input.file_path || '',
        content_length: (input.content || '').length,
      })
    }
    if (tool === 'read') {
      return JSON.stringify({
        file_path: input.file_path || '',
        ...(input.offset ? { offset: input.offset } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      })
    }
    if (tool === 'grep') {
      return JSON.stringify({
        pattern: input.pattern || '',
        ...(input.path ? { path: input.path } : {}),
        ...(input.glob ? { glob: input.glob } : {}),
        ...(input.output_mode ? { output_mode: input.output_mode } : {}),
      })
    }
    if (tool === 'glob') {
      return JSON.stringify({
        pattern: input.pattern || '',
        ...(input.path ? { path: input.path } : {}),
      })
    }
    if (tool === 'task') {
      return JSON.stringify({
        subagent_type: input.subagent_type || '',
        description: shortText(input.description || '', 100),
        prompt: shortText(input.prompt || '', 200),
        ...(input.model ? { model: input.model } : {}),
      })
    }
    if (tool === 'websearch') {
      return JSON.stringify({
        query: input.query || '',
      })
    }
    if (tool === 'webfetch') {
      return JSON.stringify({
        url: input.url || '',
        prompt: shortText(input.prompt || '', 100),
      })
    }
    if (tool === 'askuserquestion') {
      const qs = Array.isArray(input.questions) ? input.questions : []
      if (qs.length) {
        const q = qs[0]
        const opts = (Array.isArray(q.options) ? q.options : []).map(o => o.label).filter(Boolean)
        return JSON.stringify({
          question: shortText(q.question || '', 200),
          ...(opts.length ? { options: opts.join(', ') } : {}),
        })
      }
    }
    // MCP or unknown tools: truncated JSON
    return shortText(JSON.stringify(input), 500)
  } catch {
    return shortText(JSON.stringify(input), 500)
  }
}

function detectSource (payload) {
  const explicitArg = (argValue('--source') || '').trim().toLowerCase()
  if (explicitArg) {
    return { source: explicitArg, reason: 'arg:--source' }
  }

  const explicit = (process.env.CLAUDE_DOCK_SOURCE || '').trim().toLowerCase()
  if (explicit) {
    return { source: explicit, reason: 'env:CLAUDE_DOCK_SOURCE' }
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
    'CLAUDE_DOCK_SOURCE',
    'CLAUDE_DOCK_TABBY_SESSION',
    'CLAUDE_DOCK_TERMINAL_ID',
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
  return path.join(os.homedir(), '.claude', 'claude-dock', 'hook-queue')
}

const DOCK_TCP_PORT = 19542

function isInsideDocker () {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')
  } catch { return false }
}

function transportHost () {
  return isInsideDocker() ? 'host.docker.internal' : '127.0.0.1'
}

function sendEventToTransport (out, timeoutMs = 120) {
  const host = transportHost()
  return new Promise((resolve) => {
    let settled = false
    let wrote = false
    const sock = net.createConnection({ host, port: DOCK_TCP_PORT })

    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { }
      resolve({
        ok: !!result?.ok,
        kind: 'tcp',
        path: `${host}:${DOCK_TCP_PORT}`,
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

  const subagentId = pickString(data, [
    'subagent_id',
    'subagentId',
  ])

  const subagentType = pickString(data, [
    'subagent_type',
    'subagentType',
    'agent_type',
    'agentType',
  ])

  const hookType = pickString(data, [
    'hook_type',
    'hookType',
    ['hook', 'type'],
  ])

  // Extended fields from all hook event types
  const model = pickString(data, ['model'])
  const agentType = pickString(data, ['agent_type', 'agentType'])
  const prompt = shortText(pickString(data, ['prompt']) || '', 300)
  const toolUseId = pickString(data, ['tool_use_id', 'toolUseId'])
  const error = shortText(pickString(data, ['error']) || '', 400)
  const isInterrupt = data?.is_interrupt ?? data?.isInterrupt ?? undefined
  const stopHookActive = data?.stop_hook_active ?? data?.stopHookActive ?? undefined
  const agentId = pickString(data, ['agent_id', 'agentId']) || subagentId
  const agentTranscriptPath = pickString(data, [
    'agent_transcript_path', 'agentTranscriptPath',
  ])
  const taskId = pickString(data, ['task_id', 'taskId'])
  const taskSubject = pickString(data, ['task_subject', 'taskSubject'])
  const taskDescription = shortText(pickString(data, ['task_description', 'taskDescription']) || '', 300)
  const teammateName = pickString(data, ['teammate_name', 'teammateName'])
  const teamName = pickString(data, ['team_name', 'teamName'])
  const trigger = pickString(data, ['trigger'])
  const customInstructions = shortText(pickString(data, ['custom_instructions', 'customInstructions']) || '', 200)
  const reason = pickString(data, ['reason'])

  // Summarize tool_input: extract key fields, strip large content
  const toolInput = summarizeToolInput(data?.tool_input, toolName)
  // Truncated tool response
  const toolResponse = data?.tool_response
    ? shortText(typeof data.tool_response === 'string' ? data.tool_response : JSON.stringify(data.tool_response), 500)
    : undefined

  const sourceInfo = detectSource(data)
  const source = sourceInfo.source
  const tabbySession = (process.env.CLAUDE_DOCK_TABBY_SESSION || '').trim() || undefined
  const terminalId = (process.env.CLAUDE_DOCK_TERMINAL_ID || '').trim() || undefined
  const hostPid = Number(process.env.CLAUDE_DOCK_HOST_PID || process.ppid) || undefined
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
    hook_type: hookType,
    // Tool details
    tool_input: toolInput || undefined,
    tool_response: toolResponse || undefined,
    tool_use_id: toolUseId || undefined,
    // Error
    error: error || undefined,
    is_interrupt: isInterrupt ?? undefined,
    // User prompt
    prompt: prompt || undefined,
    // Session metadata
    model: model || undefined,
    agent_type: agentType || subagentType || undefined,
    // Subagent
    agent_id: agentId || undefined,
    subagent_type: subagentType || undefined,
    agent_transcript_path: agentTranscriptPath || undefined,
    stop_hook_active: stopHookActive ?? undefined,
    // Task
    task_id: taskId || undefined,
    task_subject: taskSubject || undefined,
    task_description: taskDescription || undefined,
    // Team
    teammate_name: teammateName || undefined,
    team_name: teamName || undefined,
    // Compact
    trigger: trigger || undefined,
    custom_instructions: customInstructions || undefined,
    // Session end
    reason: reason || undefined,
  }

  const transportPromise = sendEventToTransport(out, 120).catch((e) => ({
    ok: false,
    kind: 'tcp',
    path: `${transportHost()}:${DOCK_TCP_PORT}`,
    stage: 'exception',
    error: String(e?.message ?? e),
  }))

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
  const event = argValue('--event') || process.env.CLAUDE_DOCK_EVENT || process.env.CLAUDE_DOCK_WORKER_EVENT || 'unknown'
  const payloadFile = argValue('--payload-file') || process.env.CLAUDE_DOCK_WORKER_PAYLOAD_FILE || ''
  const expectedBytes = Number(argValue('--input-bytes') || process.env.CLAUDE_DOCK_WORKER_INPUT_BYTES || 0) || 0
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
  const event = argValue('--event') || process.env.CLAUDE_DOCK_EVENT || 'unknown'
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
        CLAUDE_DOCK_HOST_PID: String(process.ppid || ''),
        CLAUDE_DOCK_WORKER_EVENT: event,
        CLAUDE_DOCK_WORKER_PAYLOAD_FILE: payloadFile,
        CLAUDE_DOCK_WORKER_INPUT_BYTES: String(inputBytes),
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

function sendPermissionAndWait (out, timeoutMs) {
  const host = transportHost()
  return new Promise((resolve) => {
    let settled = false
    let buf = ''
    const sock = net.createConnection({ host, port: DOCK_TCP_PORT })
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      try { sock.destroy() } catch {}
      resolve(r)
    }
    const t = setTimeout(() => finish(null), timeoutMs)
    sock.once('connect', () => {
      try { sock.setNoDelay(true) } catch {}
      try { sock.setKeepAlive(true, 30000) } catch {}
      sock.write(JSON.stringify(out) + '\n', 'utf8')
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const idx = buf.indexOf('\n')
      if (idx >= 0) finish(safeJsonParse(buf.slice(0, idx).trim()))
    })
    sock.on('end', () => finish(buf.trim() ? safeJsonParse(buf.trim()) : null))
    sock.once('error', () => finish(null))
  })
}

// Sync bidirectional hooks: hold TCP socket open, wait for dashboard response
const SYNC_HOOKS = {
  permission_request: { timeoutMs: 590_000 },
  subagent_stop:     { timeoutMs: 30_000 },
  teammate_idle:     { timeoutMs: 30_000 },
  task_completed:    { timeoutMs: 30_000 },
}

function formatSyncResponse (event, response) {
  if (!response || !response.behavior) {
    return { stdout: null, stderr: null, exitCode: 0 }
  }

  // PermissionRequest: { decision: { behavior, message } }
  if (event === 'permission_request') {
    const decision = { behavior: response.behavior }
    if (response.behavior === 'deny' && response.message) {
      decision.message = response.message
    }
    return { stdout: JSON.stringify({ decision }), stderr: null, exitCode: 0 }
  }

  // SubagentStop: { decision: "block", reason: "..." }
  if (event === 'subagent_stop') {
    if (response.behavior === 'block') {
      return {
        stdout: JSON.stringify({ decision: 'block', reason: response.message || 'Continue from Claude Dock' }),
        stderr: null,
        exitCode: 0,
      }
    }
    return { stdout: null, stderr: null, exitCode: 0 }
  }

  // TeammateIdle / TaskCompleted: exit code 2 + stderr to block
  if (event === 'teammate_idle' || event === 'task_completed') {
    if (response.behavior === 'block') {
      return {
        stdout: null,
        stderr: response.message || 'Blocked from Claude Dock',
        exitCode: 2,
      }
    }
    return { stdout: null, stderr: null, exitCode: 0 }
  }

  return { stdout: null, stderr: null, exitCode: 0 }
}

async function runSyncHook () {
  const event = argValue('--event') || process.env.CLAUDE_DOCK_EVENT || 'unknown'
  const config = SYNC_HOOKS[event]
  if (!config) return 0

  let buf
  try {
    buf = fs.readFileSync(0)
  } catch {
    writeRuntimeDebug('sync_hook_stdin_failed', { event })
    return 0
  }

  const inputBytes = buf.length
  if (!inputBytes) {
    writeRuntimeDebug('sync_hook_stdin_empty', { event })
    return 0
  }

  const input = decodeHookInputBuffer(buf)
  const data = safeJsonParse(input)
  if (!data || typeof data !== 'object') {
    writeRuntimeDebug('sync_hook_invalid_json', { event, input_bytes: inputBytes })
    return 0
  }

  // Skip Stop/SubagentStop if already continuing from a stop hook (prevent loops)
  if ((event === 'stop' || event === 'subagent_stop') && (data.stop_hook_active ?? data.stopHookActive)) {
    writeRuntimeDebug('sync_hook_skip_active', { event })
    return 0
  }

  // Extract fields (same logic as processPayload)
  const cwd = pickString(data, ['cwd', ['workspace', 'current_dir'], ['workspace', 'currentDir'], ['workspace', 'cwd']])
  const sessionId = pickString(data, ['session_id', 'sessionId', ['session', 'id'], ['session', 'session_id']])
  const transcriptPath = pickString(data, ['transcript_path', 'transcriptPath', ['transcript', 'path']])
  const title = pickString(data, ['title', ['workspace', 'title'], ['workspace', 'name']])
  const toolName = pickString(data, ['tool_name', 'toolName', ['tool', 'name'], ['tool', 'tool_name']])
  const message = pickString(data, ['message', ['notification', 'message']])
  const permissionMode = pickString(data, ['permission_mode', 'permissionMode'])
  const hookType = pickString(data, ['hook_type', 'hookType', ['hook', 'type']])
  const toolInput = summarizeToolInput(data?.tool_input, toolName)
  const taskSubject = pickString(data, ['task_subject', 'taskSubject'])
  const teammateName = pickString(data, ['teammate_name', 'teammateName'])
  const teamName = pickString(data, ['team_name', 'teamName'])
  const subagentType = pickString(data, ['subagent_type', 'subagentType', 'agent_type', 'agentType'])
  const sourceInfo = detectSource(data)
  const tabbySession = (process.env.CLAUDE_DOCK_TABBY_SESSION || '').trim() || undefined
  const terminalId = (process.env.CLAUDE_DOCK_TERMINAL_ID || '').trim() || undefined
  const hostPid = Number(process.env.CLAUDE_DOCK_HOST_PID || process.ppid) || undefined
  const requestId = crypto.randomUUID()
  const eventId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`

  const out = {
    ts: Date.now(),
    event,
    event_id: eventId,
    source: sourceInfo.source,
    tabby_session: tabbySession,
    terminal_id: terminalId,
    host_pid: hostPid,
    cwd,
    session_id: sessionId,
    title,
    transcript_path: transcriptPath,
    tool_name: toolName,
    message,
    permission_mode: permissionMode,
    hook_type: hookType,
    tool_input: toolInput || undefined,
    task_subject: taskSubject || undefined,
    teammate_name: teammateName || undefined,
    team_name: teamName || undefined,
    subagent_type: subagentType || undefined,
    awaiting_response: true,
    request_id: requestId,
  }

  writeRuntimeDebug('sync_hook_send', {
    event,
    request_id: requestId,
    session_id: sessionId || null,
    tool_name: toolName || null,
    task_subject: taskSubject || null,
  })

  const response = await sendPermissionAndWait(out, config.timeoutMs)
  const result = formatSyncResponse(event, response)

  writeRuntimeDebug('sync_hook_result', {
    event,
    request_id: requestId,
    behavior: response?.behavior || null,
    exit_code: result.exitCode,
  })

  if (result.stdout) process.stdout.write(result.stdout + '\n')
  if (result.stderr) process.stderr.write(result.stderr + '\n')
  return result.exitCode
}

async function main () {
  if (process.argv.includes('--worker')) {
    return await runWorker()
  }
  const event = argValue('--event') || process.env.CLAUDE_DOCK_EVENT || 'unknown'
  // Sync bidirectional hooks: hold TCP socket, wait for dashboard response
  if (SYNC_HOOKS[event]) {
    return await runSyncHook()
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
