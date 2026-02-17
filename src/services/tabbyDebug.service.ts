import { Injectable, Injector } from '@angular/core'
import { ConfigService, HostWindowService } from 'tabby-core'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

function sanitize (s: string): string {
  return (s ?? '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

@Injectable({ providedIn: 'root' })
export class TabbyDebugService {
  readonly sessionId: string
  readonly logPath: string

  private enabled: boolean
  private startedAt = Date.now()
  private seq = 0
  private writeFailed = false
  private stream: fs.WriteStream | null = null

  constructor (injector: Injector) {
    const cfg = injector.get(ConfigService)
    this.enabled = !!(process.env.CLAUDE_DOCK_DEBUG === '1' || (cfg as any).store?.claudeDock?.debugLogging)

    const stamp = sanitize(new Date().toISOString().replace(/[:.]/g, '-'))
    this.sessionId = `${stamp}-pid${process.pid}`
    const dir = path.join(os.homedir(), '.claude', 'claude-dock', 'tabby-debug')
    this.logPath = path.join(dir, `tabby-session-${this.sessionId}.log`)

    if (this.enabled) {
      try {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true })
        this.stream = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf8' })
        this.stream.on('error', () => {
          if (!this.writeFailed) {
            this.writeFailed = true
            try { console.error('[claude-dock] failed writing debug log', this.logPath) } catch { }
          }
        })
      } catch { }

      this.log('tabby.session.start', {
        session_id: this.sessionId,
        log_path: this.logPath,
        platform: process.platform,
        arch: process.arch,
        versions: process.versions,
        cwd: process.cwd(),
        argv: process.argv.slice(0, 8),
        env: this.pickEnv(),
      })

      this.attachGlobalErrorHandlers()
    }

    try {
      const hostWindow = injector.get(HostWindowService)
      hostWindow.windowCloseRequest$.subscribe(() => {
        this.log('tabby.session.close_request', {
          session_id: this.sessionId,
          uptime_ms: Date.now() - this.startedAt,
        })
      })
    } catch (e: any) {
      this.log('tabby.session.close_hook_unavailable', { error: String(e?.message ?? e) })
    }
  }

  private attachGlobalErrorHandlers (): void {
    try {
      if (typeof window !== 'undefined' && (window as any)?.addEventListener) {
        window.addEventListener('error', (ev: any) => {
          this.log('renderer.error', {
            message: ev?.message ?? null,
            filename: ev?.filename ?? null,
            lineno: ev?.lineno ?? null,
            colno: ev?.colno ?? null,
            stack: String(ev?.error?.stack ?? ev?.error ?? ''),
          })
        })
        window.addEventListener('unhandledrejection', (ev: any) => {
          this.log('renderer.unhandledrejection', {
            reason: String(ev?.reason?.stack ?? ev?.reason ?? ''),
          })
        })
      }
    } catch (e: any) {
      this.log('renderer.error_handlers.attach_failed', {
        error: String(e?.message ?? e),
      })
    }
  }

  private pickEnv (): Record<string, string | null> {
    const keys = [
      'APPDATA',
      'USERPROFILE',
      'HOME',
      'TERM_PROGRAM',
      'TERM',
      'SHELL',
      'COMSPEC',
      'CLAUDE_DOCK_SOURCE',
      'TABBY_PLUGINS',
      'WT_SESSION',
    ]
    const env: Record<string, string | null> = {}
    for (const key of keys) {
      env[key] = process.env[key] ?? null
    }
    return env
  }

  log (event: string, data?: any): void {
    if (!this.enabled) return
    const line = {
      ts_iso: new Date().toISOString(),
      ts_ms: Date.now(),
      seq: ++this.seq,
      event,
      data: data ?? {},
    }
    if (this.stream && !this.writeFailed) {
      this.stream.write(JSON.stringify(line) + '\n')
    }
  }
}
