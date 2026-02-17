import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'

import { Injectable } from '@angular/core'
import TabbyCorePlugin, { AppService, BaseTabComponent, ConfigProvider, CommandProvider, ConfigService, HostWindowService, MenuItemOptions, PlatformService, TabContextMenuItemProvider, TabRecoveryProvider, TabsService } from 'tabby-core'

import { ClaudeCodeZitConfigProvider } from './config'
import { ClaudeCodeZitCommandProvider } from './commands'
import { ClaudeCodeZitRecoveryProvider } from './recoveryProvider'

import { DashboardTabComponent } from './components/dashboardTab.component'
import { WorkspaceTabComponent } from './components/workspaceTab.component'

import { ClaudeCodeZitLifecycleService } from './services/lifecycle.service'
import { TabbyDebugService } from './services/tabbyDebug.service'

/** Shared variable: tracks which tab the context menu was opened for. */
let _czLastContextMenuTab: BaseTabComponent | null = null

/** Sentinel provider. weight=9999 ensures it runs last among all providers. */
@Injectable()
class CzContextMenuSentinel extends TabContextMenuItemProvider {
  weight = 9999
  async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
    _czLastContextMenuTab = tab
    return []
  }
}

@NgModule({
  imports: [
    CommonModule,
    TabbyCorePlugin,
  ],
  providers: [
    { provide: ConfigProvider, useClass: ClaudeCodeZitConfigProvider, multi: true },
    { provide: CommandProvider, useClass: ClaudeCodeZitCommandProvider, multi: true },
    { provide: TabContextMenuItemProvider, useClass: CzContextMenuSentinel, multi: true },
    { provide: TabRecoveryProvider, useClass: ClaudeCodeZitRecoveryProvider, multi: true },
  ],
  declarations: [
    DashboardTabComponent,
    WorkspaceTabComponent,
  ],
})
export default class ClaudeCodeZitModule {
  private reordering = false
  private stylesInjected = false

  private constructor (
    private app: AppService,
    private config: ConfigService,
    private tabs: TabsService,
    platform: PlatformService,
    hostWindow: HostWindowService,
    lifecycle: ClaudeCodeZitLifecycleService,
    debug: TabbyDebugService,
  ) {
    // Ensure lifecycle service instantiated.
    void lifecycle
    void debug

    // Monkey-patch context menu: for our tabs, keep only "Close" from the management group.
    const proto = Object.getPrototypeOf(platform)
    const origPopup = proto.popupContextMenu
    proto.popupContextMenu = function (this: any, items: MenuItemOptions[], event?: MouseEvent) {
      const tab = _czLastContextMenuTab
      _czLastContextMenuTab = null
      if (tab instanceof DashboardTabComponent || tab instanceof WorkspaceTabComponent) {
        // Strip trailing separators (our sentinel and others may add empty sections).
        while (items.length && items[items.length - 1].type === 'separator') {
          items.pop()
        }
        // Find the last separator that has items after it -- that's the management group.
        let lastSepIdx = -1
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].type === 'separator') {
            lastSepIdx = i
            break
          }
        }
        if (lastSepIdx >= 0) {
          items = [...items.slice(0, lastSepIdx + 1), {
            label: 'Close all',
            click: () => hostWindow.close(),
          }]
        }
      }
      return origPopup.call(this, items, event)
    }

    this.app.ready$.subscribe(() => {
      debug.log('plugin.ready', {
        tabs_count: this.app.tabs.length,
      })
      this.injectStylesOnce()
      this.subscribeTabsChanged()
    })
  }

  private isDashboardPinned (): boolean {
    const v = (this.config as any).store?.claudeCodeZit?.dashboardPinned
    return v !== false
  }

  private subscribeTabsChanged (): void {
    const tabsChanged$ = (this.app as any).tabsChanged$
    if (tabsChanged$?.subscribe) {
      tabsChanged$.subscribe(() => this.onTabsChanged())
    } else {
      // Fallback: keep a light watchdog in case API changes.
      setInterval(() => this.onTabsChanged(), 2000)
    }
    this.onTabsChanged()
  }

  private onTabsChanged (): void {
    if (this.reordering) {
      return
    }

    if (!this.isDashboardPinned()) {
      this.markDashboardHeader(false)
      return
    }

    this.ensureDashboard()
    this.ensureDashboardFirst()
    this.markDashboardHeader(true)
  }

  private ensureDashboard (): void {
    const existing = this.app.tabs.find(t => t instanceof DashboardTabComponent) as DashboardTabComponent | undefined
    if (!existing) {
      const prev = this.app.activeTab
      const tab = this.tabs.create({ type: DashboardTabComponent })
      this.app.addTabRaw(tab, 0)
      if (prev) {
        this.app.selectTab(prev)
      }
      return
    }
  }

  private ensureDashboardFirst (): void {
    const idx = this.app.tabs.findIndex(t => t instanceof DashboardTabComponent)
    if (idx <= 0) {
      return
    }

    try {
      this.reordering = true
      const [tab] = this.app.tabs.splice(idx, 1)
      if (!tab) {
        return
      }
      this.app.tabs.unshift(tab)
      this.app.emitTabsChanged()
    } finally {
      this.reordering = false
    }
  }

  private injectStylesOnce (): void {
    if (this.stylesInjected) {
      return
    }
    this.stylesInjected = true

    if (typeof document === 'undefined') {
      return
    }
    if (document.getElementById('claude-code-zit-styles')) {
      return
    }

    const style = document.createElement('style')
    style.id = 'claude-code-zit-styles'
    style.textContent = `
      tab-header.ccz-dashboard-tabheader .buttons button:last-child {
        display: none !important;
      }
      .cz-terminal-host .xterm-viewport {
        background-color: #000 !important;
      }
    `
    document.head.appendChild(style)
  }

  private markDashboardHeader (pinned: boolean): void {
    if (typeof document === 'undefined') {
      return
    }

    // Remove any stale markers first.
    try {
      document.querySelectorAll('tab-header.ccz-dashboard-tabheader').forEach((el: any) => {
        try { el.classList.remove('ccz-dashboard-tabheader') } catch { }
      })
    } catch { }

    if (!pinned) {
      return
    }

    const idx = this.app.tabs.findIndex(t => t instanceof DashboardTabComponent)
    if (idx !== 0) {
      return
    }

    // DOM updates lag behind app.emitTabsChanged(); defer a tick.
    setTimeout(() => {
      try {
        const header = document.querySelector('.tab-bar .tabs tab-header:first-child') as any
        header?.classList?.add?.('ccz-dashboard-tabheader')
      } catch { }
    }, 0)
  }
}

export { DashboardTabComponent, WorkspaceTabComponent }
