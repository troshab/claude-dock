import { Injectable, Injector } from '@angular/core'
import { BehaviorSubject } from 'rxjs'

import * as fs from 'fs'

import { ClaudeTodo } from '../models'
import { normalizePath, safeJsonParse } from '../utils'
import { ClaudeEventsService } from './claudeEvents.service'

type CacheEntry = {
  mtimeMs: number
  todos: ClaudeTodo[]
}

/** Keywords that indicate a line may contain task/todo data. */
const TASK_KEYWORDS = ['TodoWrite', '"todos"', 'TaskCreate', 'TaskUpdate', 'TaskList']

@Injectable({ providedIn: 'root' })
export class ClaudeTodosService {
  readonly todosChanged$ = new BehaviorSubject<Record<string, ClaudeTodo[]>>({})

  private events: ClaudeEventsService

  private timer?: any
  private activeTranscripts: string[] = []
  private cache = new Map<string, CacheEntry>()

  constructor (injector: Injector) {
    this.events = injector.get(ClaudeEventsService)

    // Track transcript paths from the currently visible sessions (including subagent transcripts).
    this.events.sessions$.subscribe((sessions) => {
      const paths = new Set<string>()
      for (const s of sessions ?? []) {
        if (s?.transcriptPath) {
          paths.add(normalizePath(s.transcriptPath))
        }
        // Also poll subagent transcript paths for mini-todos
        for (const sa of s?.subagentTranscripts ?? []) {
          if (sa.path) paths.add(normalizePath(sa.path))
        }
      }
      this.activeTranscripts = [...paths.values()]
      this.pruneCache()
    })

    this.start()
  }

  getTodosForTranscript (transcriptPath?: string | null): ClaudeTodo[] {
    if (!transcriptPath) {
      return []
    }
    const key = normalizePath(transcriptPath)
    return this.cache.get(key)?.todos ?? []
  }

  private start (): void {
    // Don't poll too aggressively: transcript files can be big.
    this.timer = setInterval(() => {
      this.tick().catch(() => null)
    }, 4000)
    this.tick().catch(() => null)
  }

  private pruneCache (): void {
    const active = new Set(this.activeTranscripts)
    for (const k of this.cache.keys()) {
      if (!active.has(k)) {
        this.cache.delete(k)
      }
    }
  }

  // --- Legacy TodoWrite format ---

  private findTodoWriteList (obj: any): any[] | null {
    if (!obj || typeof obj !== 'object') return null
    if (Array.isArray(obj.todos)) return obj.todos

    const msg = obj.message
    if (msg && typeof msg === 'object') {
      if (Array.isArray(msg.todos)) return msg.todos
      const content = msg.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.name === 'TodoWrite' && Array.isArray(c?.input?.todos)) return c.input.todos
          if (Array.isArray(c?.todos)) return c.todos
        }
      }
    }
    if (Array.isArray(obj?.input?.todos)) return obj.input.todos
    return null
  }

  private normalizeTodoWriteList (todos: any[]): ClaudeTodo[] {
    const out: ClaudeTodo[] = []
    for (const t of todos ?? []) {
      if (typeof t === 'string') { out.push({ content: t }); continue }
      if (!t || typeof t !== 'object') continue
      const content = typeof t.content === 'string' ? t.content : (typeof t.text === 'string' ? t.text : '')
      if (!content) continue
      const status = typeof t.status === 'string' ? t.status : undefined
      out.push({ content, status })
    }
    return out
  }

  // --- New TaskCreate / TaskUpdate format ---

  /** Extract tool_use blocks from a transcript line object. */
  private extractToolUse (obj: any): Array<{ name: string, input: any }> {
    const results: Array<{ name: string, input: any }> = []
    const msg = obj?.message ?? obj?.data
    if (!msg) return results
    const content = msg.content ?? (obj?.type === 'assistant' ? obj?.data?.content : null)
    if (!Array.isArray(content)) return results
    for (const c of content) {
      if (c?.type === 'tool_use' && c.name && c.input) {
        results.push({ name: c.name, input: c.input })
      }
    }
    return results
  }

  /** Replay TaskCreate/TaskUpdate calls to build a task list. */
  private replayTaskOps (lines: string[]): ClaudeTodo[] {
    const tasks = new Map<string, { subject: string, status: string }>()
    let nextId = 1

    for (const line of lines) {
      if (!line.includes('TaskCreate') && !line.includes('TaskUpdate')) continue
      const obj = safeJsonParse<any>(line)
      if (!obj) continue

      for (const tu of this.extractToolUse(obj)) {
        if (tu.name === 'TaskCreate') {
          const subject = String(tu.input?.subject ?? '').trim()
          if (!subject) continue
          const id = String(nextId++)
          tasks.set(id, { subject, status: 'pending' })
        } else if (tu.name === 'TaskUpdate') {
          const id = String(tu.input?.taskId ?? '').trim()
          if (!id || !tasks.has(id)) continue
          const task = tasks.get(id)!
          if (tu.input?.status) task.status = String(tu.input.status)
          if (tu.input?.subject) task.subject = String(tu.input.subject)
        }
      }
    }

    if (!tasks.size) return []
    const out: ClaudeTodo[] = []
    for (const t of tasks.values()) {
      if (t.status === 'deleted') continue
      out.push({ content: t.subject, status: t.status as any })
    }
    return out
  }

  private async extractTodosFromTranscriptTail (filePath: string): Promise<ClaudeTodo[] | null> {
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(filePath)
    } catch {
      return null
    }
    if (!stat.size) {
      return []
    }

    const maxBytes = 512 * 1024
    const start = Math.max(0, stat.size - maxBytes)

    let fh: fs.promises.FileHandle | null = null
    try {
      fh = await fs.promises.open(filePath, 'r')
      const buf = Buffer.alloc(stat.size - start)
      await fh.read(buf, 0, buf.length, start)
      const text = buf.toString('utf8')
      const lines = text.split(/\r?\n/g).map(l => l.trim()).filter(Boolean)

      // Try legacy TodoWrite first (last non-empty occurrence wins)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line.includes('TodoWrite') && !line.includes('"todos"')) continue
        const obj = safeJsonParse<any>(line)
        if (!obj) continue
        const todos = this.findTodoWriteList(obj)
        if (!todos || !todos.length) continue
        return this.normalizeTodoWriteList(todos)
      }

      // Try new TaskCreate/TaskUpdate format (replay all ops)
      const hasTaskOps = lines.some(l => l.includes('TaskCreate'))
      if (hasTaskOps) {
        return this.replayTaskOps(lines)
      }

      return []
    } finally {
      await fh?.close()
    }
  }

  private async tick (): Promise<void> {
    let changed = false
    for (const tx of this.activeTranscripts) {
      if (!tx) continue

      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(tx)
      } catch {
        continue
      }

      const cached = this.cache.get(tx)
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        continue
      }

      const todos = await this.extractTodosFromTranscriptTail(tx)
      this.cache.set(tx, { mtimeMs: stat.mtimeMs, todos: todos ?? [] })
      changed = true
    }

    if (!changed) {
      return
    }

    const rec: Record<string, ClaudeTodo[]> = {}
    for (const [k, v] of this.cache.entries()) {
      rec[k] = v.todos
    }
    this.todosChanged$.next(rec)
  }
}
