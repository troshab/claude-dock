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

@Injectable({ providedIn: 'root' })
export class ClaudeTodosService {
  readonly todosChanged$ = new BehaviorSubject<Record<string, ClaudeTodo[]>>({})

  private events: ClaudeEventsService

  private timer?: any
  private activeTranscripts: string[] = []
  private cache = new Map<string, CacheEntry>()

  constructor (injector: Injector) {
    this.events = injector.get(ClaudeEventsService)

    // Track transcript paths from the currently visible sessions.
    this.events.sessions$.subscribe((sessions) => {
      const paths = new Set<string>()
      for (const s of sessions ?? []) {
        if (s?.transcriptPath) {
          paths.add(normalizePath(s.transcriptPath))
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

  private findTodos (obj: any): any[] | null {
    if (!obj || typeof obj !== 'object') {
      return null
    }

    if (Array.isArray(obj.todos)) {
      return obj.todos
    }

    const msg = obj.message
    if (msg && typeof msg === 'object') {
      if (Array.isArray(msg.todos)) {
        return msg.todos
      }
      const content = msg.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.name === 'TodoWrite' && Array.isArray(c?.input?.todos)) {
            return c.input.todos
          }
          if (Array.isArray(c?.todos)) {
            return c.todos
          }
        }
      }
    }

    // Tool-use logs sometimes store the input separately.
    if (Array.isArray(obj?.input?.todos)) {
      return obj.input.todos
    }

    return null
  }

  private normalizeTodos (todos: any[]): ClaudeTodo[] {
    const out: ClaudeTodo[] = []
    for (const t of todos ?? []) {
      if (typeof t === 'string') {
        out.push({ content: t })
        continue
      }
      if (!t || typeof t !== 'object') {
        continue
      }
      const content = typeof t.content === 'string' ? t.content : (typeof t.text === 'string' ? t.text : '')
      if (!content) {
        continue
      }
      const status = typeof t.status === 'string' ? t.status : undefined
      out.push({ content, status })
    }
    return out
  }

  private extractTodosFromTranscriptTail (filePath: string): ClaudeTodo[] | null {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return null
    }
    if (!stat.size) {
      return []
    }

    const maxBytes = 256 * 1024
    const start = Math.max(0, stat.size - maxBytes)

    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      const text = buf.toString('utf8')
      const lines = text.split(/\r?\n/g)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? '').trim()
        if (!line) continue
        if (!line.includes('TodoWrite') && !line.includes('"todos"')) {
          continue
        }
        const obj = safeJsonParse<any>(line)
        if (!obj) continue
        const todos = this.findTodos(obj)
        if (!todos) continue
        return this.normalizeTodos(todos)
      }
      return []
    } finally {
      try { fs.closeSync(fd) } catch { }
    }
  }

  private async tick (): Promise<void> {
    let changed = false
    for (const tx of this.activeTranscripts) {
      if (!tx) continue

      let stat: fs.Stats
      try {
        stat = fs.statSync(tx)
      } catch {
        continue
      }

      const cached = this.cache.get(tx)
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        continue
      }

      const todos = this.extractTodosFromTranscriptTail(tx)
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

