import { Injectable, Injector } from '@angular/core'

import { ClaudeEventsService } from './claudeEvents.service'
import { ClaudeDockLifecycleService } from './lifecycle.service'
import { TabbyDebugService } from './tabbyDebug.service'

@Injectable({ providedIn: 'root' })
export class ClaudeCloseGuardService {
  private events: ClaudeEventsService
  private lifecycle: ClaudeDockLifecycleService
  private debug: TabbyDebugService

  constructor (injector: Injector) {
    this.events = injector.get(ClaudeEventsService)
    this.lifecycle = injector.get(ClaudeDockLifecycleService)
    this.debug = injector.get(TabbyDebugService)
  }

  totalActiveSessionCount (): number {
    return this.events.sessions$.value.length
  }

  activeSessionCountForCwd (cwd: string): number {
    return this.events.listSessionsForWorkspaceCwd(cwd).length
  }

  confirmWindowClose (): boolean {
    const count = this.totalActiveSessionCount()
    if (count <= 0) {
      return true
    }

    if (this.lifecycle.windowCloseDecision !== null) {
      return this.lifecycle.windowCloseDecision
    }

    const ok = this.confirm(
      count === 1
        ? 'There is 1 active Claude session in Tabby.\nDo you really want to close Tabby?'
        : `There are ${count} active Claude sessions in Tabby.\nDo you really want to close Tabby?`,
    )
    this.lifecycle.windowCloseDecision = ok

    this.debug.log('close_guard.window_confirm', {
      session_count: count,
      accepted: ok,
      close_request_seq: this.lifecycle.closeRequestSeq,
    })

    if (!ok) {
      this.lifecycle.cancelWindowCloseRequest()
    }
    return ok
  }

  confirmWorkspaceClose (workspaceTitle?: string, activeSessionCount = 0): boolean {
    const count = Math.max(0, Math.floor(Number(activeSessionCount) || 0))
    if (count <= 0) {
      return true
    }
    const label = (workspaceTitle ?? '').trim() || 'workspace'
    const ok = this.confirm(
      count === 1
        ? `"${label}" has 1 active Claude session.\nDo you really want to close this workspace?`
        : `"${label}" has ${count} active Claude sessions.\nDo you really want to close this workspace?`,
    )

    this.debug.log('close_guard.workspace_confirm', {
      session_count: count,
      accepted: ok,
      workspace: label,
    })
    return ok
  }

  confirmTerminalClose (terminalTitle?: string): boolean {
    const label = (terminalTitle ?? '').trim() || 'terminal'
    const ok = this.confirm(
      `Do you really want to close "${label}"?`,
    )

    this.debug.log('close_guard.terminal_confirm', {
      accepted: ok,
      terminal: label,
    })
    return ok
  }

  private confirm (text: string): boolean {
    try {
      if (typeof window !== 'undefined' && typeof (window as any).confirm === 'function') {
        return !!(window as any).confirm(text)
      }
    } catch { }
    return true
  }
}
