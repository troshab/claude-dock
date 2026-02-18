import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Injector, Input, NgZone, ViewChild, ViewContainerRef } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, LogService, Logger, NotificationsService, ProfilesService, TabsService } from 'tabby-core'
import * as childProcess from 'child_process'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'

import { resolveForPty, cleanEnv, ResolvedCommand } from '../launch'
import { WorkspacesService } from '../services/workspaces.service'
import { ClaudeEventsService } from '../services/claudeEvents.service'
import { ClaudeCloseGuardService } from '../services/closeGuard.service'
import { ClaudeDockLifecycleService } from '../services/lifecycle.service'
import { ClaudeUsageService } from '../services/claudeUsage.service'
import { SessionRuntimeService } from '../services/sessionRuntime.service'
import { TabbyDebugService } from '../services/tabbyDebug.service'
import { WorkspaceTerminalRegistryService } from '../services/workspaceTerminalRegistry.service'
import { ClaudeSession, SavedTerminal, UsageSummary, Workspace } from '../models'
import { displayPath, formatAge, nativePath, normalizePath, safeJsonParse, usageLabel, usagePct } from '../utils'

interface InternalTerminalSubTab {
  id: string
  title: string
  createdAt: number
  tab: BaseTabComponent
  /** Docker sandbox name, if launched via docker sandbox run. Used for cleanup. */
  sandboxName?: string
  /** Virtual (negative) PID for Docker container stats lookup. */
  virtualPid?: number
}

interface ResumeCandidate {
  sessionId: string
  status: string
  lastEventTs: number
  firstPrompt: string
}

@Component({
  selector: 'claude-dock-workspace-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cd-ws-header">
      <div class="cd-ws-top-row">
        <div class="cd-ws-actions">
          <button class="btn btn-sm btn-success" (click)="newClaude()">New</button>
          <button class="btn btn-sm btn-outline-primary" (click)="continueClaude()">Continue</button>
          <select class="form-control form-control-sm cd-resume-select" aria-label="Resume session" [value]="selectedResumeSessionId" (change)="onResumeSelectionChanged($any($event.target).value)">
            <option value="">Select session…</option>
            <option *ngFor="let x of resumeOptions" [value]="x.sessionId">
              {{ resumeLabel(x) }}
            </option>
          </select>
          <button class="btn btn-sm btn-outline-secondary" [disabled]="!selectedResumeSessionId" (click)="resumeClaude()">Resume</button>
          <button class="btn btn-sm btn-outline-success" (click)="newTerminal()">New terminal</button>
        </div>
        <div class="cd-ws-runtime" role="region" aria-label="Workspace resources" *ngIf="wsStats.count">
          <span class="cd-ws-rt-name">CPU</span>
          <span class="cd-ws-rt-value">{{ wsCpuLabel() }}</span>
          <span class="cd-ws-rt-name cd-ws-rt-sep">RAM</span>
          <span class="cd-ws-rt-value">{{ wsRamLabel() }}</span>
        </div>
        <div class="cd-ws-meters" *ngIf="usage">
          <div class="cd-ws-meters-row">
            <div class="cd-ws-usage-item" aria-label="5-hour usage window">
              <span class="cd-ws-usage-label">5h</span>
              <div class="cd-ws-usage-bar" role="meter" aria-label="5-hour usage" [attr.aria-valuenow]="usagePct(usage?.usage5h?.used)" aria-valuemin="0" aria-valuemax="100">
                <div class="cd-ws-usage-fill" [style.width.%]="100 - usagePct(usage?.usage5h?.used)"></div>
              </div>
              <span class="cd-ws-usage-val">{{ usageLabel(usage?.usage5h) }}</span>
            </div>
            <div class="cd-ws-usage-item" aria-label="7-day usage window">
              <span class="cd-ws-usage-label">7d</span>
              <div class="cd-ws-usage-bar" role="meter" aria-label="7-day usage" [attr.aria-valuenow]="usagePct(usage?.usageWeek?.used)" aria-valuemin="0" aria-valuemax="100">
                <div class="cd-ws-usage-fill" [style.width.%]="100 - usagePct(usage?.usageWeek?.used)"></div>
              </div>
              <span class="cd-ws-usage-val">{{ usageLabel(usage?.usageWeek) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="cd-ws-info-row" *ngIf="workspace?.cwd">
        <span class="cd-ws-path">{{ normalizeCwd(workspace?.cwd || '') }}</span>
        <span class="cd-ws-branch" *ngIf="currentBranch">
          (Git Branch: <select class="form-control form-control-sm cd-branch-select" aria-label="Git branch"
            [value]="currentBranch"
            (change)="switchBranch($any($event.target).value)">
            <option *ngFor="let b of branches" [value]="b">{{ b }}</option>
          </select>)
        </span>
        <span class="cd-ws-no-git" *ngIf="!currentBranch">(No Git Repo)</span>
        <label class="cd-ws-chk" [ngClass]="sandboxChkColor">
          <input type="checkbox" [checked]="useDockerSandbox"
            (change)="toggleDockerSandbox($any($event.target).checked)">
          <span>Inside Docker</span>
        </label>
        <input class="cd-ws-image-input" type="text" aria-label="Docker image"
          [placeholder]="defaultDockerImage" [value]="workspaceDockerImage"
          [disabled]="!useDockerSandbox"
          (change)="onDockerImageChanged($any($event.target).value)"
          (blur)="onDockerImageChanged($any($event.target).value)">
        <label class="cd-ws-chk" [ngClass]="mountChkColor" [class.cd-ws-chk-disabled]="!useDockerSandbox">
          <input type="checkbox" [checked]="mountClaudeDir" [disabled]="!useDockerSandbox"
            (change)="toggleMountClaude($any($event.target).checked)">
          <span>Mount ~/.claude</span>
        </label>
        <label class="cd-ws-chk" [ngClass]="permsChkColor">
          <input type="checkbox" [checked]="skipPermissions"
            (change)="toggleSkipPermissions($any($event.target).checked)">
          <span>Dangerously skip permissions</span>
        </label>
        <span class="cd-ws-ports" [class.cd-ws-ports-disabled]="!useDockerSandbox" *ngIf="forwardPorts.length || useDockerSandbox">
          <span class="cd-ws-ports-label">Ports forwarded to Docker's localhost:</span>
          <span class="cd-port-tag" *ngFor="let p of forwardPorts">
            {{ p }}<button class="cd-port-rm" [disabled]="!useDockerSandbox" (click)="removePort(p)">&times;</button>
          </span>
          <input class="cd-port-input" type="text" placeholder="port" aria-label="Add forwarded port"
            size="5" maxlength="5" [disabled]="!useDockerSandbox"
            (keydown.enter)="addPortFromInput($event)"
            (blur)="addPortFromInput($event)">
          <span class="cd-port-hook">(19542 port binded for Claude Dock hook's)</span>
        </span>
      </div>
    </header>

    <div *ngIf="!workspace" class="cd-muted cd-empty">
      Workspace not found.
    </div>

    <main *ngIf="workspace" class="cd-ws-body">
      <div class="cd-subtabs" role="tablist" aria-label="Terminal tabs" *ngIf="terminals.length" (keydown)="onSubtabKeydown($event)">
        <div
          class="cd-subtab"
          role="tab"
          *ngFor="let t of terminals; trackBy: trackTerminalId"
          [class.active]="t.id === activeTerminalId"
          [attr.aria-selected]="t.id === activeTerminalId"
          [attr.tabindex]="t.id === activeTerminalId ? 0 : -1"
          (click)="activateTerminal(t.id)"
        >
          <div class="cd-subtab-info">
            <div class="cd-subtab-title">{{ t.title }}</div>
            <div class="cd-subtab-runtime" *ngIf="subtabRuntime(t.id)">{{ subtabRuntime(t.id) }}</div>
          </div>
          <button class="btn btn-sm cd-subtab-close" aria-label="Close terminal" (click)="closeTerminal(t.id); $event.stopPropagation()">×</button>
        </div>
      </div>

      <div *ngIf="!terminals.length" class="cd-muted cd-empty">
        No terminals yet.
      </div>

      <div class="cd-terminal-host" role="tabpanel" [attr.aria-label]="activeTerminalTitle()" [class.cd-terminal-active]="terminals.length > 0" (click)="focusTerminal()" (keydown)="onTerminalHostKey($event)">
        <ng-container #terminalHost></ng-container>
      </div>
    </main>
  `,
  styles: [`
    :host {
      display: flex; flex-direction: column; width: 100%; height: 100%; padding: 0; overflow: hidden;
      --cd-gap-xs: 4px;
      --cd-gap-sm: 8px;
      --cd-gap-md: 12px;
      --cd-bar-height: 8px;
      --cd-click-min: 28px;
      --cd-opacity-muted: 0.7;
      --cd-opacity-dim: 0.6;
      --cd-green: #3ba67a;
      --cd-yellow: #d7a92a;
      --cd-red: #d35b5b;
      --cd-orange: #e67e22;
      --cd-green-subtle: rgba(59, 166, 122, .08);
      --cd-green-border: rgba(59, 166, 122, .35);
      --cd-green-hover: rgba(59, 166, 122, .24);
      --cd-green-active: rgba(59, 166, 122, .33);
      --cd-border: rgba(255, 255, 255, .08);
      --cd-border-light: rgba(255, 255, 255, .12);
      --cd-overlay: rgba(0, 0, 0, .55);
      --cd-radius: 8px;
      --cd-radius-pill: 999px;
      --cd-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --cd-gap-micro: 2px;
      --cd-gap-xs-plus: 6px;
      --cd-radius-sm: 4px;
      --cd-option-bg: #1e1e2e;
      --cd-option-text: #d4d4d4;
      --cd-terminal-bg: #000;
      --cd-green-tab: rgba(59, 166, 122, .15);
    }
    .cd-muted { opacity: .7; }
    .cd-empty { padding: var(--cd-gap-sm) var(--cd-gap-md); }

    .cd-ws-header { display: flex; flex-direction: column; gap: var(--cd-gap-sm); margin: 0; padding: 10px 10px var(--cd-gap-sm) 10px; }
    .cd-ws-top-row { display: flex; align-items: center; justify-content: flex-start; gap: var(--cd-gap-md); flex-wrap: wrap; }
    .cd-ws-actions { display: flex; gap: var(--cd-gap-sm); flex-wrap: wrap; justify-content: flex-start; align-items: center; min-width: 0; }
    .cd-resume-select { width: 420px; min-width: 180px; max-width: 100%; flex-shrink: 1; }
    .cd-ws-info-row { display: flex; align-items: center; gap: var(--cd-gap-xs-plus); font-weight: 700; flex-wrap: wrap; }
    .cd-ws-path { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cd-branch-select { background: transparent; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0 var(--cd-gap-micro); height: auto; line-height: inherit; border-radius: 0; display: inline; width: auto; }
    .cd-branch-select option { background: var(--cd-option-bg); color: var(--cd-option-text); }
    .cd-ws-no-git { opacity: .5; font-weight: 400; font-style: italic; }
    .cd-ws-chk { display: inline-flex; align-items: center; gap: var(--cd-gap-xs); cursor: pointer; user-select: none; opacity: .7; }
    .cd-ws-chk input { margin: 0; cursor: pointer; }
    .cd-ws-chk-disabled { opacity: .35; pointer-events: none; }
    .cd-ws-chk-green  { opacity: 1; color: var(--cd-green); }  .cd-ws-chk-green  input { accent-color: var(--cd-green); }
    .cd-ws-chk-yellow { opacity: 1; color: var(--cd-yellow); }  .cd-ws-chk-yellow input { accent-color: var(--cd-yellow); }

    .cd-ws-ports { display: inline-flex; align-items: center; gap: var(--cd-gap-xs); flex-wrap: wrap; }
    .cd-ws-ports-disabled { opacity: .35; pointer-events: none; }
    .cd-ws-ports-label { opacity: .7; font-weight: 600; }
    .cd-port-tag {
      display: inline-flex; align-items: center; gap: var(--cd-gap-micro);
      padding: var(--cd-gap-micro) var(--cd-gap-xs-plus);
      background: var(--cd-green-subtle); border: 1px solid var(--cd-green-border);
      border-radius: var(--cd-radius-pill); font-size: 0.85em; font-weight: 600;
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .cd-port-rm {
      border: none; background: transparent; color: inherit; opacity: .6;
      cursor: pointer; padding: 0 var(--cd-gap-micro); line-height: 1; font-size: 1.1em;
    }
    .cd-port-rm:hover { opacity: 1; }
    .cd-port-input {
      width: 52px; padding: var(--cd-gap-micro) var(--cd-gap-xs);
      background: transparent; border: 1px solid var(--cd-border-light);
      border-radius: var(--cd-radius-sm); color: inherit; font: inherit; font-size: 0.85em;
      text-align: center;
    }
    .cd-port-input::placeholder { opacity: .4; }
    .cd-port-hook { opacity: .35; font-size: 0.8em; font-style: italic; white-space: nowrap; }
    .cd-ws-image-input {
      width: 260px; max-width: 100%; padding: var(--cd-gap-micro) var(--cd-gap-xs);
      background: transparent; border: 1px solid var(--cd-border-light);
      border-radius: var(--cd-radius-sm); color: inherit; font: inherit; font-size: 0.85em;
    }
    .cd-ws-image-input:disabled { opacity: .35; }
    .cd-ws-image-input::placeholder { opacity: .4; }
    .cd-ws-chk-orange { opacity: 1; color: var(--cd-orange); }  .cd-ws-chk-orange input { accent-color: var(--cd-orange); }
    .cd-ws-chk-red    { opacity: 1; color: var(--cd-red); }  .cd-ws-chk-red    input { accent-color: var(--cd-red); }

    .cd-ws-runtime {
      display: grid;
      grid-template-columns: auto auto auto auto;
      align-content: center;
      gap: var(--cd-gap-micro) var(--cd-gap-xs-plus);
      padding: var(--cd-gap-xs) var(--cd-gap-sm);
      border: 1px solid var(--cd-green-border);
      border-radius: var(--cd-radius);
      font-weight: 600;
      background: var(--cd-green-subtle);
      white-space: nowrap;
      flex-shrink: 1;
    }
    .cd-ws-rt-name { opacity: .9; }
    .cd-ws-rt-value { text-align: right; font-variant-numeric: tabular-nums; }
    .cd-ws-rt-sep { padding-left: var(--cd-gap-sm); border-left: 1px solid var(--cd-border-light); }

    .cd-ws-meters { display: flex; flex-direction: row; gap: var(--cd-gap-sm); flex-shrink: 0; }
    .cd-ws-meters-row { display: flex; flex-direction: column; gap: var(--cd-gap-micro); }
    .cd-ws-usage-item { display: grid; grid-template-columns: 4ch 60px auto; align-items: center; gap: var(--cd-gap-xs); white-space: nowrap; }
    .cd-ws-usage-label { font-weight: 700; opacity: .7; text-transform: uppercase; }
    .cd-ws-usage-bar {
      width: 60px;
      height: var(--cd-bar-height);
      border-radius: var(--cd-radius-pill);
      overflow: hidden;
      background: linear-gradient(90deg, var(--cd-green) 0%, var(--cd-green) 60%, var(--cd-yellow) 80%, var(--cd-red) 100%);
      position: relative;
    }
    .cd-ws-usage-fill {
      position: absolute;
      top: 0; right: 0; bottom: 0;
      background: var(--cd-overlay);
      transition: width .2s ease;
    }
    .cd-ws-usage-val { opacity: var(--cd-opacity-muted); min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }

    .cd-ws-body { display: flex; flex-direction: column; min-height: 0; min-width: 0; width: 100%; flex: 1; }

    .cd-subtabs {
      display: flex;
      gap: var(--cd-gap-micro);
      align-items: stretch;
      flex-wrap: nowrap;
      margin: 0;
      padding: 0;
      border-bottom: 1px solid var(--cd-border-light);
      overflow-x: auto;
      overflow-y: hidden;
    }
    .cd-subtab {
      display: inline-flex;
      align-items: center;
      gap: var(--cd-gap-sm);
      padding: var(--cd-gap-xs-plus) var(--cd-gap-md);
      border-bottom: 2px solid transparent;
      background: transparent;
      cursor: pointer;
      user-select: none;
      max-width: 280px;
      margin-bottom: -1px;
      opacity: var(--cd-opacity-dim);
      transition: opacity .15s;
    }
    .cd-subtab { background: var(--cd-green-tab); }
    .cd-subtab:hover { opacity: .85; background: var(--cd-green-hover); }
    .cd-subtab.active {
      opacity: 1;
      background: var(--cd-green-active);
      border-bottom-color: var(--cd-green);
    }
    .cd-subtab-info { display: flex; flex-direction: column; min-width: 0; }
    .cd-subtab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cd-subtab-close {
      border: none;
      background: transparent;
      color: inherit;
      opacity: .75;
      padding: var(--cd-gap-xs) var(--cd-gap-xs-plus);
      line-height: 1;
      font-size: 18px;
      cursor: pointer;
    }
    .cd-subtab-close:hover { opacity: 1; }
    .cd-subtab-runtime { font-size: 0.8em; opacity: var(--cd-opacity-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }

    .cd-terminal-host { position: relative; flex: 1; min-height: 0; min-width: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 0; margin: 0; }
    .cd-terminal-host.cd-terminal-active { background: var(--cd-terminal-bg); }
    :host ::ng-deep .cd-terminal-host > * { width: 100%; min-width: 0; flex: 1 1 auto; }
    :host ::ng-deep .cd-terminal-host .content { padding: 0 !important; margin: 0 !important; }
    :host ::ng-deep .cd-terminal-host .tab-content { padding: 0 !important; margin: 0 !important; }
    :host ::ng-deep .cd-terminal-host terminal-toolbar { display: none !important; }
    :host ::ng-deep .cd-terminal-host > :first-child { padding: 0 !important; margin: 0 !important; }
    :host ::ng-deep .cd-terminal-host .xterm { padding: 6px 0 0 10px; }

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
  private zone: NgZone
  private hostRef: ElementRef
  private logger: Logger

  terminals: InternalTerminalSubTab[] = []
  activeTerminalId: string | null = null
  usage: UsageSummary | null = null
  wsStats: { cpu: number, mem: number, count: number } = { cpu: 0, mem: 0, count: 0 }
  resumeOptions: ResumeCandidate[] = []
  selectedResumeSessionId = ''
  branches: string[] = []
  currentBranch = ''
  private lastResumeDebugSig = ''
  private promptCache = new Map<string, string>()
  private lastProjectDirMtimeMs = 0
  private cdQueued = false

  /** Coalesce detectChanges via rAF: max 1 render per animation frame. */
  private scheduleCD (): void {
    if (this.cdQueued || !this.viewReady) return
    this.cdQueued = true
    requestAnimationFrame(() => {
      this.cdQueued = false
      if (!this.viewReady) return
      try { this.cdr.detectChanges() } catch { }
    })
  }

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
    this.zone = injector.get(NgZone)
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
    this.zone.runOutsideAngular(() => {
      this.subscribeUntilDestroyed(this.cfg.changed$, () => {
        clearTimeout(loadTimer)
        loadTimer = setTimeout(() => this.loadWorkspace(), 300)
      })
      this.subscribeUntilDestroyed(this.events.sessions$, () => {
        this.refreshResumeOptions().catch(() => null)
        this.saveTerminalState()
        this.recomputeWsStats()
        this.scheduleCD()
      })
      this.subscribeUntilDestroyed(this.usageSvc.summary$, (s: UsageSummary | null) => {
        this.usage = s
        this.scheduleCD()
      })
      this.subscribeUntilDestroyed(this.runtimeSvc.stats$, () => {
        this.recomputeWsStats()
        this.scheduleCD()
      })
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
    this.refreshResumeOptions().catch(() => null)
    this.refreshBranches()
    this.scheduleCD()
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

  get defaultDockerImage (): string {
    return (this.cfg as any).store?.claudeDock?.defaultDockerImage || 'ghcr.io/troshab/claude-dock:1.0.0'
  }

  get workspaceDockerImage (): string {
    return this.workspace?.dockerImage || ''
  }

  /** Effective image: workspace override or global default. */
  get effectiveDockerImage (): string {
    return this.workspaceDockerImage || this.defaultDockerImage
  }

  onDockerImageChanged (value: string): void {
    const trimmed = (value ?? '').trim()
    this.workspaces.updateWorkspace(this.workspaceId, { dockerImage: trimmed || undefined })
    this.loadWorkspace()
  }

  get forwardPorts (): number[] {
    return this.workspace?.forwardPorts ?? []
  }

  addPortFromInput (event: Event): void {
    const input = event.target as HTMLInputElement
    const raw = (input.value ?? '').trim()
    if (!raw) return
    const port = parseInt(raw, 10)
    if (!Number.isFinite(port) || port < 1 || port > 65535) return
    input.value = ''
    const current = this.forwardPorts
    if (current.includes(port)) return
    this.workspaces.updateWorkspace(this.workspaceId, { forwardPorts: [...current, port].sort((a, b) => a - b) })
    this.loadWorkspace()
  }

  removePort (port: number): void {
    const next = this.forwardPorts.filter(p => p !== port)
    this.workspaces.updateWorkspace(this.workspaceId, { forwardPorts: next })
    this.loadWorkspace()
  }

  get sandboxChkColor (): string {
    if (!this.useDockerSandbox) return ''
    if (!this.skipPermissions) return 'cd-ws-chk-green'
    return 'cd-ws-chk-yellow'
  }

  get mountChkColor (): string {
    if (!this.mountClaudeDir) return ''
    if (!this.skipPermissions) return 'cd-ws-chk-yellow'
    return 'cd-ws-chk-orange'
  }

  get permsChkColor (): string {
    if (!this.skipPermissions) return ''
    if (!this.useDockerSandbox) return 'cd-ws-chk-red'
    if (!this.mountClaudeDir) return 'cd-ws-chk-orange'
    return 'cd-ws-chk-red'
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
    childProcess.execFile('git', ['branch', '--no-color'], { cwd: nativePath(cwd), encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
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
      this.scheduleCD()
    })
  }

  switchBranch (name: string): void {
    const cwd = this.workspace?.cwd
    if (!cwd || !name) return
    const prev = this.currentBranch
    childProcess.execFile('git', ['checkout', name], { cwd: nativePath(cwd), encoding: 'utf8', timeout: 10000 }, (err, _stdout, stderr) => {
      if (err) {
        const stderrStr = String(stderr ?? '').trim()
        const full = stderrStr || String(err?.message ?? err)
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
    })
  }

  // --- Launch command builder ---

  /** Convert Windows path to POSIX format for use inside Docker container.
   *  C:\Users\tro\project -> /c/Users/tro/project */
  private toPosixCwd (cwd: string): string {
    const m = cwd.match(/^([A-Za-z]):[\\\/](.*)$/)
    if (m) return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
    return cwd.replace(/\\/g, '/')
  }

  private async buildLaunchCommand (claudeArgs: string[]): Promise<{ resolved: ResolvedCommand, sandboxName?: string, terminalId?: string, hostProjectsPath?: string } | null> {
    const allArgs = [...claudeArgs, ...this.skipPermsArgs()]
    if (this.useDockerSandbox) {
      const projectName = path.basename(this.workspace?.cwd || 'sandbox')
        .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'sandbox'
      const mountFlag = this.mountClaudeDir ? 'm1' : 'm0'
      const sandboxName = `claude-dock-${projectName}-${mountFlag}-${this.terminals.length + 1}`

      const cwd = this.workspace?.cwd || ''
      const posixCwd = this.toPosixCwd(cwd)

      // Generate terminalId early so it can be passed into the container via -e.
      // The hook script needs CLAUDE_DOCK_SOURCE, CLAUDE_DOCK_TABBY_SESSION, and
      // CLAUDE_DOCK_TERMINAL_ID to identify sessions as "tabby" source — without
      // these, sessions are filtered out in trimAndPublish().
      const terminalId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

      // Use docker run (not docker sandbox run) for full control over mounts.
      // docker sandbox run creates destructive symlinks through bind mounts.
      const dockerArgs = ['run', '--rm', '-it', '--name', sandboxName,
        '--security-opt', 'no-new-privileges',
        '-v', `${cwd}:${posixCwd}`,
        '-w', posixCwd,
        '-e', `CLAUDE_DOCK_CWD=${posixCwd}`,
        '-e', 'CLAUDE_DOCK_SOURCE=tabby',
        '-e', `CLAUDE_DOCK_TABBY_SESSION=${this.debug.sessionId}`,
        '-e', `CLAUDE_DOCK_TERMINAL_ID=${terminalId}`,
      ]

      if (process.env.ANTHROPIC_API_KEY) {
        dockerArgs.push('-e', 'ANTHROPIC_API_KEY')
      }

      const ports = this.forwardPorts
      if (ports.length) {
        dockerArgs.push('-e', `CLAUDE_DOCK_FORWARD_PORTS=${ports.join(',')}`)
      }

      const home = os.homedir()
      if (this.mountClaudeDir) {
        // Full mount: includes projects, credentials, config.
        dockerArgs.push(
          '-v', `${path.join(home, '.claude')}:/home/agent/.claude`,
          '-v', `${path.join(home, '.claude.json')}:/home/agent/.claude.json`,
        )
      } else {
        // Minimal mount: temp dir for projects so we can read transcripts (todos) from the host.
        // Doesn't expose credentials or config, doesn't pollute host's ~/.claude/projects.
        const tmpProjects = path.join(os.tmpdir(), 'claude-dock', sandboxName, 'projects')
        try { fsSync.mkdirSync(tmpProjects, { recursive: true }) } catch {}
        dockerArgs.push('-v', `${tmpProjects}:/home/agent/.claude/projects`)
      }

      dockerArgs.push(this.effectiveDockerImage, 'claude', ...allArgs)

      const resolved = await resolveForPty('docker', dockerArgs)
      if (!resolved.found) {
        this.notifications.error("'docker' not found on PATH",
          'Install Docker Desktop and ensure docker is on your PATH.')
      }
      const hostProjectsPath = this.mountClaudeDir
        ? path.join(home, '.claude', 'projects')
        : path.join(os.tmpdir(), 'claude-dock', sandboxName, 'projects')
      return { resolved, sandboxName, terminalId, hostProjectsPath }
    }

    const resolved = await resolveForPty('claude', allArgs)
    if (!resolved.found) {
      this.notifications.error("'claude' not found on PATH",
        'Install Claude CLI: https://docs.anthropic.com/en/docs/claude-cli')
      return null
    }
    return { resolved }
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

  wsCpuLabel (): string {
    const { cpu, count } = this.wsStats
    if (!count) return '0%'
    return cpu < 10 ? `${cpu.toFixed(1)}%` : `${Math.round(cpu)}%`
  }

  wsRamLabel (): string {
    const { mem, count } = this.wsStats
    if (!count) return '0 MB'
    const mb = mem / (1024 * 1024)
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
  }

  private recomputeWsStats (): void {
    let cpu = 0, mem = 0, count = 0
    const sessions = this.events.sessions$.value ?? []
    for (const t of this.terminals) {
      let rt: import('../services/sessionRuntime.service').SessionRuntimeStat | null = null
      if (t.sandboxName) {
        rt = this.runtimeSvc.getContainerStat(t.sandboxName)
      } else {
        const s = sessions.find(x => x.terminalId === t.id)
        if (s?.hostPid) rt = this.runtimeSvc.getStat(s.hostPid)
      }
      if (!rt?.running) continue
      cpu += Number(rt.cpuPercent ?? 0)
      mem += Number(rt.memoryBytes ?? 0)
      count++
    }
    this.wsStats = { cpu, mem, count }
  }

  subtabRuntime (terminalId: string): string {
    const t = this.terminals.find(x => x.id === terminalId)
    if (!t) return ''
    let rt: import('../services/sessionRuntime.service').SessionRuntimeStat | null = null
    if (t.sandboxName) {
      rt = this.runtimeSvc.getContainerStat(t.sandboxName)
    } else {
      const sessions = this.events.sessions$.value ?? []
      const s = sessions.find(x => x.terminalId === terminalId)
      if (s?.hostPid) rt = this.runtimeSvc.getStat(s.hostPid)
    }
    if (!rt?.running) return ''
    const cpu = Number(rt.cpuPercent ?? 0)
    const mem = Number(rt.memoryBytes ?? 0)
    const cpuStr = cpu < 10 ? `${cpu.toFixed(1)}%` : `${Math.round(cpu)}%`
    const mb = mem / (1024 * 1024)
    const memStr = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
    return `CPU ${cpuStr} / RAM ${memStr}`
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
    } catch (e: any) {
      this.logger.warn('hideHost failed:', e?.message ?? e)
    }
  }

  private showHost (): void {
    try {
      const tabBody = this.hostRef.nativeElement.closest('tab-body')
      if (tabBody) tabBody.style.display = ''
      this.hostRef.nativeElement.style.display = ''
    } catch (e: any) {
      this.logger.warn('showHost failed:', e?.message ?? e)
    }
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
    } catch (e: any) {
      this.debug.log('workspace.terminal.unmount_prev_failed', { error: String(e?.message ?? e) })
    }

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
    // Prevent browser from interpreting space/keys as scroll/click inside the terminal host
    if (event.key === ' ') {
      event.preventDefault()
    }
    // Forward the keypress to the active terminal and refocus it
    const active = this.getActiveTerminal() as any
    if (active?.sendInput && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      active.sendInput(event.key)
    }
    this.focusTerminal()
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
    } catch (e: any) {
      this.debug.log('workspace.terminal.close_detach_failed', { terminal_id: id, error: String(e?.message ?? e) })
    }

    try {
      tab.destroy?.()
    } catch (e: any) {
      this.debug.log('workspace.terminal.destroy_failed', { terminal_id: id, error: String(e?.message ?? e) })
    }
    this.events.markEndedByTerminalId(id, 'workspace_terminal_closed')
    if (this.terminals[idx].sandboxName) {
      this.runtimeSvc.untrackContainer(this.terminals[idx].sandboxName!)
    }
    this.cleanupSandbox(this.terminals[idx].sandboxName)

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
    return nativePath(cwd).replace(/[:\\/\.]/g, '-')
  }

  private refreshingResumeOptions = false

  private async refreshResumeOptions (): Promise<void> {
    if (!this.workspace?.cwd) {
      if (this.resumeOptions.length) {
        this.resumeOptions = []
        this.selectedResumeSessionId = ''
        this.scheduleCD()
      }
      return
    }
    if (this.refreshingResumeOptions) return
    this.refreshingResumeOptions = true

    try {
      const dir = path.join(os.homedir(), '.claude', 'projects', this.projectDirName(this.workspace.cwd))
      let dirStat: fsSync.Stats
      try { dirStat = await fsSync.promises.stat(dir) } catch { return }
      if (!dirStat.isDirectory()) return

      // Skip rescan if directory hasn't changed.
      if (dirStat.mtimeMs === this.lastProjectDirMtimeMs && this.resumeOptions.length) {
        return
      }
      this.lastProjectDirMtimeMs = dirStat.mtimeMs

      // Scan transcript files, sorted by mtime descending.
      const entries = await fsSync.promises.readdir(dir)
      const files: Array<{ sessionId: string, filePath: string, mtimeMs: number }> = []
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue
        try {
          const fp = path.join(dir, entry)
          const st = await fsSync.promises.stat(fp)
          files.push({ sessionId: entry.slice(0, -6), filePath: fp, mtimeMs: st.mtimeMs })
        } catch { continue }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)

      const top50 = files.slice(0, 50)
      // Read first prompts in parallel for uncached entries.
      await Promise.all(top50.map(async (f) => {
        if (this.promptCache.has(f.sessionId)) return
        const prompt = await this.readFirstPrompt(f.filePath)
        this.promptCache.set(f.sessionId, prompt)
      }))

      const next: ResumeCandidate[] = top50.map(f => ({
        sessionId: f.sessionId,
        status: 'ended',
        lastEventTs: f.mtimeMs,
        firstPrompt: this.promptCache.get(f.sessionId) ?? '',
      }))

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

      this.scheduleCD()
    } finally {
      this.refreshingResumeOptions = false
    }
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

  private async readFirstPrompt (transcriptPath: string): Promise<string> {
    let fh: fsSync.promises.FileHandle | null = null
    try {
      fh = await fsSync.promises.open(transcriptPath, 'r')
      const buf = Buffer.alloc(16384)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const text = buf.toString('utf8', 0, bytesRead)
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
    } catch { } finally {
      await fh?.close()
    }
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
    const cwdNative = nativePath(cwd)
    let cwdExists = false
    try { await fsSync.promises.stat(cwdNative); cwdExists = true } catch { }
    if (cwd && !cwdExists) {
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
    launch?: { resolved?: { command?: string, args?: string[] }, sandboxName?: string, terminalId?: string, hostProjectsPath?: string } | null,
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
      // Docker containers get terminalId from buildLaunchCommand (already passed via -e).
      // Native terminals generate it here.
      const terminalId = launch?.terminalId || `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

      const baseEnv = { ...(profile?.options?.env ?? {}) }
      const env = cleanEnv(baseEnv, {
        COLORTERM: 'truecolor',
        CLAUDE_DOCK_TABBY_SESSION: this.debug.sessionId,
        CLAUDE_DOCK_TERMINAL_ID: terminalId,
      })

      const options: any = {
        ...(profile?.options ?? {}),
        cwd,
        env,
      }

      // Direct process launch: replace shell with Claude/Docker executable
      if (launch?.resolved?.command) {
        options.command = launch.resolved.command
        options.args = launch.resolved.args ?? []
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

      const entry: InternalTerminalSubTab = {
        id: terminalId,
        title,
        createdAt: Date.now(),
        tab,
        sandboxName: launch?.sandboxName,
      }
      if (launch?.sandboxName) {
        entry.virtualPid = this.runtimeSvc.trackContainer(launch.sandboxName, terminalId)
        if (launch.hostProjectsPath) {
          this.events.registerTerminalProjectsPath(terminalId, launch.hostProjectsPath)
        }
      }
      this.terminals.push(entry)
      this.syncTerminalRegistry()

      this.activeTerminalId = terminalId

      this.subscribeUntilDestroyed(tab.titleChange$, (newTitle: string) => {
        const t = this.terminals.find(x => x.id === terminalId)
        if (t && newTitle) {
          t.title = newTitle
          this.events.updateTitleByTerminalId(terminalId, newTitle)
          this.scheduleCD()
        }
      })

      this.subscribeUntilDestroyed(tab.destroyed$, () => {
        const idx = this.terminals.findIndex(x => x.id === terminalId)
        if (idx < 0) return
        this.events.markEndedByTerminalId(terminalId, 'process_exited')
        if (this.terminals[idx].sandboxName) {
          this.runtimeSvc.untrackContainer(this.terminals[idx].sandboxName!)
        }
        this.cleanupSandbox(this.terminals[idx].sandboxName)
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
    const launch = await this.buildLaunchCommand([])
    if (!launch) return
    await this.openWorkspaceTerminal(launch, 'new')
  }

  async continueClaude (): Promise<void> {
    this.debug.log('workspace.action.continue', {
      workspace_id: this.workspaceId,
      cwd: this.workspace?.cwd ?? null,
    })
    const launch = await this.buildLaunchCommand(['--continue'])
    if (!launch) return
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
    const launch = await this.buildLaunchCommand(['--resume', sid])
    if (!launch) return
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
        if (t.sandboxName) this.runtimeSvc.untrackContainer(t.sandboxName)
        this.cleanupSandbox(t.sandboxName)
        try { t.tab.removeFromContainer?.() } catch { }
        try { t.tab.destroy?.() } catch { }
      }
    } catch (e: any) {
      this.debug.log('workspace.destroy.cleanup_failed', { error: String(e?.message ?? e) })
    }
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

    this.debug.log('workspace.save_terminals', {
      workspace_id: this.workspaceId,
      saved_count: saved.length,
      sessions: saved.map(s => s.sessionId),
    })
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

    // Resume each saved session (async resolve, fire-and-forget per session)
    for (const s of saved) {
      const title = s.title || `resume-${s.sessionId.slice(0, 8)}`
      this.buildLaunchCommand(['--resume', s.sessionId]).then(launch => {
        if (launch) this.openWorkspaceTerminal(launch, title)
      }).catch(e => {
        this.debug.log('workspace.restore_terminals.failed', {
          session_id: s.sessionId,
          error: String(e?.message ?? e),
        })
      })
    }
  }

  private syncTerminalRegistry (): void {
    const id = this.workspaceId
    if (!id) {
      return
    }
    this.terminalRegistry.setWorkspaceCount(id, this.terminals.length)
  }

  /** Remove Docker container asynchronously. Fire-and-forget. */
  private cleanupSandbox (sandboxName?: string): void {
    if (!sandboxName) return
    this.debug.log('workspace.sandbox.cleanup', { sandbox_name: sandboxName })
    childProcess.execFile('docker', ['rm', '-f', sandboxName], { timeout: 15000 }, (err) => {
      if (err) {
        this.debug.log('workspace.sandbox.cleanup_failed', {
          sandbox_name: sandboxName,
          error: String(err?.message ?? err),
        })
      }
    })
  }
}
