import { ChangeDetectorRef, Component, ElementRef, Injector, Input, ViewChild, ViewContainerRef } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, LogService, Logger, NotificationsService, ProfilesService, TabsService } from 'tabby-core'
import * as childProcess from 'child_process'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'

import { WorkspacesService } from '../services/workspaces.service'
import { ClaudeEventsService } from '../services/claudeEvents.service'
import { ClaudeCloseGuardService } from '../services/closeGuard.service'
import { ClaudeDockLifecycleService } from '../services/lifecycle.service'
import { ClaudeUsageService } from '../services/claudeUsage.service'
import { SessionRuntimeService, SystemResourceStat } from '../services/sessionRuntime.service'
import { TabbyDebugService } from '../services/tabbyDebug.service'
import { WorkspaceTerminalRegistryService } from '../services/workspaceTerminalRegistry.service'
import { ClaudeSession, SavedTerminal, UsageSummary, Workspace } from '../models'
import { displayPath, formatAge, normalizePath, safeJsonParse, usageLabel, usagePct } from '../utils'

interface InternalTerminalSubTab {
  id: string
  title: string
  createdAt: number
  tab: BaseTabComponent
}

interface ResumeCandidate {
  sessionId: string
  status: string
  lastEventTs: number
  firstPrompt: string
}

@Component({
  selector: 'claude-dock-workspace-tab',
  template: `
    <header class="cz-ws-header">
      <div class="cz-ws-top-row">
        <div class="cz-ws-actions">
          <button class="btn btn-sm btn-success" (click)="newClaude()">New</button>
          <button class="btn btn-sm btn-outline-primary" (click)="continueClaude()">Continue</button>
          <select class="form-select form-select-sm cz-resume-select" aria-label="Resume session" [value]="selectedResumeSessionId" (change)="onResumeSelectionChanged($any($event.target).value)">
            <option value="">Select session…</option>
            <option *ngFor="let x of resumeOptions" [value]="x.sessionId">
              {{ resumeLabel(x) }}
            </option>
          </select>
          <button class="btn btn-sm btn-outline-secondary" [disabled]="!selectedResumeSessionId" (click)="resumeClaude()">Resume</button>
          <button class="btn btn-sm btn-outline-success" (click)="newTerminal()">New terminal</button>
        </div>
        <div class="cz-ws-meters" *ngIf="systemStats || usage">
          <div class="cz-ws-meters-row" *ngIf="systemStats">
            <div class="cz-ws-usage-item" aria-label="System CPU load">
              <span class="cz-ws-usage-label">CPU</span>
              <div class="cz-ws-usage-bar" role="meter" aria-label="CPU load" [attr.aria-valuenow]="clamp(systemStats?.cpuLoadPercent)" aria-valuemin="0" aria-valuemax="100">
                <div class="cz-ws-usage-fill" [style.width.%]="100 - clamp(systemStats?.cpuLoadPercent)"></div>
              </div>
              <span class="cz-ws-usage-val">{{ cpuLabel() }}</span>
            </div>
            <div class="cz-ws-usage-item" aria-label="System RAM usage">
              <span class="cz-ws-usage-label">RAM</span>
              <div class="cz-ws-usage-bar" role="meter" aria-label="RAM usage" [attr.aria-valuenow]="clamp(systemStats?.usedMemoryPercent)" aria-valuemin="0" aria-valuemax="100">
                <div class="cz-ws-usage-fill" [style.width.%]="100 - clamp(systemStats?.usedMemoryPercent)"></div>
              </div>
              <span class="cz-ws-usage-val">{{ ramLabel() }}</span>
            </div>
          </div>
          <div class="cz-ws-meters-row" *ngIf="usage">
            <div class="cz-ws-usage-item" aria-label="5-hour usage window">
              <span class="cz-ws-usage-label">5h</span>
              <div class="cz-ws-usage-bar" role="meter" aria-label="5-hour usage" [attr.aria-valuenow]="usagePct(usage?.usage5h?.used)" aria-valuemin="0" aria-valuemax="100">
                <div class="cz-ws-usage-fill" [style.width.%]="100 - usagePct(usage?.usage5h?.used)"></div>
              </div>
              <span class="cz-ws-usage-val">{{ usageLabel(usage?.usage5h) }}</span>
            </div>
            <div class="cz-ws-usage-item" aria-label="7-day usage window">
              <span class="cz-ws-usage-label">7d</span>
              <div class="cz-ws-usage-bar" role="meter" aria-label="7-day usage" [attr.aria-valuenow]="usagePct(usage?.usageWeek?.used)" aria-valuemin="0" aria-valuemax="100">
                <div class="cz-ws-usage-fill" [style.width.%]="100 - usagePct(usage?.usageWeek?.used)"></div>
              </div>
              <span class="cz-ws-usage-val">{{ usageLabel(usage?.usageWeek) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="cz-ws-info-row" *ngIf="workspace?.cwd">
        <span class="cz-ws-path">{{ normalizeCwd(workspace?.cwd || '') }}</span>
        <span class="cz-ws-branch" *ngIf="currentBranch">
          (Git Branch: <select class="cz-branch-select" aria-label="Git branch"
            [value]="currentBranch"
            (change)="switchBranch($any($event.target).value)">
            <option *ngFor="let b of branches" [value]="b">{{ b }}</option>
          </select>)
        </span>
        <span class="cz-ws-no-git" *ngIf="!currentBranch">(No Git Repo)</span>
        <label class="cz-ws-chk" [ngClass]="sandboxChkColor">
          <input type="checkbox" [checked]="useDockerSandbox"
            (change)="toggleDockerSandbox($any($event.target).checked)">
          <span>Docker sandbox</span>
        </label>
        <label class="cz-ws-chk" [ngClass]="mountChkColor" [class.cz-ws-chk-disabled]="!useDockerSandbox">
          <input type="checkbox" [checked]="mountClaudeDir" [disabled]="!useDockerSandbox"
            (change)="toggleMountClaude($any($event.target).checked)">
          <span>Mount ~/.claude</span>
        </label>
        <label class="cz-ws-chk" [ngClass]="permsChkColor">
          <input type="checkbox" [checked]="skipPermissions"
            (change)="toggleSkipPermissions($any($event.target).checked)">
          <span>Dangerously skip permissions</span>
        </label>
      </div>
    </header>

    <div *ngIf="!workspace" class="cz-muted cz-empty">
      Workspace not found.
    </div>

    <main *ngIf="workspace" class="cz-ws-body">
      <div class="cz-subtabs" role="tablist" aria-label="Terminal tabs" *ngIf="terminals.length" (keydown)="onSubtabKeydown($event)">
        <div
          class="cz-subtab"
          role="tab"
          *ngFor="let t of terminals; trackBy: trackTerminalId"
          [class.active]="t.id === activeTerminalId"
          [attr.aria-selected]="t.id === activeTerminalId"
          [attr.tabindex]="t.id === activeTerminalId ? 0 : -1"
          (click)="activateTerminal(t.id)"
        >
          <div class="cz-subtab-info">
            <div class="cz-subtab-title">{{ t.title }}</div>
            <div class="cz-subtab-runtime" *ngIf="subtabRuntime(t.id)">{{ subtabRuntime(t.id) }}</div>
          </div>
          <button class="cz-subtab-close" aria-label="Close terminal" (click)="closeTerminal(t.id); $event.stopPropagation()">×</button>
        </div>
      </div>

      <div *ngIf="!terminals.length" class="cz-muted cz-empty">
        No terminals yet.
      </div>

      <div class="cz-terminal-host" role="tabpanel" [attr.aria-label]="activeTerminalTitle()" [class.cz-terminal-active]="terminals.length > 0" (click)="focusTerminal()" (keydown)="onTerminalHostKey($event)">
        <ng-container #terminalHost></ng-container>
      </div>
    </main>
  `,
  styles: [`
    :host {
      display: flex; flex-direction: column; width: 100%; height: 100%; padding: 0; overflow: hidden;
      --cz-gap-xs: 4px;
      --cz-gap-sm: 8px;
      --cz-gap-md: 12px;
      --cz-bar-height: 8px;
      --cz-click-min: 28px;
      --cz-opacity-muted: 0.7;
      --cz-opacity-dim: 0.6;
      --cz-green: #2cc878;
      --cz-yellow: #d7a92a;
      --cz-red: #d35b5b;
      --cz-orange: #e67e22;
      --cz-green-subtle: rgba(44, 200, 120, .08);
      --cz-green-border: rgba(44, 200, 120, .35);
      --cz-green-hover: rgba(44, 200, 120, .24);
      --cz-green-active: rgba(44, 200, 120, .33);
      --cz-border: rgba(255, 255, 255, .08);
      --cz-border-light: rgba(255, 255, 255, .12);
      --cz-overlay: rgba(0, 0, 0, .55);
      --cz-radius: 8px;
      --cz-radius-pill: 999px;
      --cz-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    .cz-muted { opacity: .7; }
    .cz-empty { padding: 8px 12px; }

    .cz-ws-header { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 10px 10px 8px 10px; }
    .cz-ws-top-row { display: flex; align-items: center; justify-content: flex-start; gap: 12px; flex-wrap: wrap; }
    .cz-ws-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-start; align-items: center; min-width: 0; }
    .cz-resume-select { width: 420px; min-width: 180px; max-width: 100%; flex-shrink: 1; }
    .cz-ws-info-row { display: flex; align-items: center; gap: 6px; font-weight: 700; flex-wrap: wrap; }
    .cz-ws-path { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cz-branch-select { background: transparent; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0 2px; }
    .cz-branch-select option { background: #1e1e2e; color: #d4d4d4; }
    .cz-ws-no-git { opacity: .5; font-weight: 400; font-style: italic; }
    .cz-ws-chk { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; opacity: .7; }
    .cz-ws-chk input { margin: 0; cursor: pointer; }
    .cz-ws-chk-disabled { opacity: .35; pointer-events: none; }
    .cz-ws-chk-green  { opacity: 1; color: var(--cz-green); }  .cz-ws-chk-green  input { accent-color: var(--cz-green); }
    .cz-ws-chk-yellow { opacity: 1; color: var(--cz-yellow); }  .cz-ws-chk-yellow input { accent-color: var(--cz-yellow); }
    .cz-ws-chk-orange { opacity: 1; color: var(--cz-orange); }  .cz-ws-chk-orange input { accent-color: var(--cz-orange); }
    .cz-ws-chk-red    { opacity: 1; color: var(--cz-red); }  .cz-ws-chk-red    input { accent-color: var(--cz-red); }

    .cz-ws-meters { display: flex; flex-direction: row; gap: 8px; flex-shrink: 0; }
    .cz-ws-meters-row { display: flex; gap: 8px; align-items: center; }
    .cz-ws-usage-item { display: grid; grid-template-columns: 4ch 60px auto; align-items: center; gap: 4px; white-space: nowrap; }
    .cz-ws-usage-label { font-weight: 700; opacity: .7; text-transform: uppercase; }
    .cz-ws-usage-bar {
      width: 60px;
      height: var(--cz-bar-height);
      border-radius: var(--cz-radius-pill);
      overflow: hidden;
      background: linear-gradient(90deg, var(--cz-green) 0%, var(--cz-green) 60%, var(--cz-yellow) 80%, var(--cz-red) 100%);
      position: relative;
    }
    .cz-ws-usage-fill {
      position: absolute;
      top: 0; right: 0; bottom: 0;
      background: var(--cz-overlay);
      transition: width .2s ease;
    }
    .cz-ws-usage-val { opacity: var(--cz-opacity-muted); min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }

    .cz-ws-body { display: flex; flex-direction: column; min-height: 0; min-width: 0; width: 100%; flex: 1; }

    .cz-subtabs {
      display: flex;
      gap: 2px;
      align-items: stretch;
      flex-wrap: nowrap;
      margin: 0;
      padding: 0;
      border-bottom: 1px solid var(--cz-border-light);
      overflow-x: auto;
      overflow-y: hidden;
    }
    .cz-subtab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 2px solid transparent;
      background: transparent;
      cursor: pointer;
      user-select: none;
      max-width: 280px;
      margin-bottom: -1px;
      opacity: var(--cz-opacity-dim);
      transition: opacity .15s;
    }
    .cz-subtab { background: rgba(44, 200, 120, .15); }
    .cz-subtab:hover { opacity: .85; background: var(--cz-green-hover); }
    .cz-subtab.active {
      opacity: 1;
      background: var(--cz-green-active);
      border-bottom-color: var(--cz-green);
    }
    .cz-subtab-info { display: flex; flex-direction: column; min-width: 0; }
    .cz-subtab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cz-subtab-close {
      border: none;
      background: transparent;
      color: inherit;
      opacity: .75;
      padding: 4px 6px;
      line-height: 1;
      font-size: 18px;
      cursor: pointer;
    }
    .cz-subtab-close:hover { opacity: 1; }
    .cz-subtab-runtime { font-size: 0.8em; opacity: var(--cz-opacity-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }

    .cz-terminal-host { position: relative; flex: 1; min-height: 0; min-width: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 0; margin: 0; }
    .cz-terminal-host.cz-terminal-active { background: #000; }
    :host ::ng-deep .cz-terminal-host > * { width: 100%; min-width: 0; flex: 1 1 auto; }
    :host ::ng-deep .cz-terminal-host .content { padding: 0 !important; margin: 0 !important; }
    :host ::ng-deep .cz-terminal-host .tab-content { padding: 0 !important; margin: 0 !important; }
    :host ::ng-deep .cz-terminal-host terminal-toolbar { display: none !important; }
    :host ::ng-deep .cz-terminal-host > :first-child { padding: 0 !important; margin: 0 !important; }
    :host ::ng-deep .cz-terminal-host .xterm { padding: 6px 0 0 10px; }

    @media (max-width: 600px) {
      .cz-resume-select { width: 100%; min-width: 0; }
      .cz-ws-meters { width: 100%; }
      .cz-ws-meters-row { flex: 1; }
    }
    @media (max-width: 450px) {
      .cz-ws-header { padding: 6px 8px 4px 8px; }
      .cz-ws-actions { gap: 4px; }
      .cz-ws-actions .btn { padding: 3px 8px; font-size: 0.85em; }
      .cz-resume-select { width: 100%; }
      .cz-ws-info-row { font-size: 0.85em; gap: 4px; }
      .cz-ws-meters { flex-direction: column; gap: 2px; }
    }
  `],
})
export class WorkspaceTabComponent extends BaseTabComponent {
  private _workspaceId: string | null = null
  private terminalSeq = 0
  private isVisible = true
  private isFocused = false
  private mountedTerminalId: string | null = null
  private viewReady = false

  @ViewChild('terminalHost', { read: ViewContainerRef }) private terminalHost?: ViewContainerRef

  @Input() set workspaceId (value: string) {
    const prev = this._workspaceId
    const next = value ?? null
    if (prev && prev !== next) {
      this.terminalRegistry.removeWorkspace(prev)
    }
    this._workspaceId = next
    this.loadWorkspace()
    this.syncTerminalRegistry()
  }

  get workspaceId (): string {
    return this._workspaceId ?? ''
  }

  workspace: Workspace | null = null

  private app: AppService
  private cfg: ConfigService
  private profiles: ProfilesService
  private tabs: TabsService
  private notifications: NotificationsService
  private workspaces: WorkspacesService
  private events: ClaudeEventsService
  private closeGuard: ClaudeCloseGuardService
  private lifecycle: ClaudeDockLifecycleService
  private debug: TabbyDebugService
  private runtimeSvc: SessionRuntimeService
  private usageSvc: ClaudeUsageService
  private terminalRegistry: WorkspaceTerminalRegistryService
  private cdr: ChangeDetectorRef
  private hostRef: ElementRef
  private logger: Logger

  terminals: InternalTerminalSubTab[] = []
  activeTerminalId: string | null = null
  usage: UsageSummary | null = null
  systemStats: SystemResourceStat | null = null
  resumeOptions: ResumeCandidate[] = []
  selectedResumeSessionId = ''
  branches: string[] = []
  currentBranch = ''
  private lastResumeDebugSig = ''
  private promptCache = new Map<string, string>()
  private lastProjectDirMtimeMs = 0


  constructor (injector: Injector) {
    super(injector)
    this.app = injector.get(AppService)
    this.cfg = injector.get(ConfigService)
    this.profiles = injector.get(ProfilesService)
    this.tabs = injector.get(TabsService)
    this.notifications = injector.get(NotificationsService)
    this.workspaces = injector.get(WorkspacesService)
    this.events = injector.get(ClaudeEventsService)
    this.closeGuard = injector.get(ClaudeCloseGuardService)
    this.lifecycle = injector.get(ClaudeDockLifecycleService)
    this.debug = injector.get(TabbyDebugService)
    this.runtimeSvc = injector.get(SessionRuntimeService)
    this.usageSvc = injector.get(ClaudeUsageService)
    this.terminalRegistry = injector.get(WorkspaceTerminalRegistryService)
    this.cdr = injector.get(ChangeDetectorRef)
    this.hostRef = injector.get(ElementRef)
    this.logger = injector.get(LogService).create('claude-dock')

    this.icon = 'fas fa-folder'
    // Prevent user from renaming this tab via Tabby's rename-tab dialog.
    Object.defineProperty(this, 'customTitle', { get: () => '', set: () => {} })
    this.debug.log('workspace.tab.init', {
      workspace_id: this._workspaceId,
    })

    // Workspace data can appear after the tab is created (config loads, inputs assigned).
    // Debounce to avoid feedback loop: cfg.save() -> changed$ -> loadWorkspace -> refreshBranches -> repeat
    let loadTimer: any
    this.subscribeUntilDestroyed(this.cfg.changed$, () => {
      clearTimeout(loadTimer)
      loadTimer = setTimeout(() => this.loadWorkspace(), 300)
    })
    this.subscribeUntilDestroyed(this.events.sessions$, () => {
      this.refreshResumeOptions()
      this.saveTerminalState()
    })
    this.subscribeUntilDestroyed(this.usageSvc.summary$, (s: UsageSummary | null) => {
      this.usage = s
      if (this.viewReady) { try { this.cdr.detectChanges() } catch { } }
    })
    this.subscribeUntilDestroyed(this.runtimeSvc.stats$, () => {
      if (this.viewReady) { try { this.cdr.detectChanges() } catch { } }
    })
    this.subscribeUntilDestroyed(this.runtimeSvc.system$, (s: SystemResourceStat | null) => {
      this.systemStats = s
      if (this.viewReady) { try { this.cdr.detectChanges() } catch { } }
    })

    // Forward focus/visibility to the embedded terminal so keyboard and rendering behave.
    this.subscribeUntilDestroyed(this.focused$, () => {
      this.isFocused = true
      this.isVisible = true
      this.showHost()
      // Re-mount the terminal that was detached on blur
      this.mountActiveTerminal()
      this.refreshBranches()
      // Delay focus forwarding so UI elements (selects, buttons, popups) keep focus
      setTimeout(() => {
        if (!this.isFocused) return
        if (typeof document !== 'undefined') {
          const tag = document.activeElement?.tagName?.toUpperCase()
          if (tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return
        }
        this.getActiveTerminal()?.emitFocused?.()
      }, 80)
    })
    this.subscribeUntilDestroyed(this.blurred$, () => {
      this.isFocused = false
      this.hideHost()
      // Physically detach terminal so it doesn't overlay other tabs
      const active = this.getActiveTerminal()
      if (active) {
        active.emitBlurred?.()
        active.emitVisibility?.(false)
        try { active.removeFromContainer?.() } catch { }
        try { this.terminalHost?.clear() } catch { }
      }
      this.mountedTerminalId = null
    })
    this.subscribeUntilDestroyed(this.visibility$, (v: any) => {
      this.isVisible = !!v
      if (v && this.isFocused) {
        this.showHost()
        this.mountActiveTerminal()
      } else if (!v) {
        this.hideHost()
        // Detach terminal when tab becomes invisible — mirrors blurred$ handler.
        // blurred$ may not fire if focus was on a header element (checkbox, button, select).
        const active = this.getActiveTerminal()
        if (active && this.mountedTerminalId) {
          active.emitVisibility?.(false)
          try { active.removeFromContainer?.() } catch { }
          try { this.terminalHost?.clear() } catch { }
          this.mountedTerminalId = null
        }
      }
      this.getActiveTerminal()?.emitVisibility?.(this.isVisible)
    })
  }

  async getRecoveryToken (): Promise<any> {
    return {
      type: 'app:claude-dock-workspace',
      workspaceId: this.workspaceId,
    }
  }

  async canClose (): Promise<boolean> {
    if (this.lifecycle.closing) {
      return this.closeGuard.confirmWindowClose()
    }
    const label = (this.workspace?.title ?? this.workspace?.cwd ?? this.workspaceId ?? 'workspace').toString()
    return this.closeGuard.confirmWorkspaceClose(label, this.terminals.length)
  }

  ngOnInit (): void {
    this.debug.log('workspace.tab.ngOnInit', {
      workspace_id: this.workspaceId,
    })
    this.loadWorkspace()
  }

  ngAfterViewInit (): void {
    this.viewReady = true
    this.debug.log('workspace.tab.ngAfterViewInit', {
      workspace_id: this.workspaceId,
      has_terminal_host: !!this.terminalHost,
      terminals_count: this.terminals.length,
    })
    // If a terminal was created before the view init (rare), mount it now.
    this.mountActiveTerminal()
    this.restoreTerminalState()
  }

  private loadWorkspace (): void {
    const id = this._workspaceId
    if (!id) {
      this.workspace = null
      this.resumeOptions = []
      this.selectedResumeSessionId = ''
      this.setTitle('Workspace')
      this.debug.log('workspace.load.empty_id')
      return
    }
    const ws = this.workspaces.getById(id)
    // Don't null out workspace if getById returns undefined during a config save.
    // Losing the reference destroys the *ngIf="workspace" block and all terminal views.
    if (ws) {
      this.workspace = { ...ws }
      this.setTitle(ws.title ?? 'Workspace')
    }
    this.debug.log('workspace.load', {
      workspace_id: id,
      found: !!ws,
      cwd: ws?.cwd ?? null,
      profile_id: ws?.profileId ?? null,
    })
    this.refreshResumeOptions()
    this.refreshBranches()
    if (this.viewReady) { try { this.cdr.detectChanges() } catch { } }
  }

  normalizeCwd (cwd: string): string {
    return displayPath(cwd)
  }

  // --- Sandbox / mount / permissions checkboxes (per-workspace) ---

  get useDockerSandbox (): boolean {
    return !!this.workspace?.useDockerSandbox
  }

  get mountClaudeDir (): boolean {
    return !!this.workspace?.mountClaudeDir
  }

  get skipPermissions (): boolean {
    return !!this.workspace?.dangerouslySkipPermissions
  }

  toggleDockerSandbox (checked: boolean): void {
    const patch: any = { useDockerSandbox: checked }
    if (!checked && this.mountClaudeDir) {
      patch.mountClaudeDir = false
    }
    this.workspaces.updateWorkspace(this.workspaceId, patch)
    this.loadWorkspace()
  }

  toggleMountClaude (checked: boolean): void {
    this.workspaces.updateWorkspace(this.workspaceId, { mountClaudeDir: checked })
    this.loadWorkspace()
  }

  toggleSkipPermissions (checked: boolean): void {
    this.workspaces.updateWorkspace(this.workspaceId, { dangerouslySkipPermissions: checked })
    this.loadWorkspace()
  }

  get sandboxChkColor (): string {
    if (!this.useDockerSandbox) return ''
    if (!this.skipPermissions) return 'cz-ws-chk-green'
    return 'cz-ws-chk-yellow'
  }

  get mountChkColor (): string {
    if (!this.mountClaudeDir) return ''
    if (!this.skipPermissions) return 'cz-ws-chk-yellow'
    return 'cz-ws-chk-orange'
  }

  get permsChkColor (): string {
    if (!this.skipPermissions) return ''
    if (!this.useDockerSandbox) return 'cz-ws-chk-red'
    if (!this.mountClaudeDir) return 'cz-ws-chk-orange'
    return 'cz-ws-chk-red'
  }

  // --- Git branch ---

  private refreshingBranches = false

  private refreshBranches (): void {
    const cwd = this.workspace?.cwd
    if (!cwd) {
      this.branches = []
      this.currentBranch = ''
      return
    }
    if (this.refreshingBranches) return
    this.refreshingBranches = true
    childProcess.execFile('git', ['branch', '--no-color'], { cwd, encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      this.refreshingBranches = false
      if (err) {
        this.branches = []
        this.currentBranch = ''
      } else {
        const lines = (stdout || '').split('\n').filter(l => l.trim())
        const parsed: string[] = []
        let current = ''
        for (const line of lines) {
          const name = line.replace(/^\*?\s+/, '').trim()
          if (!name) continue
          parsed.push(name)
          if (line.startsWith('*')) {
            current = name
          }
        }
        this.branches = parsed
        this.currentBranch = current
      }
      if (this.viewReady) { try { this.cdr.detectChanges() } catch { } }
    })
  }

  switchBranch (name: string): void {
    const cwd = this.workspace?.cwd
    if (!cwd || !name) return
    const prev = this.currentBranch
    try {
      childProcess.execFileSync('git', ['checkout', name], { cwd, encoding: 'utf8', timeout: 10000 })
    } catch (e: any) {
      const stderr = String(e?.stderr ?? '').trim()
      const full = stderr || String(e?.message ?? e)
      const brief = full.split('\n').find(l => l.startsWith('error:')) ?? full.split('\n')[0] ?? full
      this.logger.warn('git checkout failed:', full)
      this.notifications.error('Git checkout failed', brief)
      // Force <select> revert: Angular skips DOM update when model value didn't change
      this.currentBranch = ''
      this.cdr.detectChanges()
      this.currentBranch = prev
      this.cdr.detectChanges()
      return
    }
    this.refreshBranches()
  }

  // --- Launch command builder ---

  /** On Windows node-pty can't spawn .cmd/.bat directly — wrap in cmd.exe /c */
  private shellWrap (command: string, args: string[]): { command: string, args: string[] } {
    if (process.platform === 'win32') {
      return { command: 'cmd.exe', args: ['/c', command, ...args] }
    }
    return { command, args }
  }

  private buildLaunchCommand (claudeArgs: string[]): { command: string, args: string[] } {
    const allArgs = [...claudeArgs, ...this.skipPermsArgs()]
    if (this.useDockerSandbox) {
      const dockerArgs = ['sandbox', 'run', '--name', 'claude-in-docker-sandbox',
        '-e', 'FORCE_COLOR=3',
        '-e', `CLAUDE_DOCK_SOURCE=tabby`,
      ]
      if (this.mountClaudeDir) {
        const claudeDir = path.join(os.homedir(), '.claude')
        dockerArgs.push('-v', `${claudeDir}:/home/agent/.claude`)
        // Protect settings.json from being overwritten by Claude inside the container
        const settingsFile = path.join(claudeDir, 'settings.json')
        if (fsSync.existsSync(settingsFile)) {
          dockerArgs.push('-v', `${settingsFile}:/home/agent/.claude/settings.json:ro`)
        }
      }
      dockerArgs.push('claude', ...allArgs)
      return this.shellWrap('docker', dockerArgs)
    }
    return this.shellWrap('claude', allArgs)
  }

  trackTerminalId (_: number, t: InternalTerminalSubTab): string {
    return t.id
  }

  usagePct (v?: number | null): number {
    return usagePct(v)
  }

  usageLabel (bucket?: { used: number, limit: number } | null): string {
    return usageLabel(bucket)
  }

  clamp (v?: number | null): number {
    const n = Number(v ?? 0)
    if (!Number.isFinite(n)) return 0
    return Math.max(0, Math.min(100, n))
  }

  cpuLabel (): string {
    if (!this.systemStats) return '--'
    const v = this.systemStats.cpuLoadPercent
    return v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`
  }

  ramLabel (): string {
    if (!this.systemStats) return '--'
    const used = this.systemStats.totalMemoryBytes - this.systemStats.freeMemoryBytes
    const totalGB = this.systemStats.totalMemoryBytes / (1024 * 1024 * 1024)
    const usedGB = used / (1024 * 1024 * 1024)
    return `${usedGB.toFixed(1)}/${totalGB.toFixed(0)}`
  }

  subtabRuntime (terminalId: string): string {
    const sessions = this.events.sessions$.value ?? []
    const s = sessions.find(x => x.terminalId === terminalId)
    if (!s) return ''
    const rt = this.runtimeSvc.getStat(s.hostPid)
    if (!rt?.running) return ''
    const cpu = Number(rt.cpuPercent ?? 0)
    const mem = Number(rt.memoryBytes ?? 0)
    const cpuStr = cpu < 10 ? `${cpu.toFixed(1)}%` : `${Math.round(cpu)}%`
    const mb = mem / (1024 * 1024)
    const memStr = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
    return `${cpuStr} / ${memStr}`
  }

  /** Defensive: hide :host so workspace can't overlay other tabs even if Tabby
   *  fails to remove content-tab-active from our parent tab-body. */
  private hideHost (): void {
    try {
      this.hostRef.nativeElement.style.display = 'none'
      // Also hide parent tab-body -- its background overlays other tabs
      // even when the component itself is hidden.
      const tabBody = this.hostRef.nativeElement.closest('tab-body')
      if (tabBody) tabBody.style.display = 'none'
    } catch { }
  }

  private showHost (): void {
    try {
      const tabBody = this.hostRef.nativeElement.closest('tab-body')
      if (tabBody) tabBody.style.display = ''
      this.hostRef.nativeElement.style.display = ''
    } catch { }
  }

  private getActiveTerminal (): BaseTabComponent | null {
    if (!this.activeTerminalId) return null
    return this.terminals.find(t => t.id === this.activeTerminalId)?.tab ?? null
  }

  private mountActiveTerminal (): void {
    if (!this.terminalHost) {
      return
    }

    const active = this.getActiveTerminal()
    if (!active) {
      this.terminalHost.clear()
      this.mountedTerminalId = null
      return
    }

    if (this.mountedTerminalId === this.activeTerminalId) {
      return
    }

    // Unmount previously mounted tab, if any.
    try {
      if (this.mountedTerminalId) {
        const prev = this.terminals.find(t => t.id === this.mountedTerminalId)?.tab
        prev?.emitVisibility?.(false)
        if (this.isFocused) {
          prev?.emitBlurred?.()
        }
        prev?.removeFromContainer?.()
      }
    } catch { }

    try {
      this.terminalHost.clear()
    } catch { }

    try {
      active.insertIntoContainer(this.terminalHost)
      active.emitVisibility?.(this.isVisible)
      if (this.isFocused) {
        active.emitFocused?.()
      }
      this.mountedTerminalId = this.activeTerminalId
    } catch (e: any) {
      this.logger.error('mountActiveTerminal: failed', String(e?.message ?? e))
      this.notifications.error('Could not mount terminal inside workspace', String(e?.message ?? e))
      this.debug.log('workspace.terminal.mount_failed', {
        workspace_id: this.workspaceId,
        active_terminal_id: this.activeTerminalId,
        error: String(e?.message ?? e),
      })
    }
  }

  activateTerminal (id: string): void {
    if (!this.terminals.find(t => t.id === id)) {
      return
    }
    this.activeTerminalId = id
    try { this.cdr.detectChanges() } catch { }
    this.mountActiveTerminal()
  }

  focusTerminal (): void {
    const active = this.getActiveTerminal()
    if (active) {
      active.emitFocused?.()
    }
  }

  activeTerminalTitle (): string {
    if (!this.activeTerminalId) return 'Terminal'
    return this.terminals.find(t => t.id === this.activeTerminalId)?.title ?? 'Terminal'
  }

  onSubtabKeydown (event: KeyboardEvent): void {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      this.activateNextTerminal()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      this.activatePrevTerminal()
    }
  }

  activateNextTerminal (): void {
    if (!this.terminals.length) return
    const idx = this.terminals.findIndex(t => t.id === this.activeTerminalId)
    const next = this.terminals[(idx + 1) % this.terminals.length]
    if (next) this.activateTerminal(next.id)
  }

  activatePrevTerminal (): void {
    if (!this.terminals.length) return
    const idx = this.terminals.findIndex(t => t.id === this.activeTerminalId)
    const prev = this.terminals[(idx - 1 + this.terminals.length) % this.terminals.length]
    if (prev) this.activateTerminal(prev.id)
  }

  onTerminalHostKey (event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    if (!target) return
    const tag = target.tagName?.toUpperCase()
    // Let buttons, inputs, selects handle their own keys
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    // Prevent browser from interpreting space as scroll/click inside the terminal host
    if (event.key === ' ') {
      event.preventDefault()
    }
  }

  closeTerminal (id: string): void {
    const idx = this.terminals.findIndex(t => t.id === id)
    if (idx < 0) return
    const title = this.terminals[idx]?.title ?? id
    if (!this.closeGuard.confirmTerminalClose(title)) {
      return
    }

    const wasActive = this.activeTerminalId === id
    const tab = this.terminals[idx].tab

    try {
      if (wasActive) {
        tab.emitVisibility?.(false)
        if (this.isFocused) {
          tab.emitBlurred?.()
        }
        tab.removeFromContainer?.()
        if (this.terminalHost) {
          try { this.terminalHost.clear() } catch { }
        }
        this.mountedTerminalId = null
      }
    } catch { }

    try {
      tab.destroy?.()
    } catch { }
    this.events.markEndedByTerminalId(id, 'workspace_terminal_closed')

    this.terminals.splice(idx, 1)
    this.syncTerminalRegistry()

    if (!this.terminals.length) {
      this.activeTerminalId = null
    } else if (wasActive) {
      const next = this.terminals[Math.min(idx, this.terminals.length - 1)]
      this.activeTerminalId = next?.id ?? null
    }

    try { this.cdr.detectChanges() } catch { }
    this.mountActiveTerminal()
  }

  /** Claude Code project dir name: replace :, \, /, . with - */
  private projectDirName (cwd: string): string {
    return cwd.replace(/[:\\/\.]/g, '-')
  }

  private refreshResumeOptions (): void {
    if (!this.workspace?.cwd) {
      if (this.resumeOptions.length) {
        this.resumeOptions = []
        this.selectedResumeSessionId = ''
        if (this.viewReady) { try { this.cdr.detectChanges() } catch { } }
      }
      return
    }

    const dir = path.join(os.homedir(), '.claude', 'projects', this.projectDirName(this.workspace.cwd))
    let dirStat: fsSync.Stats
    try { dirStat = fsSync.statSync(dir) } catch { return }
    if (!dirStat.isDirectory()) return

    // Skip rescan if directory hasn't changed.
    if (dirStat.mtimeMs === this.lastProjectDirMtimeMs && this.resumeOptions.length) {
      return
    }
    this.lastProjectDirMtimeMs = dirStat.mtimeMs

    // Scan transcript files, sorted by mtime descending.
    const files: Array<{ sessionId: string, filePath: string, mtimeMs: number }> = []
    for (const entry of fsSync.readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue
      try {
        const fp = path.join(dir, entry)
        const st = fsSync.statSync(fp)
        files.push({ sessionId: entry.slice(0, -6), filePath: fp, mtimeMs: st.mtimeMs })
      } catch { continue }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const next: ResumeCandidate[] = files.slice(0, 50).map(f => {
      let firstPrompt = this.promptCache.get(f.sessionId)
      if (firstPrompt === undefined) {
        firstPrompt = this.readFirstPrompt(f.filePath)
        this.promptCache.set(f.sessionId, firstPrompt)
      }
      return {
        sessionId: f.sessionId,
        status: 'ended',
        lastEventTs: f.mtimeMs,
        firstPrompt,
      }
    })

    // Prune promptCache entries for sessions no longer in the current resume list.
    const currentIds = new Set(next.map(x => x.sessionId))
    for (const key of this.promptCache.keys()) {
      if (!currentIds.has(key)) {
        this.promptCache.delete(key)
      }
    }

    const sig = next.map(x => `${x.sessionId}:${x.lastEventTs}`).join('|')
    if (sig === this.lastResumeDebugSig) {
      return
    }
    this.lastResumeDebugSig = sig
    this.resumeOptions = next

    if (this.selectedResumeSessionId && !next.find(x => x.sessionId === this.selectedResumeSessionId)) {
      this.selectedResumeSessionId = ''
    }
    if (!this.selectedResumeSessionId && next.length) {
      this.selectedResumeSessionId = next[0].sessionId
    }

    this.debug.log('workspace.resume_options.update', {
      workspace_id: this.workspace?.id,
      workspace_cwd: this.workspace?.cwd,
      project_dir: dir,
      options_count: next.length,
      selected_session_id: this.selectedResumeSessionId || null,
    })

    if (this.viewReady) { try { this.cdr.detectChanges() } catch { } }
  }

  onResumeSelectionChanged (id: string): void {
    this.selectedResumeSessionId = id ?? ''
    this.debug.log('workspace.resume_selection.changed', {
      workspace_id: this.workspaceId,
      selected_session_id: this.selectedResumeSessionId || null,
    })
  }

  resumeLabel (x: ResumeCandidate): string {
    const age = x.lastEventTs ? formatAge(x.lastEventTs) : ''
    const prompt = x.firstPrompt.replace(/\s+/g, ' ').slice(0, 80)
    if (prompt) {
      const suffix = x.firstPrompt.length > 80 ? '...' : ''
      return age ? `${prompt}${suffix} (${age})` : `${prompt}${suffix}`
    }
    const shortId = x.sessionId.slice(0, 8)
    return age ? `${shortId} (${x.status}, ${age})` : `${shortId} (${x.status})`
  }

  private readFirstPrompt (transcriptPath: string): string {
    try {
      const fd = fsSync.openSync(transcriptPath, 'r')
      try {
        const buf = Buffer.alloc(16384)
        const n = fsSync.readSync(fd, buf, 0, buf.length, 0)
        const text = buf.toString('utf8', 0, n)
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const obj = safeJsonParse<any>(trimmed)
          if (!obj || obj.type !== 'user') continue
          const c = obj.message?.content
          if (typeof c === 'string') return c.trim()
          if (Array.isArray(c)) {
            return c.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join(' ').trim()
          }
        }
      } finally {
        fsSync.closeSync(fd)
      }
    } catch { }
    return ''
  }

  private async resolveWorkspaceProfile (): Promise<{ profile: any, cwd: string } | null> {
    // Make sure we didn't miss late-arriving inputs/config.
    this.loadWorkspace()

    if (!this.workspace?.cwd) {
      if (!this._workspaceId) {
        this.notifications.error('Workspace ID is missing')
      } else if (!this.workspace) {
        this.notifications.error('Workspace not found', this._workspaceId)
      } else {
        this.notifications.error('Workspace has no cwd', this.workspace.title || this._workspaceId)
      }
      this.logger.warn('resolveWorkspaceProfile: missing workspace/cwd', { workspaceId: this._workspaceId, workspace: this.workspace })
      this.debug.log('workspace.resolve_profile.failed', {
        reason: 'missing_workspace_or_cwd',
        workspace_id: this._workspaceId,
        workspace: this.workspace ?? null,
      })
      return null
    }

    const cwd = this.workspace.cwd
    if (cwd && !fsSync.existsSync(cwd)) {
      this.notifications.error('Workspace cwd does not exist', cwd)
      this.logger.warn('resolveWorkspaceProfile: cwd does not exist', { workspaceId: this._workspaceId, cwd })
      this.debug.log('workspace.resolve_profile.failed', {
        reason: 'cwd_missing_on_disk',
        workspace_id: this._workspaceId,
        cwd,
      })
      return null
    }

    const profiles = await this.profiles.getProfiles().catch((e: any) => {
      this.logger.error('resolveWorkspaceProfile: getProfiles failed', String(e?.message ?? e))
      return []
    })

    let profile: any = null
    if (this.workspace.profileId) {
      profile = profiles.find(p => p.id === this.workspace!.profileId) ?? null
    }
    if (!profile) {
      profile = profiles.find(p => (p.type === 'local' || (p.id ?? '').startsWith('local:')) && !p.isTemplate) ?? null
    }
    if (!profile) {
      this.notifications.error('No terminal profile found (tabby-local disabled?)')
      this.logger.warn('resolveWorkspaceProfile: no profile found', { workspaceId: this._workspaceId, cwd })
      this.debug.log('workspace.resolve_profile.failed', {
        reason: 'no_profile_found',
        workspace_id: this._workspaceId,
        cwd,
      })
      return null
    }

    this.debug.log('workspace.resolve_profile.ok', {
      workspace_id: this._workspaceId,
      cwd,
      profile_id: profile.id ?? null,
      profile_type: profile.type ?? null,
    })
    return { profile, cwd }
  }

  private async openWorkspaceTerminal (
    launch?: { command?: string, args?: string[] },
    titleHint?: string,
  ): Promise<void> {
    try {
      this.debug.log('workspace.open_terminal.request', {
        workspace_id: this.workspaceId,
        cwd: this.workspace?.cwd ?? null,
        launch: launch ?? null,
        title_hint: titleHint ?? null,
      })
      const resolved = await this.resolveWorkspaceProfile()
      if (!resolved) {
        this.debug.log('workspace.open_terminal.aborted', {
          workspace_id: this.workspaceId,
          reason: 'resolve_profile_failed',
          launch: launch ?? null,
        })
        return
      }
      const { profile, cwd } = resolved
      const terminalId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

      const baseEnv = { ...(profile?.options?.env ?? {}) }
      const env = {
        ...baseEnv,
        FORCE_COLOR: '3',
        CLAUDE_DOCK_SOURCE: 'tabby',
        CLAUDE_DOCK_TABBY_SESSION: this.debug.sessionId,
        CLAUDE_DOCK_TERMINAL_ID: terminalId,
      }

      const options: any = {
        ...(profile?.options ?? {}),
        cwd,
        env,
      }

      // Direct process launch: replace shell with Claude/Docker executable
      if (launch?.command) {
        options.command = launch.command
        options.args = launch.args ?? []
      }

      const profileWithCwd = {
        ...profile,
        options,
      }

      const params = await this.profiles.newTabParametersForProfile(profileWithCwd).catch((e: any) => {
        this.logger.error('openWorkspaceTerminal: newTabParametersForProfile failed', String(e?.message ?? e))
        this.debug.log('workspace.open_terminal.failed', {
          workspace_id: this.workspaceId,
          reason: 'new_tab_parameters_failed',
          error: String(e?.message ?? e),
          profile_id: profile?.id ?? null,
          cwd,
        })
        return null
      })
      if (!params) {
        this.notifications.error('Could not create terminal tab parameters (tabby-local disabled?)')
        return
      }

      const tab = this.tabs.create(params) as BaseTabComponent
      try { (tab as any).parent = this } catch { }

      const title = titleHint || `term-${++this.terminalSeq}`

      this.terminals.push({
        id: terminalId,
        title,
        createdAt: Date.now(),
        tab,
      })
      this.syncTerminalRegistry()

      this.activeTerminalId = terminalId

      this.subscribeUntilDestroyed(tab.titleChange$, (newTitle: string) => {
        const t = this.terminals.find(x => x.id === terminalId)
        if (t && newTitle) {
          t.title = newTitle
          this.events.updateTitleByTerminalId(terminalId, newTitle)
          try { this.cdr.detectChanges() } catch { }
        }
      })

      this.subscribeUntilDestroyed(tab.destroyed$, () => {
        const idx = this.terminals.findIndex(x => x.id === terminalId)
        if (idx < 0) return
        this.events.markEndedByTerminalId(terminalId, 'process_exited')
        const wasActive = this.activeTerminalId === terminalId
        this.terminals.splice(idx, 1)
        this.syncTerminalRegistry()
        if (!this.terminals.length) {
          this.activeTerminalId = null
        } else if (wasActive) {
          const next = this.terminals[Math.min(idx, this.terminals.length - 1)]
          this.activeTerminalId = next?.id ?? null
        }
        try { this.cdr.detectChanges() } catch {}
        this.mountActiveTerminal()
      })

      try { this.cdr.detectChanges() } catch { }
      this.mountActiveTerminal()
      this.debug.log('workspace.open_terminal.created', {
        workspace_id: this.workspaceId,
        internal_terminal_id: terminalId,
        internal_title: title,
        terminals_count: this.terminals.length,
        cwd,
        profile_id: profile?.id ?? null,
        env_source_marker: env.CLAUDE_DOCK_SOURCE ?? null,
        env_terminal_id: env.CLAUDE_DOCK_TERMINAL_ID ?? null,
        launch: launch ?? null,
      })
    } catch (e: any) {
      this.logger.error('openWorkspaceTerminal: crash', String(e?.message ?? e))
      this.notifications.error('Open terminal crashed', String(e?.message ?? e))
      this.debug.log('workspace.open_terminal.crash', {
        workspace_id: this.workspaceId,
        error: String(e?.message ?? e),
        launch: launch ?? null,
      })
    }
  }

  async newTerminal (): Promise<void> {
    this.debug.log('workspace.action.new_terminal', {
      workspace_id: this.workspaceId,
      cwd: this.workspace?.cwd ?? null,
    })
    await this.openWorkspaceTerminal(undefined, undefined)
  }

  private skipPermsArgs (): string[] {
    return this.skipPermissions ? ['--dangerously-skip-permissions'] : []
  }

  async newClaude (): Promise<void> {
    this.debug.log('workspace.action.new_claude', {
      workspace_id: this.workspaceId,
      cwd: this.workspace?.cwd ?? null,
    })
    const launch = this.buildLaunchCommand([])
    await this.openWorkspaceTerminal(launch, 'new')
  }

  async continueClaude (): Promise<void> {
    this.debug.log('workspace.action.continue', {
      workspace_id: this.workspaceId,
      cwd: this.workspace?.cwd ?? null,
    })
    const launch = this.buildLaunchCommand(['--continue'])
    await this.openWorkspaceTerminal(launch, 'continue')
  }

  async resumeClaude (): Promise<void> {
    const sid = (this.selectedResumeSessionId ?? '').trim()
    if (!sid) {
      this.notifications.error('Select a session first')
      this.debug.log('workspace.action.resume_skipped', {
        workspace_id: this.workspaceId,
        reason: 'no_selected_session',
      })
      return
    }
    this.debug.log('workspace.action.resume', {
      workspace_id: this.workspaceId,
      selected_session_id: sid,
      cwd: this.workspace?.cwd ?? null,
    })
    const launch = this.buildLaunchCommand(['--resume', sid])
    await this.openWorkspaceTerminal(launch, `resume-${sid.slice(0, 8)}`)
  }

  override destroy (skipDestroyedEvent?: boolean): void {
    this.saveTerminalState()
    this.debug.log('workspace.tab.destroy', {
      workspace_id: this.workspaceId,
      terminals_count: this.terminals.length,
      active_terminal_id: this.activeTerminalId,
    })
    // Ensure embedded sessions are torn down when the workspace tab closes.
    try {
      for (const t of this.terminals) {
        this.events.markEndedByTerminalId(t.id, 'workspace_tab_closed')
        try { t.tab.removeFromContainer?.() } catch { }
        try { t.tab.destroy?.() } catch { }
      }
    } catch { }
    this.terminals = []
    this.syncTerminalRegistry()
    if (this.workspaceId) {
      this.terminalRegistry.removeWorkspace(this.workspaceId)
    }
    this.activeTerminalId = null
    this.mountedTerminalId = null

    super.destroy(skipDestroyedEvent)
  }

  private saveTerminalState (): void {
    const store = (this.cfg as any).store
    if (!store || !this.workspaceId) return
    store.claudeDock ??= {}
    store.claudeDock.savedTerminals ??= {}

    const sessions = this.events.sessions$.value ?? []
    const saved: SavedTerminal[] = []

    for (const t of this.terminals) {
      const s = sessions.find(x => x.terminalId === t.id)
      if (s?.sessionId) {
        saved.push({ sessionId: s.sessionId, title: t.title })
      }
    }

    if (saved.length) {
      store.claudeDock.savedTerminals[this.workspaceId] = saved
    } else {
      delete store.claudeDock.savedTerminals[this.workspaceId]
    }
    this.cfg.save()
  }

  private restoreTerminalState (): void {
    const store = (this.cfg as any).store
    if (!store || !this.workspaceId) return
    const saved: SavedTerminal[] =
      store.claudeDock?.savedTerminals?.[this.workspaceId]
    if (!saved?.length) return

    // Clear saved state immediately to avoid double-restore
    delete store.claudeDock.savedTerminals[this.workspaceId]
    this.cfg.save()

    this.debug.log('workspace.restore_terminals', {
      workspace_id: this.workspaceId,
      count: saved.length,
      sessions: saved.map(s => s.sessionId),
    })

    // Resume each saved session
    for (const s of saved) {
      this.openWorkspaceTerminal(
        this.shellWrap('claude', ['--resume', s.sessionId]),
        s.title || `resume-${s.sessionId.slice(0, 8)}`,
      )
    }
  }

  private syncTerminalRegistry (): void {
    const id = this.workspaceId
    if (!id) {
      return
    }
    this.terminalRegistry.setWorkspaceCount(id, this.terminals.length)
  }
}
