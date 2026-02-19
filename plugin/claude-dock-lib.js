/* Claude Dock shared helpers — used by daemon and fallback hook */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const net = require('net')

// ─── Constants ──────────────────────────────────────────────────────

const TABBY_TCP_PORT = 19542
const DAEMON_TCP_PORT = 19543

const SYNC_HOOKS = {
  permission_request: { timeoutMs: 590_000 },
  subagent_stop:     { timeoutMs: 30_000 },
  teammate_idle:     { timeoutMs: 30_000 },
  task_completed:    { timeoutMs: 30_000 },
}

// ─── Field utilities ────────────────────────────────────────────────

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
    if (typeof v === 'string' && v.trim()) return v.trim()
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
  } catch {}
}

function shortText (s, max = 400) {
  const text = String(s || '').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  if (text.length <= max) return text
  return text.slice(0, max) + `...(+${text.length - max} chars)`
}

function sanitizeFilePart (s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown'
}

function decodeHookInputBuffer (buf) {
  let input = buf.toString('utf8').replace(/^\uFEFF/, '')
  if (input.includes('\u0000')) {
    input = buf.toString('utf16le').replace(/^\uFEFF/, '')
  }
  return input
}

// ─── Tool summarization ─────────────────────────────────────────────

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
      return JSON.stringify({ query: input.query || '' })
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
    return shortText(JSON.stringify(input), 500)
  } catch {
    return shortText(JSON.stringify(input), 500)
  }
}

// ─── Source detection ────────────────────────────────────────────────

function detectSource (payload, env) {
  env = env || process.env

  const explicit = (env.CLAUDE_DOCK_SOURCE || '').trim().toLowerCase()
  if (explicit) return { source: explicit, reason: 'env:CLAUDE_DOCK_SOURCE' }

  const payloadSource = pickString(payload, [
    'source', ['metadata', 'source'], ['hook', 'source'],
  ])
  if (payloadSource) return { source: payloadSource.toLowerCase(), reason: 'payload:source' }

  const termProgram = (env.TERM_PROGRAM || '').trim().toLowerCase()
  if (termProgram.includes('tabby')) return { source: 'tabby', reason: 'env:TERM_PROGRAM' }

  return { source: undefined, reason: 'unknown' }
}

function collectEnvSnapshot (env) {
  env = env || process.env
  const out = {}
  const interesting = [
    'CLAUDE_DOCK_SOURCE', 'CLAUDE_DOCK_TABBY_SESSION', 'CLAUDE_DOCK_TERMINAL_ID',
    'TERM_PROGRAM', 'TERM', 'WT_SESSION', 'SHELL', 'COMSPEC', 'PROMPT',
  ]
  for (const key of interesting) out[key] = env[key] || null
  const tabbyKeys = Object.keys(env).filter(k => /tabby/i.test(k)).sort()
  if (tabbyKeys.length) {
    out.tabbyLikeEnv = tabbyKeys.map(k => `${k}=${env[k] ?? ''}`)
  }
  return out
}

// ─── Debug ──────────────────────────────────────────────────────────

function debugDir () {
  return path.join(os.homedir(), '.claude', 'claude-dock', 'debug')
}

function sessionDebugPath (sessionId, transcriptPath) {
  const sid = (sessionId || '').trim()
  if (sid) return path.join(debugDir(), `session-${sanitizeFilePart(sid)}.log`)
  if (transcriptPath) {
    const base = path.basename(transcriptPath).replace(/\.jsonl$/i, '')
    return path.join(debugDir(), `session-${sanitizeFilePart(base)}.log`)
  }
  return path.join(debugDir(), 'session-unknown.log')
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
        ...(info.processExtra || {}),
      },
      env: info.envSnapshot || collectEnvSnapshot(),
    }
    fs.appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf8')
  } catch {}
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
      process: { pid: process.pid, ppid: process.ppid },
    }
    fs.appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf8')
  } catch {}
}

// ─── Transport ──────────────────────────────────────────────────────

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
    const sock = net.createConnection({ host, port: TABBY_TCP_PORT })

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch {}
      resolve({
        ok: !!result?.ok,
        kind: 'tcp',
        path: `${host}:${TABBY_TCP_PORT}`,
        stage: result?.stage || null,
        error: result?.error ? String(result.error) : null,
      })
    }

    const timer = setTimeout(() => {
      finish({ ok: false, stage: 'timeout', error: `timeout_${timeoutMs}ms` })
    }, timeoutMs)

    sock.once('connect', () => {
      try { sock.setNoDelay(true) } catch {}
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

function sendPermissionAndWait (out, timeoutMs) {
  const host = transportHost()
  return new Promise((resolve) => {
    let settled = false
    let buf = ''
    const sock = net.createConnection({ host, port: TABBY_TCP_PORT })
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

// ─── Payload extraction ─────────────────────────────────────────────

/**
 * Parse hook JSON input and build the event object for Tabby.
 * Returns { out, meta } or null on parse failure.
 *
 * ctx.source / ctx.sourceReason — pre-resolved source (daemon header)
 * ctx.tabbySession / ctx.terminalId / ctx.hostPid — env overrides
 * ctx.env — environment variables (defaults to process.env)
 */
function extractPayload (event, input, ctx) {
  ctx = ctx || {}
  const env = ctx.env || process.env
  const data = safeJsonParse(input)
  if (!data || typeof data !== 'object') return null

  const cwd = pickString(data, ['cwd', ['workspace', 'current_dir'], ['workspace', 'currentDir'], ['workspace', 'cwd']])
  const sessionId = pickString(data, ['session_id', 'sessionId', ['session', 'id'], ['session', 'session_id']])
  const transcriptPath = pickString(data, ['transcript_path', 'transcriptPath', ['transcript', 'path']])
  const title = pickString(data, ['title', ['workspace', 'title'], ['workspace', 'name']])
  const toolName = pickString(data, ['tool_name', 'toolName', ['tool', 'name'], ['tool', 'tool_name']])
  const message = pickString(data, ['message', ['notification', 'message']])
  const notificationType = pickString(data, ['notification_type', 'notificationType', ['notification', 'type']])
  const permissionMode = pickString(data, ['permission_mode', 'permissionMode'])
  const subagentId = pickString(data, ['subagent_id', 'subagentId'])
  const subagentType = pickString(data, ['subagent_type', 'subagentType', 'agent_type', 'agentType'])
  const hookType = pickString(data, ['hook_type', 'hookType', ['hook', 'type']])
  const model = pickString(data, ['model'])
  const agentType = pickString(data, ['agent_type', 'agentType'])
  const prompt = shortText(pickString(data, ['prompt']) || '', 300)
  const toolUseId = pickString(data, ['tool_use_id', 'toolUseId'])
  const error = shortText(pickString(data, ['error']) || '', 400)
  const isInterrupt = data?.is_interrupt ?? data?.isInterrupt ?? undefined
  const stopHookActive = data?.stop_hook_active ?? data?.stopHookActive ?? undefined
  const agentId = pickString(data, ['agent_id', 'agentId']) || subagentId
  const agentTranscriptPath = pickString(data, ['agent_transcript_path', 'agentTranscriptPath'])
  const taskId = pickString(data, ['task_id', 'taskId'])
  const taskSubject = pickString(data, ['task_subject', 'taskSubject'])
  const taskDescription = shortText(pickString(data, ['task_description', 'taskDescription']) || '', 300)
  const teammateName = pickString(data, ['teammate_name', 'teammateName'])
  const teamName = pickString(data, ['team_name', 'teamName'])
  const trigger = pickString(data, ['trigger'])
  const customInstructions = shortText(pickString(data, ['custom_instructions', 'customInstructions']) || '', 200)
  const reason = pickString(data, ['reason'])
  const toolInput = summarizeToolInput(data?.tool_input, toolName)
  const toolResponse = data?.tool_response
    ? shortText(typeof data.tool_response === 'string' ? data.tool_response : JSON.stringify(data.tool_response), 500)
    : undefined

  const sourceInfo = ctx.source
    ? { source: ctx.source, reason: ctx.sourceReason || 'ctx:explicit' }
    : detectSource(data, env)
  const source = sourceInfo.source
  const tabbySession = ctx.tabbySession || (env.CLAUDE_DOCK_TABBY_SESSION || '').trim() || undefined
  const terminalId = ctx.terminalId || (env.CLAUDE_DOCK_TERMINAL_ID || '').trim() || undefined
  const hostPid = ctx.hostPid || Number(env.CLAUDE_DOCK_HOST_PID || 0) || undefined
  const payloadSha1 = crypto.createHash('sha1').update(input, 'utf8').digest('hex')
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
    tool_input: toolInput || undefined,
    tool_response: toolResponse || undefined,
    tool_use_id: toolUseId || undefined,
    error: error || undefined,
    is_interrupt: isInterrupt ?? undefined,
    prompt: prompt || undefined,
    model: model || undefined,
    agent_type: agentType || subagentType || undefined,
    agent_id: agentId || undefined,
    subagent_type: subagentType || undefined,
    agent_transcript_path: agentTranscriptPath || undefined,
    stop_hook_active: stopHookActive ?? undefined,
    task_id: taskId || undefined,
    task_subject: taskSubject || undefined,
    task_description: taskDescription || undefined,
    teammate_name: teammateName || undefined,
    team_name: teamName || undefined,
    trigger: trigger || undefined,
    custom_instructions: customInstructions || undefined,
    reason: reason || undefined,
  }

  const meta = {
    sourceInfo,
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
    payloadPreview: shortText(input, 600),
    payloadBytes: Buffer.byteLength(input, 'utf8'),
    stopHookActive: !!stopHookActive,
  }

  return { out, meta }
}

// ─── Response formatting ────────────────────────────────────────────

function formatSyncResponse (event, response) {
  if (!response || !response.behavior) {
    return { stdout: null, stderr: null, exitCode: 0 }
  }

  if (event === 'permission_request') {
    const decision = { behavior: response.behavior }
    if (response.behavior === 'deny' && response.message) decision.message = response.message
    return { stdout: JSON.stringify({ decision }), stderr: null, exitCode: 0 }
  }

  if (event === 'subagent_stop') {
    if (response.behavior === 'block') {
      return {
        stdout: JSON.stringify({ decision: 'block', reason: response.message || 'Continue from Claude Dock' }),
        stderr: null, exitCode: 0,
      }
    }
    return { stdout: null, stderr: null, exitCode: 0 }
  }

  if (event === 'teammate_idle' || event === 'task_completed') {
    if (response.behavior === 'block') {
      return { stdout: null, stderr: response.message || 'Blocked from Claude Dock', exitCode: 2 }
    }
    return { stdout: null, stderr: null, exitCode: 0 }
  }

  return { stdout: null, stderr: null, exitCode: 0 }
}

/**
 * Encode a sync hook response for the daemon-to-bash protocol.
 * Allow with JSON: returns the JSON string.
 * Block with exit 2: returns "BLOCK:message".
 * Allow with no output: returns "".
 */
function encodeDaemonResponse (event, response) {
  const result = formatSyncResponse(event, response)
  if (result.exitCode === 2 && result.stderr) return `BLOCK:${result.stderr}`
  if (result.stdout) return result.stdout
  return ''
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  TABBY_TCP_PORT,
  DAEMON_TCP_PORT,
  SYNC_HOOKS,
  getNested,
  pickString,
  safeJsonParse,
  rotateIfLarge,
  shortText,
  sanitizeFilePart,
  decodeHookInputBuffer,
  summarizeToolInput,
  detectSource,
  collectEnvSnapshot,
  extractPayload,
  debugDir,
  sessionDebugPath,
  writeDebugLine,
  writeRuntimeDebug,
  isInsideDocker,
  transportHost,
  sendEventToTransport,
  sendPermissionAndWait,
  formatSyncResponse,
  encodeDaemonResponse,
}
