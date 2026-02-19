import { Injectable, Injector } from '@angular/core'
import { AppService, Command, CommandContext, CommandLocation, CommandProvider, ConfigService, NotificationsService, PlatformService } from 'tabby-core'

import * as os from 'os'
import * as path from 'path'

import { WorkspacesService } from './services/workspaces.service'
import { HookHealthService } from './services/hookHealth.service'
import { DashboardTabComponent } from './components/dashboardTab.component'
import { WorkspaceTabComponent } from './components/workspaceTab.component'
import { pathBase } from './utils'

@Injectable()
export class ClaudeDockCommandProvider extends CommandProvider {
  private app: AppService
  private cfg: ConfigService
  private notifications: NotificationsService
  private platform: PlatformService
  private workspaces: WorkspacesService
  private hookHealth: HookHealthService

  constructor (injector: Injector) {
    super()
    this.app = injector.get(AppService)
    this.cfg = injector.get(ConfigService)
    this.notifications = injector.get(NotificationsService)
    this.platform = injector.get(PlatformService)
    this.workspaces = injector.get(WorkspacesService)
    this.hookHealth = injector.get(HookHealthService)
  }

  private async requireHooks (): Promise<boolean> {
    await this.hookHealth.checkNow()
    if (this.hookHealth.status$.value.ok) {
      return true
    }
    this.notifications.error('Claude hooks not installed. Opening dashboard to set up.')
    this.focusDashboard()
    return false
  }

  private focusDashboard (): void {
    const existing = this.app.tabs.find(t => t instanceof DashboardTabComponent) as DashboardTabComponent | undefined
    if (existing) {
      this.app.selectTab(existing)
      return
    }
    this.app.openNewTabRaw({ type: DashboardTabComponent })
  }

  private async openWorkspaceSelector (): Promise<void> {
    if (!(await this.requireHooks())) return
    const ws = await this.workspaces.pickWorkspace()
    if (!ws) return

    const existing = this.app.tabs.find(t => t instanceof WorkspaceTabComponent && t.workspaceId === ws.id) as WorkspaceTabComponent | undefined
    if (existing) {
      this.app.selectTab(existing)
      return
    }
    this.app.openNewTabRaw({ type: WorkspaceTabComponent, inputs: { workspaceId: ws.id } })
  }

  private async createWorkspace (): Promise<void> {
    if (!(await this.requireHooks())) return
    const ws = await this.workspaces.createInteractive()
    if (!ws) return
    this.app.openNewTabRaw({ type: WorkspaceTabComponent, inputs: { workspaceId: ws.id } })
  }

  private async openWorkspaceFolder (): Promise<void> {
    if (!(await this.requireHooks())) return
    const ws = await this.workspaces.openFromFolderPicker()
    if (!ws) return

    const existing = this.app.tabs.find(t => t instanceof WorkspaceTabComponent && t.workspaceId === ws.id) as WorkspaceTabComponent | undefined
    if (existing) {
      this.app.selectTab(existing)
      return
    }
    this.app.openNewTabRaw({ type: WorkspaceTabComponent, inputs: { workspaceId: ws.id } })
  }

  private async openWorkspaceFromActiveTab (): Promise<void> {
    if (!(await this.requireHooks())) return
    let tab: any = this.app.activeTab as any
    if (!tab) {
      this.notifications.error('No active tab')
      return
    }
    if (typeof tab.getFocusedTab === 'function') {
      tab = tab.getFocusedTab() ?? tab
    }

    let cwd: string | null = null
    try {
      cwd = await tab?.session?.getWorkingDirectory?.()
    } catch { }
    cwd ??= tab?.profile?.options?.cwd ?? tab?.cwd ?? null

    if (!cwd) {
      this.notifications.error('Could not detect cwd for the active tab')
      return
    }

    const profileId = tab?.profile?.id ?? undefined

    let ws = this.workspaces.findByCwd(cwd)
    if (!ws) {
      ws = this.workspaces.create({ cwd, title: pathBase(cwd) || cwd, profileId })
    } else if (profileId && !ws.profileId) {
      // Remember the profile for next terminals opened from this workspace.
      ws.profileId = profileId
      this.cfg.save()
    }

    const existing = this.app.tabs.find(t => t instanceof WorkspaceTabComponent && t.workspaceId === ws!.id) as WorkspaceTabComponent | undefined
    if (existing) {
      this.app.selectTab(existing)
      return
    }
    this.app.openNewTabRaw({ type: WorkspaceTabComponent, inputs: { workspaceId: ws!.id } })
  }

  private toggleWaitingNotifications (): void {
    const store = (this.cfg as any).store
    if (!store) {
      return
    }
    store.claudeDock ??= {}
    store.claudeDock.notifyOnWaiting = !store.claudeDock.notifyOnWaiting
    this.cfg.save()
  }

  async provide (context: CommandContext): Promise<Command[]> { // eslint-disable-line @typescript-eslint/no-unused-vars
    const cmds: Command[] = []

    cmds.push({
      id: 'claude-dock:focus-dashboard',
      label: 'Claude: Focus dashboard',
      weight: -10,
      run: async () => this.focusDashboard(),
    })

    cmds.push({
      id: 'claude-dock:new-workspace',
      label: 'Claude: New workspace',
      weight: 0,
      run: async () => this.createWorkspace(),
    })

    cmds.push({
      id: 'claude-dock:open-workspace',
      label: 'Claude: Open workspace…',
      locations: [CommandLocation.StartPage],
      weight: 1,
      run: async () => this.openWorkspaceSelector(),
    })

    cmds.push({
      id: 'claude-dock:open-workspace-folder',
      label: 'Claude: Open workspace folder…',
      locations: [CommandLocation.StartPage, CommandLocation.LeftToolbar],
      weight: -9,
      icon: '<i class="fas fa-folder-open"></i>',
      run: async () => this.openWorkspaceFolder(),
    })

    cmds.push({
      id: 'claude-dock:open-workspace-from-active-tab',
      label: 'Claude: Open workspace from active tab',
      weight: -8,
      run: async () => this.openWorkspaceFromActiveTab(),
    })

    cmds.push({
      id: 'claude-dock:toggle-notify-waiting',
      label: `Claude: Notify on waiting (${(this.cfg as any).store?.claudeDock?.notifyOnWaiting ? 'on' : 'off'})`,
      locations: [CommandLocation.StartPage],
      weight: 2,
      run: async () => this.toggleWaitingNotifications(),
    })

    cmds.push({
      id: 'claude-dock:open-plugins-dir',
      label: 'Claude: Open Tabby plugins directory',
      locations: [CommandLocation.StartPage],
      weight: 50,
      run: async () => {
        const home = os.homedir()
        const p = process.platform === 'win32'
          ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'tabby', 'plugins')
          : process.platform === 'darwin'
            ? path.join(home, 'Library', 'Application Support', 'tabby', 'plugins')
            : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'tabby', 'plugins')
        try {
          this.platform.openPath(p)
        } catch (e: any) {
          this.notifications.error('Could not open plugins directory', String(e?.message ?? e))
        }
      },
    })

    return cmds
  }
}
