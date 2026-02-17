import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'

import { Injectable } from '@angular/core'
import TabbyCorePlugin, { AppService, BaseTabComponent, ConfigProvider, CommandProvider, ConfigService, HostWindowService, MenuItemOptions, PlatformService, TabContextMenuItemProvider, TabRecoveryProvider, TabsService } from 'tabby-core'

import { ClaudeDockConfigProvider } from './config'
import { ClaudeDockCommandProvider } from './commands'
import { ClaudeDockRecoveryProvider } from './recoveryProvider'

import { DashboardTabComponent } from './components/dashboardTab.component'
import { WorkspaceTabComponent } from './components/workspaceTab.component'

import { ClaudeDockLifecycleService } from './services/lifecycle.service'
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
    { provide: ConfigProvider, useClass: ClaudeDockConfigProvider, multi: true },
    { provide: CommandProvider, useClass: ClaudeDockCommandProvider, multi: true },
    { provide: TabContextMenuItemProvider, useClass: CzContextMenuSentinel, multi: true },
    { provide: TabRecoveryProvider, useClass: ClaudeDockRecoveryProvider, multi: true },
  ],
  declarations: [
    DashboardTabComponent,
    WorkspaceTabComponent,
  ],
})
export default class ClaudeDockModule {
  private reordering = false
  private stylesInjected = false

  private constructor (
    private app: AppService,
    private config: ConfigService,
    private tabs: TabsService,
    platform: PlatformService,
    hostWindow: HostWindowService,
    lifecycle: ClaudeDockLifecycleService,
    debug: TabbyDebugService,
  ) {
    // Ensure lifecycle service instantiated.
    void lifecycle
    void debug

    // One-time config migration: claudeCodeZit -> claudeDock
    const store = (this.config as any).store
    if (store?.claudeCodeZit && !store?.claudeDock?.workspaces?.length) {
      store.claudeDock = { ...store.claudeCodeZit }
      delete store.claudeCodeZit
      this.config.save()
    }

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

      // After Tabby finishes recovering all tabs, ensure dashboard keeps focus.
      // Recovery is synchronous, but workspace ngAfterViewInit (terminal restore)
      // is deferred — 500ms is enough for recovery to complete.
      if (this.isDashboardPinned()) {
        setTimeout(() => {
          const dashboard = this.app.tabs.find(t => t instanceof DashboardTabComponent)
          if (dashboard) {
            this.app.selectTab(dashboard)
          }
        }, 500)
      }
    })
  }

  private isDashboardPinned (): boolean {
    const v = (this.config as any).store?.claudeDock?.dashboardPinned
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
    if (existing) {
      return
    }
    const tab = this.tabs.create({ type: DashboardTabComponent })
    this.app.addTabRaw(tab, 0)
    this.app.selectTab(tab)
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
    if (document.getElementById('claude-dock-styles')) {
      return
    }

    const style = document.createElement('style')
    style.id = 'claude-dock-styles'
    style.textContent = `
      tab-header.ccd-dashboard-tabheader .buttons button:last-child {
        display: none !important;
      }
      .cd-terminal-host .xterm-viewport {
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
      document.querySelectorAll('tab-header.ccd-dashboard-tabheader').forEach((el: any) => {
        try { el.classList.remove('ccd-dashboard-tabheader') } catch { }
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
        header?.classList?.add?.('ccd-dashboard-tabheader')
      } catch { }
    }, 0)
  }
}

export { DashboardTabComponent, WorkspaceTabComponent }
