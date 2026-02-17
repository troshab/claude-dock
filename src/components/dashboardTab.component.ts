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
      <header class="cz-header">
        <div class="cz-title">
          <h1 class="cz-title-main">Claude Dock</h1>
          <button class="btn btn-sm btn-outline-primary cz-open-folder" (click)="openWorkspaceFolder()">
            Open workspace
          </button>
        </div>

        <div class="cz-usage-head">
          <div class="cz-usage-mini" aria-label="5-hour usage window">
            <div class="cz-usage-mini-label">5H</div>
            <div class="cz-usage-mid">
              <div class="cz-usage-bar" role="meter" aria-label="5-hour usage" [attr.aria-valuenow]="usagePct(usage?.usage5h?.used)" aria-valuemin="0" aria-valuemax="100">
                <div class="cz-usage-mask" [style.width.%]="usageHiddenPct(usage?.usage5h?.used)"></div>
              </div>
              <div class="cz-usage-reset" *ngIf="usageResetLabel(usage?.usage5h)">{{ usageResetLabel(usage?.usage5h) }}</div>
            </div>
            <div class="cz-usage-mini-value">{{ usageLabel(usage?.usage5h) }}</div>
          </div>
          <div class="cz-usage-mini" aria-label="7-day usage window">
            <div class="cz-usage-mini-label">7D</div>
            <div class="cz-usage-mid">
              <div class="cz-usage-bar" role="meter" aria-label="7-day usage" [attr.aria-valuenow]="usagePct(usage?.usageWeek?.used)" aria-valuemin="0" aria-valuemax="100">
                <div class="cz-usage-mask" [style.width.%]="usageHiddenPct(usage?.usageWeek?.used)"></div>
              </div>
              <div class="cz-usage-reset" *ngIf="usageResetLabel(usage?.usageWeek)">{{ usageResetLabel(usage?.usageWeek) }}</div>
            </div>
            <div class="cz-usage-mini-value">{{ usageLabel(usage?.usageWeek) }}</div>
          </div>
        </div>

        <div class="cz-runtime-head" role="region" aria-label="System resources">
          <span class="cz-runtime-name">CPU</span>
          <span class="cz-runtime-value">{{ systemCpuLabel() }}</span>
          <span class="cz-runtime-name cz-runtime-sep">RAM</span>
          <span class="cz-runtime-value">{{ systemRamLabel() }}</span>
          <span class="cz-runtime-sub">Claude</span>
          <span class="cz-runtime-claude-val">{{ totalCpuLabel() }}</span>
          <span class="cz-runtime-sub cz-runtime-sep">Claude</span>
          <span class="cz-runtime-claude-val">{{ totalRamLabel() }}</span>
        </div>

        <div class="cz-controls">
          <select class="form-select form-select-sm cz-select" aria-label="Sort workspaces" [value]="groupSortPreset" (change)="setGroupSortPreset($any($event.target).value)">
            <option value="none">Workspace: default</option>
            <option value="waiting">Workspace: waiting first</option>
            <option value="path">Workspace: by path</option>
          </select>

          <select class="form-select form-select-sm cz-select" aria-label="Sort sessions" [value]="sortPreset" (change)="setSortPreset($any($event.target).value)">
            <option value="status">Session: waiting first</option>
            <option value="startAsc">Session: oldest first</option>
            <option value="startDesc">Session: newest first</option>
            <option value="lastActivityDesc">Session: last active</option>
          </select>
        </div>

      </header>

      <main class="cz-grid">
        <div class="cz-col">
          <h2 class="cz-section-title">Workspaces</h2>

          <div *ngIf="!workspaces.length" class="cz-muted cz-empty">
            No recent workspaces yet.
          </div>

          <ul class="list-group cz-list" *ngIf="workspaces.length">
            <li
              class="list-group-item list-group-item-action cz-row cz-ws-item"
              *ngFor="let w of workspaces"
              (click)="openWorkspace(w.id)"
            >
              <div class="cz-workspace-path" [title]="normalizeCwd(w.cwd)">{{ normalizeCwd(w.cwd) }}</div>
              <button class="cz-ws-remove" title="Remove" aria-label="Remove workspace" (click)="removeWorkspace(w.id, $event)">&times;</button>
            </li>
          </ul>
        </div>

        <div class="cz-col">
          <h2 class="cz-section-title">
            Sessions
            <span class="cz-muted">({{ sessionsSorted.length }})</span>
          </h2>

          <div *ngIf="!sessionsSorted.length" class="cz-muted cz-empty">
            <div>No sessions yet.</div>
          </div>

        <div>
          <details class="cz-group" *ngFor="let g of groupsSorted; trackBy: trackGroupKey" [attr.open]="isGroupOpen(g) ? '' : null" (toggle)="setGroupOpen(g, $event)">
            <summary class="cz-group-summary">
              <span class="cz-strong">{{ g.projectName }}</span>
              <span class="cz-muted cz-small">{{ normalizeCwd(g.cwd) }}</span>
              <span class="cz-group-actions">
                <span class="badge bg-success" *ngIf="g.waitingCount">{{ g.waitingCount }} waiting</span>
                <button
                  type="button"
                  class="btn btn-sm btn-success cz-group-new"
                  title="New terminal in workspace"
                  (click)="newTerminalInGroup(g, $event)"
                >
                  +
                </button>
              </span>
            </summary>

            <div class="list-group cz-list">
              <button
                type="button"
                class="list-group-item list-group-item-action cz-row"
                *ngFor="let s of g.sessions"
                (click)="openWorkspaceForSession(s)"
              >
                <div class="cz-row-top">
                  <div class="cz-row-title">
                    <span class="cz-strong">{{ sessionLabel(s, true) }}</span>
                    <span class="cz-muted cz-small" *ngIf="s.sessionId"> {{ s.sessionId }}</span>
                  </div>
                  <div class="cz-row-right">
                    <span class="badge" [class]="badgeClass(s.status)">{{ s.status }}</span>
                    <button
                      type="button"
                      class="btn btn-sm btn-outline-danger cz-session-close"
                      [disabled]="!canCloseSession(s)"
                      (click)="closeSession(s, $event)"
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div class="cz-row-bottom">
                  <span class="cz-muted cz-small" *ngIf="s.lastToolName">tool: {{ s.lastToolName }}</span>
                  <span class="cz-muted cz-small" *ngIf="s.lastEventTs">last: {{ age(s.lastEventTs) }}</span>
                  <span class="cz-muted cz-small" *ngIf="s.waitingSinceTs && s.status === 'waiting'">waiting: {{ age(s.waitingSinceTs) }}</span>
                  <span class="cz-muted cz-small" *ngIf="runtimeLabel(s)">{{ runtimeLabel(s) }}</span>
                </div>

                <ul class="cz-todos" *ngIf="todosFor(s).length">
                  <li class="cz-todo" *ngFor="let t of todosFor(s)">
                    <span class="cz-todo-check" [class.done]="t.status === 'completed'">{{ todoMark(t.status) }}</span>
                    <span class="cz-todo-text" [class.done]="t.status === 'completed'">{{ t.content }}</span>
                  </li>
                </ul>
              </button>
            </div>
          </details>
        </div>
        </div>
      </main>
    </ng-container>

    <ng-template #hooksSetup>
      <section class="cz-setup" aria-label="Setup">
        <h1 class="cz-title-main">Claude Dock</h1>
        <p class="cz-setup-text">
          Install Claude hooks first to enable sessions and recent workspaces.
        </p>
        <button
          type="button"
          class="btn btn-sm btn-outline-success cz-install-btn"
          [disabled]="installRunning"
          (click)="runInstallHooks($event)"
          title="Install Claude hooks"
        >
          <i class="fas fa-download" aria-hidden="true"></i>
          <code>{{ installHooksCommand }}</code>
        </button>
        <div class="cz-muted cz-small cz-install-hint" *ngIf="installOutput">
          {{ installOutput }}
        </div>
      </section>
    </ng-template>
  `,
  styles: [`
    :host {
      display: flex; flex-direction: column; height: 100%; padding: 12px; overflow: auto;
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
    code { font-family: var(--cz-font-mono); }

    .cz-header { display: flex; gap: 8px; align-items: stretch; justify-content: flex-start; flex-wrap: wrap; margin-bottom: 12px; width: 100%; }
    .cz-title { display: flex; flex-direction: column; line-height: 1.1; min-width: 0; align-items: center; justify-content: center; gap: 4px; }
    .cz-title-main { font-weight: 700; font-size: 1.15em; }
    .cz-open-folder { white-space: nowrap; }
    .cz-usage-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
    .cz-usage-mini { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 2px 4px; border: 1px solid var(--cz-border); border-radius: var(--cz-radius); padding: 4px 6px; }
    .cz-usage-mini-label { font-weight: 700; text-transform: uppercase; opacity: .8; }
    .cz-usage-mid { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cz-usage-bar {
      position: relative;
      height: var(--cz-bar-height);
      border-radius: var(--cz-radius-pill);
      overflow: hidden;
      background: linear-gradient(90deg, var(--cz-green) 0%, var(--cz-green) 60%, var(--cz-yellow) 80%, var(--cz-red) 100%);
    }
    .cz-usage-mask {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 100%;
      background: var(--cz-overlay);
      transition: width .2s ease;
    }
    .cz-usage-mini-value { opacity: var(--cz-opacity-muted); text-align: right; white-space: nowrap; }
    .cz-usage-reset { font-size: 0.8em; opacity: var(--cz-opacity-dim); white-space: nowrap; }
    .cz-runtime-head {
      display: grid;
      grid-template-columns: auto auto auto auto;
      align-content: center;
      gap: 2px 6px;
      padding: 4px 8px;
      border: 1px solid var(--cz-green-border);
      border-radius: var(--cz-radius);
      font-weight: 600;
      background: var(--cz-green-subtle);
      white-space: nowrap;
      flex-shrink: 1;
    }
    .cz-runtime-name { opacity: .9; }
    .cz-runtime-sub { opacity: var(--cz-opacity-dim); font-size: 0.85em; font-weight: 500; }
    .cz-runtime-claude-val { opacity: var(--cz-opacity-muted); font-size: 0.85em; text-align: right; }
    .cz-runtime-value { text-align: right; font-variant-numeric: tabular-nums; }
    .cz-runtime-sep { padding-left: 8px; border-left: 1px solid var(--cz-border-light); }
    .cz-controls { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; justify-content: center; margin-left: auto; }
    .cz-select { width: auto; max-width: 100%; min-width: 0; }

    .cz-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 3fr); gap: 12px; min-height: 0; width: 100%; }
    @media (max-width: 700px) {
      .cz-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 500px) {
      :host { padding: 8px; }
      .cz-header { gap: 6px; }
      .cz-runtime-head { display: none; }
      .cz-usage-head { min-width: 0; }
      .cz-group-summary { flex-wrap: wrap; }
    }
    @media (max-width: 400px) {
      :host { padding: 6px; }
      .cz-usage-mini-value { display: none; }
      .cz-usage-reset { display: none; }
    }
    .cz-col { min-height: 0; }

    h1.cz-title-main { font-size: 1.15em; margin: 0; }
    h2.cz-section-title { font-size: 1em; margin: 0 0 8px 0; }
    .cz-section-title { font-weight: 700; margin-bottom: 8px; }

    .cz-list { border-radius: var(--cz-radius); overflow: hidden; list-style: none; padding-left: 0; margin: 0; }
    .cz-row { display: block; text-align: left; }
    .cz-row-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .cz-row-title { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .cz-row-right { display: inline-flex; align-items: center; gap: 8px; }
    .cz-session-close { padding: 3px 10px; line-height: 1.15; min-height: var(--cz-click-min); }
    .cz-row-bottom { display: flex; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
    .cz-workspace-path {
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
      unicode-bidi: plaintext;
      opacity: .85;
    }

    .cz-badge-waiting { background: var(--cz-yellow); color: #000; font-weight: 600; }
    .cz-badge-working { background: #2a8a52; color: #fff; font-weight: 600; }
    .cz-ws-item { display: flex !important; align-items: center; gap: 8px; cursor: pointer; }
    .cz-ws-remove {
      border: none;
      background: transparent;
      color: inherit;
      opacity: .5;
      padding: 4px 8px;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      min-height: var(--cz-click-min);
    }
    .cz-ws-remove:hover { opacity: 1; color: var(--cz-red); }
    .cz-strong { font-weight: 700; }
    .cz-muted { opacity: .7; }
    .cz-small { font-size: 0.85em; }
    .cz-empty { padding: 8px 4px; }
    .cz-setup {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 10px;
      padding: 18px;
    }
    .cz-setup-text {
      opacity: .9;
    }
    .cz-install-btn {
      margin-top: 8px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 1.05em;
      font-weight: 700;
      padding: 8px 12px;
      border-width: 2px;
    }
    .cz-install-btn code {
      font-weight: 700;
    }
    .cz-install-hint {
      margin-top: 6px;
    }

    .cz-group { border: 1px solid var(--cz-border); border-radius: var(--cz-radius); padding: 8px; margin-bottom: 8px; }
    .cz-group-summary { display: flex; gap: 8px; align-items: baseline; cursor: pointer; margin-bottom: 6px; }
    .cz-group-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
    .cz-group-new { width: var(--cz-click-min); height: var(--cz-click-min); padding: 0; line-height: 1; border-radius: var(--cz-radius-pill); }

    .cz-todos { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--cz-border); display: flex; flex-direction: column; gap: 2px; list-style: none; padding-left: 0; }
    p.cz-setup-text { margin: 0; }
    .cz-todo { display: flex; gap: 8px; align-items: baseline; }
    .cz-todo-check { font-family: var(--cz-font-mono); opacity: .75; }
    .cz-todo-check.done { opacity: var(--cz-opacity-dim); }
    .cz-todo-text.done { text-decoration: line-through; opacity: var(--cz-opacity-dim); }
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

  trackGroupKey (_: number, g: SessionGroup): string {
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
      case 'waiting': return 'cz-badge-waiting'
      case 'working': return 'cz-badge-working'
      case 'unknown': return 'bg-secondary'
      case 'ended': return 'bg-dark'
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
        })
      }
      const g = groups.get(key)!
      g.sessions.push(s)
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
