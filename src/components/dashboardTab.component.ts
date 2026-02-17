import { ChangeDetectorRef, Component, Injector } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, NotificationsService } from 'tabby-core'
import * as childProcess from 'child_process'
import * as path from 'path'

import { ClaudeEventsService } from '../services/claudeEvents.service'
import { ClaudeCloseGuardService } from '../services/closeGuard.service'
import { ClaudeTodosService } from '../services/claudeTodos.service'
import { ClaudeUsageService } from '../services/claudeUsage.service'
import { ClaudeDockLifecycleService } from '../services/lifecycle.service'
import { HookHealthService, HookHealthStatus } from '../services/hookHealth.service'
import { SessionRuntimeService, SystemResourceStat } from '../services/sessionRuntime.service'
import { WorkspacesService } from '../services/workspaces.service'
import { ClaudeSession, ClaudeTodoStatus, GroupSortPreset, SessionGroup, SortPreset, UsageSummary, Workspace } from '../models'
import { displayPath, formatAge, normalizePath, pathBase, usageLabel, usagePct } from '../utils'
import { WorkspaceTabComponent } from './workspaceTab.component'

@Component({
  selector: 'claude-dock-dashboard-tab',
  template: `
    <ng-container *ngIf="hooksEnabled(); else hooksSetup">
      <header class="cd-header">
        <div class="cd-title">
          <h1 class="cd-title-main">Claude Dock</h1>
          <button class="btn btn-sm btn-outline-primary cd-open-folder" (click)="openWorkspaceFolder()">
            Open workspace
          </button>
        </div>

        <div class="cd-usage-mini" aria-label="5-hour usage window">
          <div class="cd-usage-mini-label">5H</div>
          <div class="cd-usage-mid">
            <div class="cd-usage-bar" role="meter" aria-label="5-hour usage" [attr.aria-valuenow]="usagePct(usage?.usage5h?.used)" aria-valuemin="0" aria-valuemax="100">
              <div class="cd-usage-mask" [style.width.%]="usageHiddenPct(usage?.usage5h?.used)"></div>
            </div>
            <div class="cd-usage-reset" *ngIf="usageResetLabel(usage?.usage5h)">{{ usageResetLabel(usage?.usage5h) }}</div>
          </div>
          <div class="cd-usage-mini-value">{{ usageLabel(usage?.usage5h) }}</div>
        </div>
        <div class="cd-usage-mini" aria-label="7-day usage window">
          <div class="cd-usage-mini-label">7D</div>
          <div class="cd-usage-mid">
            <div class="cd-usage-bar" role="meter" aria-label="7-day usage" [attr.aria-valuenow]="usagePct(usage?.usageWeek?.used)" aria-valuemin="0" aria-valuemax="100">
              <div class="cd-usage-mask" [style.width.%]="usageHiddenPct(usage?.usageWeek?.used)"></div>
            </div>
            <div class="cd-usage-reset" *ngIf="usageResetLabel(usage?.usageWeek)">{{ usageResetLabel(usage?.usageWeek) }}</div>
          </div>
          <div class="cd-usage-mini-value">{{ usageLabel(usage?.usageWeek) }}</div>
        </div>

        <div class="cd-runtime-head" role="region" aria-label="System resources">
          <span class="cd-runtime-name">CPU</span>
          <span class="cd-runtime-value">{{ systemCpuLabel() }}</span>
          <span class="cd-runtime-name cd-runtime-sep">RAM</span>
          <span class="cd-runtime-value">{{ systemRamLabel() }}</span>
          <span class="cd-runtime-sub">Claude</span>
          <span class="cd-runtime-claude-val">{{ totalCpuLabel() }}</span>
          <span class="cd-runtime-sub cd-runtime-sep">Claude</span>
          <span class="cd-runtime-claude-val">{{ totalRamLabel() }}</span>
        </div>

        <div class="cd-controls">
          <select class="form-control form-control-sm cd-select" aria-label="Sort workspaces" [value]="groupSortPreset" (change)="setGroupSortPreset($any($event.target).value)">
            <option value="none">Workspace: default</option>
            <option value="waiting">Workspace: waiting first</option>
            <option value="path">Workspace: by path</option>
          </select>

          <select class="form-control form-control-sm cd-select" aria-label="Sort sessions" [value]="sortPreset" (change)="setSortPreset($any($event.target).value)">
            <option value="status">Session: waiting first</option>
            <option value="startAsc">Session: oldest first</option>
            <option value="startDesc">Session: newest first</option>
            <option value="lastActivityDesc">Session: last active</option>
          </select>
        </div>

      </header>

      <main class="cd-grid">
        <div class="cd-col">
          <h2 class="cd-section-title">Workspaces</h2>

          <div *ngIf="!workspaces.length" class="cd-muted cd-empty">
            No recent workspaces yet.
          </div>

          <ul class="list-group cd-list" *ngIf="workspaces.length">
            <li
              class="list-group-item list-group-item-action cd-row cd-ws-item"
              *ngFor="let w of workspaces"
              (click)="openWorkspace(w.id)"
            >
              <div class="cd-workspace-path" [title]="normalizeCwd(w.cwd)">{{ normalizeCwd(w.cwd) }}</div>
              <button class="cd-ws-remove" title="Remove" aria-label="Remove workspace" (click)="removeWorkspace(w.id, $event)">&times;</button>
            </li>
          </ul>
        </div>

        <div class="cd-col">
          <h2 class="cd-section-title">
            Sessions
            <span class="cd-muted">({{ sessionsSorted.length }})</span>
          </h2>

          <div *ngIf="!sessionsSorted.length" class="cd-muted cd-empty">
            <div>No sessions yet.</div>
          </div>

        <div class="cd-groups-scroll">
          <details class="cd-group" *ngFor="let g of groupsSorted; trackBy: trackGroupKey" [attr.open]="isGroupOpen(g) ? '' : null" (toggle)="setGroupOpen(g, $event)">
            <summary class="cd-group-summary">
              <span class="cd-group-chevron"></span>
              <span class="cd-strong">{{ normalizeCwd(g.cwd) }}</span>
              <span class="cd-group-actions">
                <span class="badge cd-outline-warn" *ngIf="g.waitingCount">{{ g.waitingCount }} waiting</span>
                <span class="badge cd-outline-ok" *ngIf="g.workingCount">{{ g.workingCount }} working</span>
                <button
                  type="button"
                  class="btn btn-sm btn-success cd-group-new"
                  title="New terminal in workspace"
                  (click)="newTerminalInGroup(g, $event)"
                >
                  New
                </button>
              </span>
            </summary>

            <div class="list-group cd-list">
              <div
                class="list-group-item list-group-item-action cd-row"
                role="button" tabindex="0"
                *ngFor="let s of g.sessions"
                (click)="openWorkspaceForSession(s)"
                (keydown.enter)="openWorkspaceForSession(s)"
                (keydown.space)="openWorkspaceForSession(s); $event.preventDefault()"
              >
                <div class="cd-row-top">
                  <div class="cd-row-title">
                    <span class="cd-strong">{{ sessionLabel(s, true) }}</span>
                  </div>
                  <div class="cd-row-right">
                    <span class="badge" [class]="badgeClass(s.status)">{{ s.status }}</span>
                    <button
                      type="button"
                      class="btn btn-sm btn-danger text-dark cd-session-close"
                      [disabled]="!canCloseSession(s)"
                      (click)="closeSession(s, $event)"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <ul class="cd-todos" *ngIf="todosFor(s).length">
                  <li class="cd-todo" *ngFor="let t of todosFor(s)">
                    <span class="cd-todo-dot"
                          [class.pending]="!t.status || t.status === 'pending'"
                          [class.in-progress]="t.status === 'in_progress'"
                          [class.completed]="t.status === 'completed'"></span>
                    <span class="cd-todo-text" [class.done]="t.status === 'completed'">{{ t.content }}</span>
                  </li>
                </ul>

                <div class="cd-row-bottom">
                  <span class="cd-muted cd-small" *ngIf="s.lastToolName">tool: {{ s.lastToolName }}</span>
                  <span class="cd-muted cd-small" *ngIf="s.lastEventTs">last: {{ age(s.lastEventTs) }}</span>
                  <span class="cd-muted cd-small" *ngIf="s.waitingSinceTs && s.status === 'waiting'">waiting: {{ age(s.waitingSinceTs) }}</span>
                  <span class="cd-muted cd-small" *ngIf="runtimeLabel(s)">{{ runtimeLabel(s) }}</span>
                </div>
              </div>
            </div>
          </details>
        </div>
        </div>
      </main>
    </ng-container>

    <ng-template #hooksSetup>
      <section class="cd-setup" aria-label="Setup">
        <h1 class="cd-title-main">Claude Dock</h1>
        <p class="cd-setup-text">
          Install Claude hooks first to enable sessions and recent workspaces.
        </p>
        <button
          type="button"
          class="btn btn-sm btn-outline-success cd-install-btn"
          [disabled]="installRunning"
          (click)="runInstallHooks($event)"
          title="Install Claude hooks"
        >
          <i class="fas fa-download" aria-hidden="true"></i>
          <code>{{ installHooksCommand }}</code>
        </button>
        <div class="cd-muted cd-small cd-install-hint" *ngIf="installOutput">
          {{ installOutput }}
        </div>
      </section>
    </ng-template>
  `,
  styles: [`
    :host {
      display: flex; flex-direction: column; height: 100%; padding: 12px; overflow: hidden;
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
    }
    code { font-family: var(--cd-font-mono); }

    .cd-header { display: flex; gap: var(--cd-gap-sm); align-items: stretch; justify-content: flex-start; flex-wrap: wrap; margin-bottom: var(--cd-gap-md); width: 100%; }
    .cd-title { display: flex; flex-direction: column; line-height: 1.1; min-width: 0; align-items: center; justify-content: center; gap: var(--cd-gap-xs); }
    .cd-title-main { font-weight: 700; font-size: 1.15em; }
    .cd-open-folder { white-space: nowrap; }
.cd-usage-mini { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--cd-gap-micro) var(--cd-gap-xs); border: 1px solid var(--cd-border); border-radius: var(--cd-radius); padding: var(--cd-gap-xs) var(--cd-gap-xs-plus); }
    .cd-usage-mini-label { font-weight: 700; text-transform: uppercase; opacity: .8; }
    .cd-usage-mid { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cd-usage-bar {
      position: relative;
      height: var(--cd-bar-height);
      border-radius: var(--cd-radius-pill);
      overflow: hidden;
      background: linear-gradient(90deg, var(--cd-green) 0%, var(--cd-green) 60%, var(--cd-yellow) 80%, var(--cd-red) 100%);
    }
    .cd-usage-mask {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 100%;
      background: var(--cd-overlay);
      transition: width .2s ease;
    }
    .cd-usage-mini-value { opacity: var(--cd-opacity-muted); text-align: right; white-space: nowrap; }
    .cd-usage-reset { font-size: 0.8em; opacity: var(--cd-opacity-dim); white-space: nowrap; }
    .cd-runtime-head {
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
    .cd-runtime-name { opacity: .9; }
    .cd-runtime-sub { opacity: var(--cd-opacity-dim); font-size: 0.85em; font-weight: 500; }
    .cd-runtime-claude-val { opacity: var(--cd-opacity-muted); font-size: 0.85em; text-align: right; }
    .cd-runtime-value { text-align: right; font-variant-numeric: tabular-nums; }
    .cd-runtime-sep { padding-left: var(--cd-gap-sm); border-left: 1px solid var(--cd-border-light); }
    .cd-controls { display: flex; flex-direction: column; gap: var(--cd-gap-xs); align-items: flex-start; justify-content: center; }
    .cd-select { width: auto; max-width: 100%; min-width: 0; }

    .cd-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 3fr); gap: var(--cd-gap-md); flex: 1; min-height: 0; width: 100%; }
    .cd-col { display: flex; flex-direction: column; min-height: 0; }
    .cd-section-title { flex-shrink: 0; }
    .cd-empty { flex-shrink: 0; }

    h1.cd-title-main { font-size: 1.15em; margin: 0; }
    h2.cd-section-title { font-size: 1em; margin: 0 0 var(--cd-gap-sm) 0; }
    .cd-section-title { font-weight: 700; margin-bottom: var(--cd-gap-sm); }
    .cd-groups-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: var(--cd-gap-sm); }

    .cd-list { border-radius: var(--cd-radius); overflow-y: auto; list-style: none; padding-left: 0; padding-right: var(--cd-gap-sm); margin: 0; flex: 1; min-height: 0; }
    .cd-row { display: block; text-align: left; }
    .cd-row[role="button"] { cursor: pointer; }
    .cd-row-top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--cd-gap-md); }
    .cd-row-title { display: flex; gap: var(--cd-gap-sm); align-items: baseline; flex-wrap: wrap; }
    .cd-row-right { display: inline-flex; align-items: center; gap: var(--cd-gap-sm); }
    .cd-session-close { padding: var(--cd-gap-micro) 10px; line-height: 1.4; border-radius: var(--cd-radius-sm); font-size: 0.8em; }
    .cd-row-bottom { display: flex; gap: var(--cd-gap-md); margin-top: var(--cd-gap-xs); padding-top: var(--cd-gap-xs); border-top: 1px solid var(--cd-border); flex-wrap: wrap; }
    .cd-workspace-path {
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
      unicode-bidi: plaintext;
      opacity: .85;
    }

    .cd-outline-warn { border: 1px solid var(--cd-yellow); color: var(--cd-yellow); background: transparent; }
    .cd-outline-ok { border: 1px solid var(--cd-green); color: var(--cd-green); background: transparent; }
    .cd-ws-item { display: flex !important; align-items: center; gap: var(--cd-gap-sm); cursor: pointer; }
    .cd-ws-remove {
      border: none;
      background: transparent;
      color: inherit;
      opacity: .5;
      padding: var(--cd-gap-xs) var(--cd-gap-sm);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      min-height: var(--cd-click-min);
    }
    .cd-ws-remove:hover { opacity: 1; color: var(--cd-red); }
    .cd-strong { font-weight: 700; }
    .cd-muted { opacity: .7; }
    .cd-small { font-size: 0.85em; }
    .cd-empty { padding: var(--cd-gap-sm) var(--cd-gap-xs); }
    .cd-setup {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 10px;
      padding: 18px;
    }
    .cd-setup-text {
      opacity: .9;
    }
    .cd-install-btn {
      margin-top: var(--cd-gap-sm);
      display: inline-flex;
      align-items: center;
      gap: var(--cd-gap-sm);
      font-size: 1.05em;
      font-weight: 700;
      padding: var(--cd-gap-sm) var(--cd-gap-md);
      border-width: 2px;
    }
    .cd-install-btn code {
      font-weight: 700;
    }
    .cd-install-hint {
      margin-top: var(--cd-gap-xs-plus);
    }

    .cd-group { border: 1px solid var(--cd-border); border-radius: var(--cd-radius); padding: var(--cd-gap-sm); margin-bottom: var(--cd-gap-sm); }
    .cd-group summary { list-style: none; }
    .cd-group summary::-webkit-details-marker { display: none; }
    .cd-group-summary { display: flex; gap: var(--cd-gap-sm); align-items: center; cursor: pointer; margin-bottom: 0; padding: var(--cd-gap-xs) var(--cd-gap-xs-plus); }
    .cd-group[open] > .cd-group-summary { margin-bottom: var(--cd-gap-xs-plus); }
    .cd-group-chevron { display: inline-block; width: 0; height: 0; border-style: solid; border-width: 5px 0 5px 7px; border-color: transparent transparent transparent currentColor; opacity: .6; transition: transform .15s ease; flex-shrink: 0; margin-left: var(--cd-gap-micro); margin-right: var(--cd-gap-micro); }
    .cd-group[open] > .cd-group-summary > .cd-group-chevron { transform: rotate(90deg); }
    .cd-group-actions { margin-left: auto; display: inline-flex; align-items: center; gap: var(--cd-gap-sm); }
    .cd-group-new { padding: var(--cd-gap-micro) 10px; line-height: 1.4; border-radius: var(--cd-radius-sm); font-size: 0.8em; }

    .cd-todos { margin: var(--cd-gap-xs) 0 0 0; padding-top: var(--cd-gap-sm); border-top: 1px solid var(--cd-border); display: flex; flex-direction: column; gap: var(--cd-gap-micro); list-style: none; padding-left: 0; }
    p.cd-setup-text { margin: 0; }
    .cd-todo { display: flex; gap: var(--cd-gap-sm); align-items: flex-start; }
    .cd-todo-dot {
      width: var(--cd-gap-sm);
      height: var(--cd-gap-sm);
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: var(--cd-gap-xs);
      border: 1.5px solid var(--cd-green);
      background: transparent;
      opacity: var(--cd-opacity-dim);
    }
    .cd-todo-dot.in-progress {
      background: var(--cd-green);
      border-color: var(--cd-green);
      opacity: 1;
    }
    .cd-todo-dot.completed {
      opacity: 0.35;
    }
    .cd-todo-text.done { text-decoration: line-through; opacity: var(--cd-opacity-dim); }
  `],
})
export class DashboardTabComponent extends BaseTabComponent {
  private app: AppService
  private cfg: ConfigService
  private notifications: NotificationsService
  private cdr: ChangeDetectorRef
  private lifecycle: ClaudeDockLifecycleService
  private closeGuard: ClaudeCloseGuardService

  private events: ClaudeEventsService
  private todosSvc: ClaudeTodosService
  private usageSvc: ClaudeUsageService
  private hookHealthSvc: HookHealthService
  private runtimeSvc: SessionRuntimeService
  private workspacesSvc: WorkspacesService

  sortPreset: SortPreset
  groupSortPreset: GroupSortPreset

  sessionsSorted: ClaudeSession[] = []
  groupsSorted: SessionGroup[] = []

  workspaces: Workspace[] = []
  usage: UsageSummary | null = null
  hookHealth: HookHealthStatus | null = null
  runtimeStats: Record<number, any> = {}
  systemStats: SystemResourceStat | null = null
  readonly installHooksCommand = 'node scripts/install.js'
  installRunning = false
  installOutput = ''
  private groupOpenState: Record<string, boolean> = {}
  private viewReady = false

  constructor (injector: Injector) {
    super(injector)
    this.app = injector.get(AppService)
    this.cfg = injector.get(ConfigService)
    this.notifications = injector.get(NotificationsService)
    this.cdr = injector.get(ChangeDetectorRef)
    this.lifecycle = injector.get(ClaudeDockLifecycleService)
    this.closeGuard = injector.get(ClaudeCloseGuardService)

    this.events = injector.get(ClaudeEventsService)
    this.todosSvc = injector.get(ClaudeTodosService)
    this.usageSvc = injector.get(ClaudeUsageService)
    this.hookHealthSvc = injector.get(HookHealthService)
    this.runtimeSvc = injector.get(SessionRuntimeService)
    this.workspacesSvc = injector.get(WorkspacesService)

    this.setTitle('Claude Code')
    this.icon = 'fas fa-table'
    // Prevent user from renaming this tab via Tabby's rename-tab dialog.
    Object.defineProperty(this, 'customTitle', { get: () => '', set: () => {} })

    // ConfigService.store may be undefined very early during startup.
    this.sortPreset = ((this.cfg as any).store?.claudeDock?.sortPreset ?? 'status') as SortPreset
    this.groupSortPreset = ((this.cfg as any).store?.claudeDock?.groupSortPreset ?? 'waiting') as GroupSortPreset

    this.subscribeUntilDestroyed(this.events.sessions$, () => this.recompute())
    this.subscribeUntilDestroyed(this.cfg.changed$, () => this.onConfigChanged())
    this.subscribeUntilDestroyed(this.todosSvc.todosChanged$, () => this.detectChanges())
    this.subscribeUntilDestroyed(this.usageSvc.summary$, (s: UsageSummary | null) => {
      this.usage = s
      this.detectChanges()
    })
    this.subscribeUntilDestroyed(this.hookHealthSvc.status$, (s: HookHealthStatus) => {
      this.hookHealth = s
      this.detectChanges()
    })
    this.subscribeUntilDestroyed(this.focused$, () => {
      this.hookHealthSvc.checkNow()
    })
    this.subscribeUntilDestroyed(this.runtimeSvc.stats$, (s: Record<number, any>) => {
      this.runtimeStats = s ?? {}
      this.recompute()
    })
    this.subscribeUntilDestroyed(this.runtimeSvc.system$, (s: SystemResourceStat | null) => {
      this.systemStats = s
      this.detectChanges()
    })

    this.hookHealthSvc.checkNow()
    this.refreshWorkspaces()
    this.recompute()
  }

  ngAfterViewInit (): void {
    this.viewReady = true
    this.recompute()
  }

  async canClose (): Promise<boolean> {
    if (this.lifecycle.closing) {
      return this.closeGuard.confirmWindowClose()
    }
    if (!(this.cfg as any).store?.claudeDock?.dashboardPinned) {
      return true
    }
    return false
  }

  private onConfigChanged (): void {
    const nextSort = ((this.cfg as any).store?.claudeDock?.sortPreset ?? this.sortPreset) as SortPreset
    const nextGroupSort = ((this.cfg as any).store?.claudeDock?.groupSortPreset ?? this.groupSortPreset) as GroupSortPreset
    const changed = nextSort !== this.sortPreset || nextGroupSort !== this.groupSortPreset
    this.sortPreset = nextSort
    this.groupSortPreset = nextGroupSort
    if (changed) {
      this.recompute()
    }
    this.refreshWorkspaces()
  }

  private refreshWorkspaces (): void {
    this.workspaces = this.workspacesSvc.list()
    this.detectChanges()
  }

  setSortPreset (preset: SortPreset): void {
    this.sortPreset = preset
    const store = (this.cfg as any).store
    if (!store) return
    store.claudeDock ??= {}
    store.claudeDock.sortPreset = preset
    this.cfg.save()
    this.recompute()
  }

  setGroupSortPreset (preset: GroupSortPreset): void {
    this.groupSortPreset = preset
    const store = (this.cfg as any).store
    if (!store) return
    store.claudeDock ??= {}
    store.claudeDock.groupSortPreset = preset
    this.cfg.save()
    this.recompute()
  }

  todoMark (status?: ClaudeTodoStatus | null): string {
    switch (status) {
      case 'completed': return '[x]'
      case 'in_progress': return '[>]'
      default: return '[ ]'
    }
  }

  usagePct (v?: number | null): number {
    return usagePct(v)
  }

  usageHiddenPct (v?: number | null): number {
    return 100 - usagePct(v)
  }

  usageLabel (bucket?: { used: number, limit: number } | null): string {
    return usageLabel(bucket)
  }

  usageResetLabel (bucket?: { used: number, limit: number, resetsAt?: string | null } | null): string {
    if (!bucket?.resetsAt) return ''
    try {
      const d = new Date(bucket.resetsAt)
      if (isNaN(d.getTime())) return ''
      const now = Date.now()
      const diff = d.getTime() - now
      const dd = String(d.getDate()).padStart(2, '0')
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const hh = String(d.getHours()).padStart(2, '0')
      const min = String(d.getMinutes()).padStart(2, '0')
      const at = `at ${dd}.${mm} ${hh}:${min}`
      if (diff <= 0) return `resets soon ${at}`
      const m = Math.floor(diff / 60_000)
      if (m < 60) return `resets in ${m}m ${at}`
      const h = Math.floor(m / 60)
      const rm = m % 60
      const rel = h < 24
        ? (rm > 0 ? `${h}h ${rm}m` : `${h}h`)
        : (h % 24 > 0 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`)
      return `resets in ${rel} ${at}`
    } catch {
      return ''
    }
  }

  private groupKey (g: SessionGroup): string {
    return normalizePath(g.cwd || g.projectName || 'unknown')
  }

  trackGroupKey = (_: number, g: SessionGroup): string => {
    return this.groupKey(g)
  }

  isGroupOpen (g: SessionGroup): boolean {
    const key = this.groupKey(g)
    return this.groupOpenState[key] ?? true
  }

  setGroupOpen (g: SessionGroup, event: any): void {
    const key = this.groupKey(g)
    const open = !!event?.target?.open
    if (this.groupOpenState[key] === open) return
    this.groupOpenState[key] = open
  }

  age (ts?: number): string {
    return formatAge(ts)
  }

  todosFor (s: ClaudeSession) {
    return this.todosSvc.getTodosForTranscript(s.transcriptPath)
  }

  sessionLabel (s: ClaudeSession, grouped = false): string {
    if (grouped) {
      return s.title || (s.sessionId ? s.sessionId.slice(0, 8) : '') || 'Claude Code'
    }
    const cwd = s.cwd ? displayPath(s.cwd) : ''
    return s.title || cwd || 'Claude Code'
  }

  normalizeCwd (cwd: string): string {
    return displayPath(cwd)
  }

  badgeClass (status: string): string {
    switch (status) {
      case 'waiting': return 'cd-outline-warn'
      case 'working': return 'cd-outline-ok'
      default: return 'bg-secondary'
    }
  }

  private runtimeFor (s: ClaudeSession): any | null {
    const pid = Number(s.hostPid)
    if (!Number.isFinite(pid) || pid <= 0) {
      return null
    }
    return this.runtimeStats[pid] ?? null
  }

  private formatCPU (v?: number | null): string {
    const n = Number(v ?? 0)
    if (!Number.isFinite(n) || n <= 0) return '0%'
    if (n < 10) return `${n.toFixed(1)}%`
    return `${Math.round(n)}%`
  }

  private formatRAM (bytes?: number | null): string {
    const b = Number(bytes ?? 0)
    if (!Number.isFinite(b) || b <= 0) return '0 MB'
    const mb = b / (1024 * 1024)
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`
    }
    return `${Math.round(mb)} MB`
  }

  runtimeLabel (s: ClaudeSession): string {
    const rt = this.runtimeFor(s)
    if (!rt || !rt.running) {
      return ''
    }
    return `cpu: ${this.formatCPU(rt.cpuPercent)} ram: ${this.formatRAM(rt.memoryBytes)}`
  }

  canCloseSession (s: ClaudeSession): boolean {
    return true
  }

  private visibleRuntimeSessions (): ClaudeSession[] {
    // Visibility is driven by hook events (source/status/TTL), not runtime stats.
    // Runtime stats are best-effort and should not hide active sessions.
    return this.events.sessions$.value ?? []
  }

  systemCpuLabel (): string {
    if (!this.systemStats) return '--'
    return this.formatCPU(this.systemStats.cpuLoadPercent)
  }

  systemRamLabel (): string {
    if (!this.systemStats) return '--'
    const usedBytes = this.systemStats.totalMemoryBytes - this.systemStats.freeMemoryBytes
    const totalGB = this.systemStats.totalMemoryBytes / (1024 * 1024 * 1024)
    const usedGB = usedBytes / (1024 * 1024 * 1024)
    return `${usedGB.toFixed(1)} / ${totalGB.toFixed(0)} GB`
  }

  totalCpuLabel (): string {
    const total = this.visibleRuntimeSessions().reduce((acc, s) => {
      const rt = this.runtimeFor(s)
      if (!rt?.running) return acc
      return acc + (Number(rt.cpuPercent ?? 0) || 0)
    }, 0)
    return this.formatCPU(total)
  }

  totalRamLabel (): string {
    const total = this.visibleRuntimeSessions().reduce((acc, s) => {
      const rt = this.runtimeFor(s)
      if (!rt?.running) return acc
      return acc + (Number(rt.memoryBytes ?? 0) || 0)
    }, 0)
    return this.formatRAM(total)
  }

  hooksEnabled (): boolean {
    return !!this.hookHealth?.ok
  }

  async closeSession (s: ClaudeSession, event?: Event): Promise<void> {
    event?.preventDefault?.()
    event?.stopPropagation?.()

    const pid = Number(s.hostPid)
    if (Number.isFinite(pid) && pid > 0) {
      const ok = await this.runtimeSvc.killByPid(pid)
      if (!ok) {
        this.notifications.error('Could not close session process', `pid ${pid}`)
      }
    }

    if (s.sessionId) {
      this.events.markEndedBySessionId(s.sessionId, 'closed_from_dashboard')
    } else if (s.terminalId) {
      this.events.markEndedByTerminalId(s.terminalId, 'closed_from_dashboard')
    } else if (Number.isFinite(pid) && pid > 0) {
      this.events.markEndedByHostPid(pid, 'closed_from_dashboard')
    }
    this.recompute()
  }

  private sortSessions (sessions: ClaudeSession[]): ClaudeSession[] {
    const byStart = (a: ClaudeSession, b: ClaudeSession) => (a.startTs ?? 0) - (b.startTs ?? 0)
    const byLast = (a: ClaudeSession, b: ClaudeSession) => (b.lastEventTs ?? 0) - (a.lastEventTs ?? 0)

    if (this.sortPreset === 'startAsc') {
      return [...sessions].sort(byStart)
    }
    if (this.sortPreset === 'startDesc') {
      return [...sessions].sort((a, b) => -byStart(a, b))
    }
    if (this.sortPreset === 'lastActivityDesc') {
      return [...sessions].sort(byLast)
    }

    // Default: status sort.
    const rank = (s: ClaudeSession) => s.status === 'waiting' ? 0 : s.status === 'working' ? 1 : 2
    return [...sessions].sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb

      // Waiting: oldest waiting first.
      if (ra === 0) {
        const wa = a.waitingSinceTs ?? a.lastEventTs ?? 0
        const wb = b.waitingSinceTs ?? b.lastEventTs ?? 0
        if (wa !== wb) return wa - wb
      }

      // Working: most recent tool usage first.
      if (ra === 1) {
        const ta = a.lastToolTs ?? a.lastEventTs ?? 0
        const tb = b.lastToolTs ?? b.lastEventTs ?? 0
        if (ta !== tb) return tb - ta
      }

      // Fallback: last activity.
      return byLast(a, b)
    })
  }

  private buildGroups (sessions: ClaudeSession[]): SessionGroup[] {
    const groups = new Map<string, SessionGroup>()
    for (const s of sessions) {
      const cwd = s.cwd ?? ''
      const key = normalizePath(cwd)
      if (!groups.has(key)) {
        groups.set(key, {
          cwd,
          projectName: pathBase(cwd) || cwd || 'Unknown',
          sessions: [],
          waitingCount: 0,
          workingCount: 0,
        })
      }
      const g = groups.get(key)!
      g.sessions.push(s)
      if (s.status === 'working') {
        g.workingCount += 1
      }
      if (s.status === 'waiting') {
        g.waitingCount += 1
        if (s.waitingSinceTs) {
          g.oldestWaitingTs = Math.min(g.oldestWaitingTs ?? Infinity, s.waitingSinceTs)
          if (!Number.isFinite(g.oldestWaitingTs!)) {
            g.oldestWaitingTs = s.waitingSinceTs
          }
        }
      }
      if (s.lastEventTs) {
        g.lastActivityTs = Math.max(g.lastActivityTs ?? 0, s.lastEventTs)
      }
    }

    const list = [...groups.values()]
    for (const g of list) {
      g.sessions = this.sortSessions(g.sessions)
    }

    if (this.groupSortPreset === 'none') {
      return list
    }

    if (this.groupSortPreset === 'path') {
      list.sort((a, b) => normalizePath(a.cwd).localeCompare(normalizePath(b.cwd)))
      return list
    }

    // Default group sort: waiting first (oldest waiting), then last activity.
    list.sort((a, b) => {
      const aw = a.waitingCount > 0 ? 0 : 1
      const bw = b.waitingCount > 0 ? 0 : 1
      if (aw !== bw) return aw - bw
      if (aw === 0) {
        const oa = a.oldestWaitingTs ?? 0
        const ob = b.oldestWaitingTs ?? 0
        if (oa !== ob) return oa - ob
      }
      return (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0)
    })
    return list
  }

  private recompute (): void {
    const sessions = this.visibleRuntimeSessions()
    this.sessionsSorted = this.sortSessions(sessions)
    this.groupsSorted = this.buildGroups(this.sessionsSorted)
    this.detectChanges()
  }

  private detectChanges (): void {
    if (!this.viewReady) return
    try {
      // Tabby uses default change detection, but file polling events arrive outside user actions.
      this.cdr.detectChanges()
    } catch { }
  }

  async openWorkspaceFolder (): Promise<void> {
    const ws = await this.workspacesSvc.openFromFolderPicker()
    if (!ws) {
      return
    }
    this.refreshWorkspaces()
    this.openWorkspace(ws.id)
  }

  async createWorkspace (): Promise<void> {
    const ws = await this.workspacesSvc.createInteractive()
    if (!ws) {
      return
    }
    this.refreshWorkspaces()
    this.openWorkspace(ws.id)
  }

  async openWorkspaceSelector (): Promise<void> {
    const ws = await this.workspacesSvc.pickWorkspace()
    if (ws) {
      this.openWorkspace(ws.id)
    }
  }

  async runInstallHooks (event?: Event): Promise<void> {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (this.installRunning) return

    // Plugin root: dist/components/ → ../../
    const pluginRoot = path.resolve(__dirname, '..', '..')
    this.installRunning = true
    this.installOutput = 'Installing...'
    this.detectChanges()

    try {
      const result = await new Promise<string>((resolve, reject) => {
        childProcess.exec(
          this.installHooksCommand,
          { cwd: pluginRoot, timeout: 30_000 },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(stderr?.trim() || stdout?.trim() || err.message))
            } else {
              resolve(stdout?.trim() || 'Done')
            }
          },
        )
      })
      this.installOutput = result.split('\n').slice(0, 4).join('; ')
      this.notifications.notice('Claude hooks installed. Restart Tabby to apply.')
      this.hookHealthSvc.checkNow()
    } catch (e: any) {
      this.installOutput = `Error: ${String(e?.message ?? e)}`
      this.notifications.error('Hook install failed', String(e?.message ?? e))
    } finally {
      this.installRunning = false
      this.detectChanges()
    }
  }

  removeWorkspace (id: string, event?: Event): void {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    this.workspacesSvc.delete(id)
    this.refreshWorkspaces()
  }

  openWorkspace (id: string): void {
    this.workspacesSvc.setLastActive(id)
    const existing = this.app.tabs.find(t => t instanceof WorkspaceTabComponent && t.workspaceId === id) as WorkspaceTabComponent | undefined
    if (existing) {
      this.app.selectTab(existing)
      return
    }
    this.app.openNewTabRaw({
      type: WorkspaceTabComponent,
      inputs: { workspaceId: id },
    })
  }

  private runOnWorkspaceTab (workspaceId: string, action: (tab: WorkspaceTabComponent) => void): void {
    this.openWorkspace(workspaceId)

    const tryRun = (triesLeft: number) => {
      const tab = this.app.tabs.find(t => t instanceof WorkspaceTabComponent && t.workspaceId === workspaceId) as WorkspaceTabComponent | undefined
      if (!tab) {
        if (triesLeft > 0) {
          setTimeout(() => tryRun(triesLeft - 1), 120)
        }
        return
      }
      action(tab)
    }
    tryRun(12)
  }

  newTerminalInGroup (g: SessionGroup, event?: Event): void {
    event?.preventDefault?.()
    event?.stopPropagation?.()

    const cwd = (g.cwd ?? '').trim()
    if (!cwd) {
      return
    }
    let ws = this.workspacesSvc.findByCwd(cwd)
    if (!ws) {
      ws = this.workspacesSvc.create({ cwd, title: pathBase(cwd) || cwd })
      this.refreshWorkspaces()
    }

    this.runOnWorkspaceTab(ws.id, (tab) => {
      tab.newTerminal?.().catch?.(() => null)
    })
  }

  async openWorkspaceForSession (s: ClaudeSession): Promise<void> {
    const cwd = s.cwd ?? ''
    if (!cwd) {
      return
    }

    let ws = this.workspacesSvc.findByCwd(cwd)
    if (!ws) {
      ws = this.workspacesSvc.create({ cwd, title: pathBase(cwd) || cwd })
      this.refreshWorkspaces()
    }

    const terminalId = s.terminalId
    if (terminalId) {
      this.runOnWorkspaceTab(ws.id, (tab) => {
        tab.activateTerminal(terminalId)
      })
    } else {
      this.openWorkspace(ws.id)
    }
  }
}
