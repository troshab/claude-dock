import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface HookHealthStatus {
  ok: boolean
  checkedAt: number
  pluginDir: string
  hookPath: string
  hooksJsonPath: string
  missingEvents: string[]
  notes: string[]
}

const PLUGIN_CACHE_BASE = 'claude-dock'
const PLUGIN_NAME = 'dock'

@Injectable({ providedIn: 'root' })
export class HookHealthService {
  readonly status$ = new BehaviorSubject<HookHealthStatus>({
    ok: false,
    checkedAt: Date.now(),
    pluginDir: '',
    hookPath: '',
    hooksJsonPath: '',
    missingEvents: [],
    notes: ['Not checked yet'],
  })

  constructor () {
    this.checkNow()
  }

  private findPluginDir (): string | null {
    const cacheDir = path.join(os.homedir(), '.claude', 'plugins', 'cache', PLUGIN_CACHE_BASE, PLUGIN_NAME)
    try {
      const entries = fs.readdirSync(cacheDir).filter(e => {
        try { return fs.statSync(path.join(cacheDir, e)).isDirectory() } catch { return false }
      })
      if (!entries.length) return null
      // Pick latest version (reverse lexicographic sort)
      entries.sort().reverse()
      // Prefer entries without .orphaned_at marker
      for (const e of entries) {
        if (!fs.existsSync(path.join(cacheDir, e, '.orphaned_at'))) {
          return path.join(cacheDir, e)
        }
      }
      // Fallback: use latest even if orphaned
      return path.join(cacheDir, entries[0])
    } catch {
      return null
    }
  }

  checkNow (): void {
    const pluginDir = this.findPluginDir()
    const hookPath = pluginDir ? path.join(pluginDir, 'claude-dock-hook.js') : ''
    const hooksJsonPath = pluginDir ? path.join(pluginDir, 'hooks', 'hooks.json') : ''
    const notes: string[] = []

    if (!pluginDir) {
      notes.push('Plugin not installed (run Install hooks from dashboard)')
    }

    const hookExists = !!hookPath && fs.existsSync(hookPath)
    const hooksJsonExists = !!hooksJsonPath && fs.existsSync(hooksJsonPath)

    if (pluginDir && !hookExists) {
      notes.push('Hook script missing from plugin')
    }
    if (pluginDir && !hooksJsonExists) {
      notes.push('hooks.json missing from plugin')
    }

    let missingEvents: string[] = []
    if (hooksJsonExists) {
      try {
        const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'))
        const hooks = hooksConfig?.hooks ?? {}
        const expected = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd']
        missingEvents = expected.filter(e => {
          const arr = Array.isArray(hooks[e]) ? hooks[e] : []
          return !arr.some((entry: any) => {
            const entryHooks = Array.isArray(entry?.hooks) ? entry.hooks : []
            return entryHooks.some((h: any) => {
              const cmd = String(h?.command ?? '')
              return cmd.includes('claude-dock-hook.js')
            })
          })
        })
      } catch {
        notes.push('hooks.json parse error')
      }
    }

    if (missingEvents.length) {
      notes.push(`missing hook events: ${missingEvents.join(', ')}`)
    }

    const ok = hookExists && hooksJsonExists && missingEvents.length === 0
    this.status$.next({
      ok,
      checkedAt: Date.now(),
      pluginDir: pluginDir || '',
      hookPath,
      hooksJsonPath,
      missingEvents,
      notes,
    })
  }
}
