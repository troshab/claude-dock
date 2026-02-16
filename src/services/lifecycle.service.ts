import { Injectable, Injector } from '@angular/core'
import { HostWindowService } from 'tabby-core'
import { TabbyDebugService } from './tabbyDebug.service'

@Injectable({ providedIn: 'root' })
export class ClaudeCodeZitLifecycleService {
  closing = false
  windowCloseDecision: boolean | null = null
  closeRequestSeq = 0

  constructor (injector: Injector) {
    const hostWindow = injector.get(HostWindowService)
    const debug = injector.get(TabbyDebugService)
    hostWindow.windowCloseRequest$.subscribe(() => {
      this.closing = true
      this.windowCloseDecision = null
      this.closeRequestSeq++
      debug.log('lifecycle.window_close_request', {
        close_request_seq: this.closeRequestSeq,
      })
    })
  }

  cancelWindowCloseRequest (): void {
    this.closing = false
    this.windowCloseDecision = null
  }
}
