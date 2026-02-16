import * as path from 'path'

export function nowMs (): number {
  return Date.now()
}

export function normalizePath (p: string): string {
  return (p ?? '').replace(/\\/g, '/')
}

/** Native-separator path for UI display. Windows → backslashes, others → forward slashes. */
export function displayPath (p: string): string {
  if (!p) return ''
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\')
  }
  return p.replace(/\\/g, '/')
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

