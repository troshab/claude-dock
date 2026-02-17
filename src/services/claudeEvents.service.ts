import { Injectable, Injector } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import { AppService, ConfigService, HostWindowService, NotificationsService } from 'tabby-core'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import * as net from 'net'

import { ClaudeHookEvent, ClaudeSession } from '../models'
import { normalizePath, nowMs, safeJsonParse } from '../utils'
import { TabbyDebugService } from './tabbyDebug.service'

function getEventsPath (): string {
  return path.join(os.homedir(), '.claude', 'claude-dock', 'events.jsonl')
}

interface RealtimeEndpoint {
  kind: 'pipe' | 'unix'
  path: string
}

const DOCK_TCP_PORT = 19542

function getRealtimeEndpoint (): RealtimeEndpoint {
  const baseDir = path.join(os.homedir(), '.claude', 'claude-dock')
  if (process.platform === 'win32') {
    const homeKey = os.homedir().toLowerCase()
    const hash = crypto.createHash('sha1').update(homeKey).digest('hex').slice(0, 10)
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\claude-dock-${hash}-events-v1`,
    }
  }
  return {
    kind: 'unix',
    path: path.join(baseDir, 'hook-events.sock'),
  }
}

type SessionMap = Map<string, ClaudeSession>

@Injectable({ providedIn: 'root' })
export class ClaudeEventsService {
  readonly sessions$ = new BehaviorSubject<ClaudeSession[]>([])
  readonly eventsPath = getEventsPath()
  readonly realtimeEndpoint = getRealtimeEndpoint()

  private app: AppService
  private config: ConfigService
  private notifications: NotificationsService
  private hostWindow: HostWindowService
  private debug: TabbyDebugService

  private sessions: SessionMap = new Map()
  private offset = 0
  private partialLine = ''
  private initialized = false
  private missingEventsFileLogged = false
  private lastTrimDebugSig = ''
  private timer?: any
  private realtimeServer?: net.Server
  private tcpServer?: net.Server
  private seenEventIds = new Map<string, number>()
  private lastEventIdSweepTs = 0
  private pendingTitles = new Map<string, { title: string, ts: number }>()
  private suppressNotifications = true

  constructor (injector: Injector) {
    this.app = injector.get(AppService)
    this.config = injector.get(ConfigService)
    this.notifications = injector.get(NotificationsService)
    this.hostWindow = injector.get(HostWindowService)
    this.debug = injector.get(TabbyDebugService)
    this.start()
  }

  private start (): void {
    this.startRealtimeServer().catch(() => null)
    this.startTcpServer()

    const pollMs = 1000
    this.debug.log('events.polling.start', {
      events_path: this.eventsPath,
      poll_ms: pollMs,
    })
    // Polling is simpler than fs.watch across platforms.
    this.timer = setInterval(() => {
      this.tick().catch(() => null)
    }, pollMs)
    this.tick().catch(() => null)
  }

  private async startRealtimeServer (): Promise<void> {
    const endpoint = this.realtimeEndpoint
    try {
      if (endpoint.kind === 'unix') {
        const dir = path.dirname(endpoint.path)
        await fs.promises.mkdir(dir, { recursive: true })
        try {
          await fs.promises.unlink(endpoint.path)
        } catch { }
      }
    } catch (e: any) {
      this.debug.log('events.realtime.prepare_failed', {
        endpoint_kind: endpoint.kind,
        endpoint_path: endpoint.path,
        error: String(e?.message ?? e),
      })
    }

    this.realtimeServer = net.createServer((socket) => this.handleRealtimeSocket(socket))
    this.realtimeServer.on('error', (e: any) => {
      this.debug.log('events.realtime.server_error', {
        endpoint_kind: endpoint.kind,
        endpoint_path: endpoint.path,
        error: String(e?.message ?? e),
      })
    })

    this.realtimeServer.listen(endpoint.path, () => {
      this.debug.log('events.realtime.listening', {
        endpoint_kind: endpoint.kind,
        endpoint_path: endpoint.path,
      })
    })
  }

  private startTcpServer (): void {
    this.tcpServer = net.createServer((socket) => this.handleRealtimeSocket(socket))
    this.tcpServer.on('error', (e: any) => {
      this.debug.log('events.tcp.server_error', {
        port: DOCK_TCP_PORT,
        error: String(e?.message ?? e),
      })
    })
    this.tcpServer.listen(DOCK_TCP_PORT, '0.0.0.0', () => {
      this.debug.log('events.tcp.listening', {
        port: DOCK_TCP_PORT,
      })
    })
  }

  private handleRealtimeSocket (socket: net.Socket): void {
    let buffer = ''
    const remote = {
      address: socket.remoteAddress ?? null,
      port: socket.remotePort ?? null,
    }
    this.debug.log('events.realtime.client_connected', remote)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      while (true) {
        const idx = buffer.indexOf('\n')
        if (idx < 0) {
          break
        }
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) {
          continue
        }
        this.consumeRealtimeLine(line)
      }
    })
    socket.on('end', () => {
      const tail = buffer.trim()
      if (tail) {
        this.consumeRealtimeLine(tail)
      }
      this.debug.log('events.realtime.client_disconnected', remote)
    })
    socket.on('error', (e: any) => {
      this.debug.log('events.realtime.client_error', {
        ...remote,
        error: String(e?.message ?? e),
      })
    })
  }

  private consumeRealtimeLine (line: string): void {
    const evt = safeJsonParse<ClaudeHookEvent>(line)
    if (!evt || typeof evt !== 'object') {
      this.debug.log('events.realtime.invalid_json', {
        line_preview: line.slice(0, 320),
      })
      return
    }
    if (!evt.ts) {
      evt.ts = nowMs()
    }
    if (this.consumeEvent(evt, 'realtime')) {
      this.trimAndPublish()
    }
  }

  private sweepSeenEventIds (now: number): void {
    const ttl = 6 * 60 * 60 * 1000
    const max = 8000
    if (now - this.lastEventIdSweepTs < 60_000 && this.seenEventIds.size <= max) {
      return
    }
    this.lastEventIdSweepTs = now
    for (const [eventId, ts] of this.seenEventIds.entries()) {
      if (now - ts > ttl) {
        this.seenEventIds.delete(eventId)
      }
    }
    while (this.seenEventIds.size > max) {
      const oldest = this.seenEventIds.keys().next().value
      if (!oldest) {
        break
      }
      this.seenEventIds.delete(oldest)
    }
  }

  private consumeEvent (evt: ClaudeHookEvent, origin: 'file' | 'realtime'): boolean {
    const eventId = String(evt.event_id ?? '').trim()
    if (eventId) {
      if (this.seenEventIds.has(eventId)) {
        this.debug.log('events.duplicate_ignored', {
          origin,
          event_id: eventId,
          event: evt.event ?? null,
          session_id: evt.session_id ?? null,
          terminal_id: evt.terminal_id ?? null,
        })
        return false
      }
      const now = Number(evt.ts) || nowMs()
      this.seenEventIds.set(eventId, now)
      this.sweepSeenEventIds(now)
    }
    this.applyEvent(evt)
    return true
  }

  private getTTLms (): number {
    const minutes = (this.config as any).store?.claudeDock?.sessionTTLMinutes ?? 30
    const n = Number(minutes)
    if (!Number.isFinite(n) || n <= 0) {
      return 30 * 60 * 1000
    }
    return n * 60 * 1000
  }

  private getStartOnlyNoPidTTLms (): number {
    const minutes = (this.config as any).store?.claudeDock?.startOnlyNoPidTTLMinutes ?? 5
    const n = Number(minutes)
    if (!Number.isFinite(n) || n <= 0) {
      return 5 * 60 * 1000
    }
    return n * 60 * 1000
  }

  private markEndedLocally (s: ClaudeSession, reason: string, ts: number): void {
    if (s.status === 'ended') {
      return
    }
    s.status = 'ended'
    s.endedTs = ts
    s.lastEventTs = ts
    s.lastEvent = reason
    if (!s.startTs) {
      s.startTs = ts
    }
    this.debug.log('events.session.mark_ended_local', {
      reason,
      key: s.key,
      session_id: s.sessionId ?? null,
      terminal_id: s.terminalId ?? null,
      host_pid: s.hostPid ?? null,
      tabby_session: s.tabbySession ?? null,
      cwd: s.cwd ?? null,
    })
  }

  private autoEndStaleSessions (now: number): void {
    const startOnlyNoPidTTL = this.getStartOnlyNoPidTTLms()
    for (const s of this.sessions.values()) {
      if (s.status === 'ended' || s.source !== 'tabby') {
        continue
      }

      const last = s.lastEventTs ?? s.startTs ?? 0
      if (!last) {
        continue
      }
      if (s.lastEvent === 'session_start' && now - last > startOnlyNoPidTTL) {
        this.markEndedLocally(s, 'start_only_no_pid_ttl', now)
      }
    }
  }

  private normalizeKeyPath (p?: string | null): string {
    let s = normalizePath((p ?? '').trim())
    s = s.replace(/\/+$/g, '')
    if (process.platform === 'win32') {
      s = s.toLowerCase()
    }
    return s
  }

  private isCwdInsideWorkspace (sessionCwd?: string, workspaceCwd?: string): boolean {
    const a = this.normalizeKeyPath(sessionCwd)
    const b = this.normalizeKeyPath(workspaceCwd)
    if (!a || !b) {
      return false
    }
    if (a === b) {
      return true
    }
    return a.startsWith(`${b}/`)
  }

  private makeKey (evt: ClaudeHookEvent): string | null {
    const sid = (evt.session_id ?? '').trim()
    if (sid) return `sid:${sid}`
    const tx = (evt.transcript_path ?? '').trim()
    if (tx) return `tx:${this.normalizeKeyPath(tx)}`
    const cwd = (evt.cwd ?? '').trim()
    if (cwd) return `cwd:${this.normalizeKeyPath(cwd)}`
    return null
  }

  private mergeSessionInto (toKey: string, fromKey: string): void {
    const to = this.sessions.get(toKey)
    const from = this.sessions.get(fromKey)
    if (!to || !from) return

    // Avoid merging obviously unrelated sessions.
    if (to.sessionId && from.sessionId && to.sessionId !== from.sessionId) {
      return
    }
    if (to.cwd && from.cwd && this.normalizeKeyPath(to.cwd) !== this.normalizeKeyPath(from.cwd)) {
      return
    }
    if (to.transcriptPath && from.transcriptPath && this.normalizeKeyPath(to.transcriptPath) !== this.normalizeKeyPath(from.transcriptPath)) {
      return
    }

    to.startTs = Math.min(to.startTs ?? Infinity, from.startTs ?? Infinity)
    if (!Number.isFinite(to.startTs!)) {
      to.startTs = from.startTs
    }
    to.sessionId ??= from.sessionId
    to.tabbySession ??= from.tabbySession
    to.terminalId ??= from.terminalId
    to.hostPid ??= from.hostPid
    to.source ??= from.source
    to.cwd ??= from.cwd
    to.title ??= from.title
    to.transcriptPath ??= from.transcriptPath
    to.lastEventTs = Math.max(to.lastEventTs ?? 0, from.lastEventTs ?? 0) || to.lastEventTs
    to.lastToolTs = Math.max(to.lastToolTs ?? 0, from.lastToolTs ?? 0) || to.lastToolTs
    to.lastToolName ??= from.lastToolName
    to.lastEvent ??= from.lastEvent
    if (from.waitingSinceTs && (!to.waitingSinceTs || from.waitingSinceTs < to.waitingSinceTs)) {
      to.waitingSinceTs = from.waitingSinceTs
    }
    to.status = to.status !== 'unknown' ? to.status : from.status
    to.lastMessage ??= from.lastMessage

    this.sessions.delete(fromKey)
    this.debug.log('events.session.merge', {
      to_key: toKey,
      from_key: fromKey,
      session_id: to.sessionId ?? from.sessionId ?? null,
      tabby_session: to.tabbySession ?? from.tabbySession ?? null,
      terminal_id: to.terminalId ?? from.terminalId ?? null,
      host_pid: to.hostPid ?? from.hostPid ?? null,
      cwd: to.cwd ?? from.cwd ?? null,
      source: to.source ?? from.source ?? null,
    })
  }

  private promoteSessionKey (fromKey: string, toKey: string, sessionId?: string): void {
    const s = this.sessions.get(fromKey)
    if (!s) return
    if (sessionId && s.sessionId && s.sessionId !== sessionId) {
      return
    }
    this.sessions.delete(fromKey)
    s.key = toKey
    if (sessionId) {
      s.sessionId = sessionId
    }
    this.sessions.set(toKey, s)
    this.debug.log('events.session.promote_key', {
      from_key: fromKey,
      to_key: toKey,
      session_id: sessionId ?? s.sessionId ?? null,
      tabby_session: s.tabbySession ?? null,
      terminal_id: s.terminalId ?? null,
      host_pid: s.hostPid ?? null,
      cwd: s.cwd ?? null,
      source: s.source ?? null,
    })
  }

  private upsertSession (key: string, evt: ClaudeHookEvent, eventName: string): ClaudeSession {
    let s = this.sessions.get(key)
    if (!s) {
      s = {
        key,
        status: 'unknown',
      }
      this.sessions.set(key, s)
    }
    if (evt.session_id) {
      s.sessionId = evt.session_id
    }
    if (evt.source) {
      s.source = evt.source
    }
    if (evt.tabby_session) {
      s.tabbySession = evt.tabby_session
    }
    if (evt.terminal_id) {
      s.terminalId = evt.terminal_id
      const pending = this.pendingTitles.get(evt.terminal_id)
      if (pending) {
        if (!s.title) {
          s.title = pending.title
        }
        this.pendingTitles.delete(evt.terminal_id)
      }
    }
    if (Number(evt.host_pid) > 0) {
      s.hostPid = Number(evt.host_pid)
    }
    if (evt.transcript_path) {
      s.transcriptPath = evt.transcript_path
    }
    if (evt.cwd) {
      s.cwd = evt.cwd
    }
    if (evt.title) {
      s.title = evt.title
    }
    return s
  }

  private applyEvent (evt: ClaudeHookEvent): void {
    const key = this.makeKey(evt)
    if (!key) {
      this.debug.log('events.apply.skipped', {
        reason: 'no_key',
        event: evt.event ?? null,
        session_id: evt.session_id ?? null,
        host_pid: evt.host_pid ?? null,
        cwd: evt.cwd ?? null,
        transcript_path: evt.transcript_path ?? null,
        source: evt.source ?? null,
      })
      return
    }
    const ts = Number(evt.ts) || nowMs()
    const event = (evt.event ?? '').toLowerCase()

    // If we now have session_id, try to merge any transcript/cwd keyed sessions created earlier.
    if (evt.session_id) {
      const sidKey = `sid:${evt.session_id}`

      if (evt.transcript_path) {
        const txKey = `tx:${this.normalizeKeyPath(evt.transcript_path)}`
        if (txKey !== sidKey && this.sessions.has(txKey)) {
          if (!this.sessions.has(sidKey)) {
            this.promoteSessionKey(txKey, sidKey, evt.session_id)
          } else {
            this.mergeSessionInto(sidKey, txKey)
          }
        }
      }

      if (evt.cwd) {
        const cwdKey = `cwd:${this.normalizeKeyPath(evt.cwd)}`
        if (cwdKey !== sidKey && this.sessions.has(cwdKey)) {
          if (!this.sessions.has(sidKey)) {
            this.promoteSessionKey(cwdKey, sidKey, evt.session_id)
          } else {
            this.mergeSessionInto(sidKey, cwdKey)
          }
        }
      }
    }

    const s = this.upsertSession(key, evt, event)
    if (!s.startTs) {
      s.startTs = ts
    }
    s.lastEventTs = ts
    s.lastEvent = event
    if (evt.message) {
      s.lastMessage = evt.message
    }

    const prevStatus = s.status

    // Don't let stale file events resurrect a locally ended session.
    if (s.status === 'ended' && event !== 'session_end') {
      return
    }

    if (event === 'session_start') {
      // Fresh interactive Claude session is typically idle, waiting for user input.
      // Show "waiting" immediately instead of "unknown".
      if (s.status !== 'working') {
        s.status = 'waiting'
      }
      if (!s.waitingSinceTs) {
        s.waitingSinceTs = ts
      }
      s.endedTs = undefined
    } else if (event === 'tool_start') {
      s.status = 'working'
      s.lastToolTs = ts
      s.lastToolName = evt.tool_name ?? s.lastToolName
      s.waitingSinceTs = undefined
      s.endedTs = undefined
    } else if (event === 'tool_end') {
      s.status = 'working'
      s.lastToolTs = ts
      s.lastToolName = evt.tool_name ?? s.lastToolName
    } else if (event === 'stop' || event === 'notification') {
      s.status = 'waiting'
      if (!s.waitingSinceTs) {
        s.waitingSinceTs = ts
      }
    } else if (event === 'session_end') {
      s.status = 'ended'
      s.endedTs = ts
    }

    if (!this.suppressNotifications && prevStatus === 'working' && s.status === 'waiting' && s.source === 'tabby') {
      this.notifyWaiting(s)
    }

    this.debug.log('events.apply', {
      event,
      source: evt.source ?? s.source ?? null,
      raw_key: key,
      session_key: s.key,
      session_id: s.sessionId ?? null,
      tabby_session: s.tabbySession ?? evt.tabby_session ?? null,
      terminal_id: s.terminalId ?? evt.terminal_id ?? null,
      host_pid: s.hostPid ?? evt.host_pid ?? null,
      cwd: s.cwd ?? null,
      transcript_path: s.transcriptPath ?? null,
      status_before: prevStatus,
      status_after: s.status,
      waiting_since_ts: s.waitingSinceTs ?? null,
      last_tool_name: s.lastToolName ?? null,
      ts,
    })
  }

  private trimAndPublish (): void {
    const ttl = this.getTTLms()
    const now = nowMs()
    this.autoEndStaleSessions(now)

    // Flush any pending titles to sessions that now have a matching terminalId.
    if (this.pendingTitles.size) {
      for (const s of this.sessions.values()) {
        if (!s.terminalId) continue
        const pending = this.pendingTitles.get(s.terminalId)
        if (pending !== undefined) {
          if (pending.title && s.title !== pending.title) {
            s.title = pending.title
          }
          this.pendingTitles.delete(s.terminalId)
        }
      }
      // Sweep stale pending titles (no matching session appeared within 5 minutes).
      if (this.pendingTitles.size) {
        const ttl = 5 * 60 * 1000
        for (const [id, entry] of this.pendingTitles.entries()) {
          if (now - entry.ts > ttl) {
            this.pendingTitles.delete(id)
          }
        }
        // Hard cap to prevent unbounded growth.
        while (this.pendingTitles.size > 200) {
          const oldest = this.pendingTitles.keys().next().value
          if (!oldest) break
          this.pendingTitles.delete(oldest)
        }
      }
    }

    const visible: ClaudeSession[] = []
    const filtered: Array<Record<string, any>> = []
    for (const s of this.sessions.values()) {
      const last = s.lastEventTs ?? s.startTs ?? 0
      if (!last) {
        filtered.push({
          key: s.key,
          reason: 'no_last_event',
          status: s.status,
          source: s.source ?? null,
          session_id: s.sessionId ?? null,
          cwd: s.cwd ?? null,
        })
        continue
      }
      if (s.status === 'ended') {
        filtered.push({
          key: s.key,
          reason: 'ended',
          status: s.status,
          source: s.source ?? null,
          session_id: s.sessionId ?? null,
          cwd: s.cwd ?? null,
        })
        continue
      }
      if (s.source !== 'tabby') {
        filtered.push({
          key: s.key,
          reason: 'source_not_tabby',
          status: s.status,
          source: s.source ?? null,
          session_id: s.sessionId ?? null,
          cwd: s.cwd ?? null,
        })
        continue
      }
      if (s.tabbySession && s.tabbySession !== this.debug.sessionId) {
        filtered.push({
          key: s.key,
          reason: 'previous_tabby_session',
          status: s.status,
          source: s.source ?? null,
          session_id: s.sessionId ?? null,
          tabby_session: s.tabbySession,
          cwd: s.cwd ?? null,
        })
        continue
      }
      if (now - last > ttl) {
        filtered.push({
          key: s.key,
          reason: 'ttl_expired',
          age_ms: now - last,
          ttl_ms: ttl,
          status: s.status,
          source: s.source ?? null,
          session_id: s.sessionId ?? null,
          cwd: s.cwd ?? null,
        })
        continue
      }
      visible.push({ ...s })
    }

    const sigVisible = visible
      .map(s => `${s.key}|${s.status}|${s.source ?? ''}|${s.lastEventTs ?? 0}`)
      .sort()
      .join(',')
    const sigFiltered = filtered
      .map(x => `${x.key}|${x.reason}|${x.source ?? ''}|${x.status ?? ''}`)
      .sort()
      .join(',')
    const sig = `${sigVisible}||${sigFiltered}`
    if (sig !== this.lastTrimDebugSig) {
      this.lastTrimDebugSig = sig
      this.debug.log('events.publish.visible_sessions', {
        ttl_ms: ttl,
        visible_count: visible.length,
        visible: visible.map(s => ({
          key: s.key,
          session_id: s.sessionId ?? null,
          tabby_session: s.tabbySession ?? null,
          terminal_id: s.terminalId ?? null,
          host_pid: s.hostPid ?? null,
          source: s.source ?? null,
          status: s.status,
          cwd: s.cwd ?? null,
          last_event_ts: s.lastEventTs ?? null,
        })),
        filtered_count: filtered.length,
        filtered: filtered.slice(0, 80),
      })
    }

    this.sessions$.next(visible)
    this.suppressNotifications = false
  }

  listSessionsForWorkspaceCwd (
    workspaceCwd: string,
    options?: { includeEnded?: boolean, source?: 'tabby' | 'any', limit?: number },
  ): ClaudeSession[] {
    const includeEnded = !!options?.includeEnded
    const source = options?.source ?? 'tabby'
    const limit = Math.max(1, Number(options?.limit ?? 50))

    const out: ClaudeSession[] = []
    for (const s of this.sessions.values()) {
      if (source !== 'any' && s.source !== source) {
        continue
      }
      if (!includeEnded && s.status === 'ended') {
        continue
      }
      if (!this.isCwdInsideWorkspace(s.cwd, workspaceCwd)) {
        continue
      }
      out.push({ ...s })
    }

    out.sort((a, b) => (b.lastEventTs ?? b.startTs ?? 0) - (a.lastEventTs ?? a.startTs ?? 0))
    return out.slice(0, limit)
  }

  private notifyWaiting (s: ClaudeSession): void {
    const title = s.title || (s.cwd ? path.basename(s.cwd) : 'Claude Code')

    // Check if the session's terminal is currently focused.
    const activeTab = this.app?.activeTab
    const isFocused = !!s.terminalId && !!(activeTab as any)?.activeTerminalId
      && (activeTab as any).activeTerminalId === s.terminalId
      && typeof document !== 'undefined' && document.hasFocus()

    if (isFocused) {
      return
    }

    try {
      const terminalId = s.terminalId
      const n = new Notification('Claude Code -- waiting', { body: title })
      n.addEventListener('click', () => {
        try {
          // 1. Focus the Electron/app window (works on Win/Mac/Linux)
          try { this.hostWindow?.setTitle?.() } catch { }
          if (typeof window !== 'undefined') {
            try { (window as any).focus() } catch { }
          }
          // Electron: use BrowserWindow.focus() via remote or ipcRenderer
          try {
            const electron = (window as any).require?.('electron')
            const win = electron?.remote?.getCurrentWindow?.() ?? electron?.BrowserWindow?.getFocusedWindow?.()
            win?.focus?.()
            win?.show?.()
          } catch { }

          // 2. Find workspace tab containing this terminal and switch to it
          if (terminalId) {
            const wsTab = this.app.tabs.find((t: any) =>
              t.terminals && Array.isArray(t.terminals) &&
              t.terminals.some((sub: any) => sub.id === terminalId)
            )
            if (wsTab) {
              this.app.selectTab(wsTab)
              // 3. Activate the specific terminal subtab
              setTimeout(() => {
                try { (wsTab as any).activateTerminal?.(terminalId) } catch { }
              }, 100)
            }
          }
        } catch (e: any) {
          this.debug.log('events.notify.click_handler_error', { error: String(e?.message ?? e) })
        }
      })
    } catch (e: any) {
      this.debug.log('events.notify.create_failed', { error: String(e?.message ?? e) })
    }

    this.debug.log('events.notify.waiting', {
      title,
      session_key: s.key,
      session_id: s.sessionId ?? null,
      cwd: s.cwd ?? null,
      is_focused: isFocused,
    })
  }

  updateTitleByTerminalId (terminalId: string, title: string): void {
    const id = String(terminalId ?? '').trim()
    const t = (title ?? '').trim()
    if (!id || !t) {
      return
    }
    let changed = false
    for (const s of this.sessions.values()) {
      if ((s.terminalId ?? '') !== id) {
        continue
      }
      if (s.title === t) {
        continue
      }
      s.title = t
      changed = true
      this.debug.log('events.session.title_updated', {
        terminal_id: id,
        session_id: s.sessionId ?? null,
        title: t,
      })
    }
    if (!changed) {
      this.pendingTitles.set(id, { title: t, ts: nowMs() })
    }
    if (changed) {
      this.trimAndPublish()
    }
  }

  markEndedByHostPid (pid: number, reason = 'killed'): void {
    const n = Number(pid)
    if (!Number.isFinite(n) || n <= 0) {
      return
    }
    const ts = nowMs()
    let changed = 0
    for (const s of this.sessions.values()) {
      if (Number(s.hostPid) !== n) {
        continue
      }
      if (s.status === 'ended') {
        continue
      }
      s.status = 'ended'
      s.endedTs = ts
      s.lastEventTs = ts
      s.lastEvent = reason

      changed++
    }
    if (changed) {
      this.debug.log('events.session.mark_ended_by_pid', {
        pid: n,
        reason,
        affected_sessions: changed,
      })
      this.trimAndPublish()
    }
  }

  markEndedBySessionId (sessionId: string, reason = 'closed'): void {
    const id = String(sessionId ?? '').trim()
    if (!id) {
      return
    }
    const ts = nowMs()
    let changed = 0
    for (const s of this.sessions.values()) {
      if ((s.sessionId ?? '') !== id) {
        continue
      }
      if (s.status === 'ended') {
        continue
      }
      s.status = 'ended'
      s.endedTs = ts
      s.lastEventTs = ts
      s.lastEvent = reason

      changed++
    }
    if (changed) {
      this.debug.log('events.session.mark_ended_by_session_id', {
        session_id: id,
        reason,
        affected_sessions: changed,
      })
      this.trimAndPublish()
    }
  }

  markEndedByTerminalId (terminalId: string, reason = 'terminal_closed'): void {
    const id = String(terminalId ?? '').trim()
    if (!id) {
      return
    }
    const ts = nowMs()
    let changed = 0
    for (const s of this.sessions.values()) {
      if ((s.terminalId ?? '') !== id) {
        continue
      }
      if (s.status === 'ended') {
        continue
      }
      s.status = 'ended'
      s.endedTs = ts
      s.lastEventTs = ts
      s.lastEvent = reason

      changed++
    }
    if (changed) {
      this.debug.log('events.session.mark_ended_by_terminal', {
        terminal_id: id,
        reason,
        affected_sessions: changed,
      })
      this.trimAndPublish()
    }
  }

  private async tick (): Promise<void> {
    const file = this.eventsPath
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(file)
    } catch {
      // No file yet.
      if (!this.missingEventsFileLogged) {
        this.missingEventsFileLogged = true
        this.debug.log('events.file.missing', { events_path: file })
      }
      if (!this.initialized) {
        this.initialized = true
        this.sessions$.next([])
      }
      return
    }

    if (this.missingEventsFileLogged) {
      this.missingEventsFileLogged = false
      this.debug.log('events.file.found', {
        events_path: file,
        size: stat.size,
      })
    }

    if (!this.initialized) {
      this.initialized = true
      // Tail the last 1MB on startup to avoid parsing a huge file.
      const tailBytes = 1024 * 1024
      this.offset = Math.max(0, stat.size - tailBytes)
      this.debug.log('events.init.tail', {
        events_path: file,
        size: stat.size,
        offset: this.offset,
        tail_bytes: tailBytes,
      })
    }

    if (stat.size < this.offset) {
      // Truncated/rotated.
      this.debug.log('events.file.truncated_or_rotated', {
        previous_offset: this.offset,
        next_size: stat.size,
      })
      this.offset = 0
      this.partialLine = ''
      this.sessions.clear()
    }

    if (stat.size === this.offset) {
      this.trimAndPublish()
      return
    }

    const len = stat.size - this.offset
    let fh: fs.promises.FileHandle | null = null
    try {
      fh = await fs.promises.open(file, 'r')
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, this.offset)
      this.offset = stat.size

      this.partialLine += buf.toString('utf8')
      const lines = this.partialLine.split(/\r?\n/g)
      this.partialLine = lines.pop() ?? ''
      let parsedCount = 0
      let invalidCount = 0
      let duplicateCount = 0

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const evt = safeJsonParse<ClaudeHookEvent>(trimmed)
        if (!evt || typeof evt !== 'object') {
          invalidCount++
          continue
        }
        if (!evt.ts) {
          evt.ts = nowMs()
        }
        if (this.consumeEvent(evt, 'file')) {
          parsedCount++
        } else {
          duplicateCount++
        }
      }

      this.debug.log('events.tick.read', {
        file_size: stat.size,
        bytes_read: len,
        lines_count: lines.length,
        parsed_count: parsedCount,
        invalid_count: invalidCount,
        duplicate_count: duplicateCount,
        offset_after: this.offset,
      })
    } finally {
      await fh?.close()
    }

    this.trimAndPublish()
  }
}
