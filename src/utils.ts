import * as path from 'path'

export function nowMs (): number {
  return Date.now()
}

export function normalizePath (p: string): string {
  return (p ?? '').replace(/\\/g, '/')
}

/** Human-friendly path for UI display. Always forward slashes, collapses home dir to ~. */
export function displayPath (p: string): string {
  if (!p) return ''
  let s = p.replace(/\\/g, '/')
  // Normalise MSYS-style /c/Users/... → C:/Users/...
  s = s.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`)
  // Collapse home directory to ~
  try {
    const home = require('os').homedir().replace(/\\/g, '/')
    if (s.startsWith(home + '/')) {
      s = '~' + s.slice(home.length)
    } else if (s === home) {
      s = '~'
    }
  } catch {}
  return s
}

/** Convert MSYS-style /c/Users/... to C:/Users/... for native fs operations. */
export function nativePath (p: string): string {
  if (!p) return p
  return p.replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toUpperCase()}:/`)
}

export function pathBase (p: string): string {
  if (!p) {
    return ''
  }
  try {
    return path.basename(p.replace(/\\/g, path.sep))
  } catch {
    return p
  }
}

export function safeJsonParse<T = any> (line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

export function formatAge (ts?: number): string {
  if (!ts) {
    return ''
  }
  const delta = Math.max(0, Date.now() - ts)
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

export function newId (prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function usagePct (v?: number | null): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

export function usageLabel (bucket?: { used: number, limit: number } | null): string {
  if (!bucket) return '--'
  const used = Number(bucket.used ?? 0)
  const limit = Number(bucket.limit ?? 100)
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return '--'
  return `${Math.round((used / limit) * 100)}%`
}

/** Build a human-readable activity string from tool_name + tool_input JSON. */
export function buildActivityString (toolName?: string, toolInputJson?: string): string {
  if (!toolName) return ''
  const tool = toolName.toLowerCase()
  let input: Record<string, any> | null = null
  if (toolInputJson) {
    try { input = JSON.parse(toolInputJson) } catch { }
  }

  const shorten = (s: string, max = 60): string =>
    s && s.length > max ? s.slice(0, max) + '...' : (s || '')

  const basename = (p: string): string => {
    if (!p) return ''
    const parts = p.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || p
  }

  if (tool === 'bash' && input?.command) {
    return `$ ${shorten(input.command, 80)}`
  }
  if (tool === 'edit' && input?.file_path) {
    return `Editing ${basename(input.file_path)}`
  }
  if (tool === 'write' && input?.file_path) {
    return `Writing ${basename(input.file_path)}`
  }
  if (tool === 'read' && input?.file_path) {
    return `Reading ${basename(input.file_path)}`
  }
  if (tool === 'grep' && input?.pattern) {
    const where = input.glob || input.path || ''
    return `Grep "${shorten(input.pattern, 40)}"${where ? ` in ${shorten(where, 30)}` : ''}`
  }
  if (tool === 'glob' && input?.pattern) {
    return `Glob ${shorten(input.pattern, 50)}`
  }
  if (tool === 'task' && input) {
    const type = input.subagent_type || 'Task'
    const desc = input.description || ''
    return `${type}: ${shorten(desc, 60)}`
  }
  if (tool === 'websearch' && input?.query) {
    return `Search: ${shorten(input.query, 60)}`
  }
  if (tool === 'webfetch' && input?.url) {
    return `Fetch: ${shorten(input.url, 60)}`
  }
  if (tool === 'askuserquestion' && input?.questions) {
    const qs = Array.isArray(input.questions) ? input.questions : []
    if (qs.length) {
      const q = qs[0]
      const opts = (Array.isArray(q.options) ? q.options : []).map((o: any) => o.label).filter(Boolean).join(' | ')
      return `Question: ${shorten(q.question || '', 80)}${opts ? ' [' + shorten(opts, 60) + ']' : ''}`
    }
    return 'Question'
  }
  // MCP tools
  if (toolName.startsWith('mcp__') && input) {
    const parts = toolName.split('__')
    const server = parts[1] || ''
    const mcpTool = parts[2] || ''
    return `MCP ${server}/${mcpTool}`
  }
  return toolName
}

