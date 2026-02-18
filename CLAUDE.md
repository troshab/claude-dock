## Versioning

Semantic versioning: `MAJOR.MINOR.PATCH`.

- **Patch** (1.0.0 -> 1.0.1 -> ... -> 1.0.9): bug fixes, small tweaks, no new features.
- **Minor** (1.0.9 -> 1.1.0): new features, non-breaking changes.
- **Major** (1.x.y -> 2.0.0): breaking changes (config format, hook protocol, API).

Version is pinned in these locations (all must be updated together):
- `package.json` `version`
- `.claude-plugin/marketplace.json` plugins[0].version
- `plugin/.claude-plugin/plugin.json` `version`
- `src/config.ts` `defaultDockerImage` tag
- `src/components/dashboardTab.component.ts` image placeholder and fallback
- `src/components/workspaceTab.component.ts` image fallback

Docker image tag matches the package version: `ghcr.io/troshab/claude-dock:<version>`.
GitHub Actions workflow (`.github/workflows/docker.yml`) builds and pushes to ghcr.io
on git tags matching `v*`.

### Release checklist

1. Bump version in all 6 locations listed above (search-replace old -> new).
2. `npm install --package-lock-only` to sync package-lock.json.
3. Commit, push.
4. `git tag v<version> && git push --tags` -- triggers Docker image build on ghcr.io.
5. `npm publish --access public` -- publishes to npm (requires OTP confirmation).

### Distribution

Everything is installed by a single command: `npm i -g @troshab/claude-dock`.
The postinstall script (`scripts/install.js`) does three things:
1. Copies `plugin/` to `~/.claude/plugins/cache/claude-dock/claude-dock/<version>/`
   (Claude Code hooks -- delivered via plugin/hooks/hooks.json).
2. Registers `claude-dock@claude-dock` in `~/.claude/settings.json` `enabledPlugins`.
3. Links the Tabby plugin into `<tabby-plugins>/node_modules/tabby-claude-dock`.

No separate marketplace command is needed. `npm uninstall -g @troshab/claude-dock`
runs `scripts/uninstall.js` which reverses all three steps.

## Known issues — embedded terminals

Workspace tabs embed Tabby terminal tabs via `insertIntoContainer`. Keyboard focus can
drift to workspace header elements (buttons, <select>, subtab bar). When a non-terminal
element has focus, the browser intercepts space as "click button" or "scroll page" instead
of forwarding it to xterm.js → PTY.

Fix: `.cz-terminal-host` has (click)="focusTerminal()" to re-emit focus to the active
terminal tab, and (keydown) guard to prevent space/key bubbling from the terminal area.

Root: Tabby's `emitFocused()` only fires on Tabby-level tab focus, not on intra-component
focus shifts. The workspace component must manage this itself.

## Known issues — terminal overlay on tab switch

When switching from a workspace tab back to the dashboard, the workspace's embedded terminal
(and sometimes the entire workspace header/subtab bar) can remain visible, covering the
dashboard content.

### Layer 1: terminal detach

Root cause: `blurred$` may not fire when focus is on a header element (checkbox, button,
`<select>`, subtab bar) — Tabby only emits `visibility$(false)` in those cases.

Fix: `visibility$(false)` handler now also detaches the terminal (mirrors `blurred$`).
Both `blurred$` and `visibility$(false)` detach; `focused$` + `visibility$(true)` remount.

### Layer 2: host element hide (defensive)

Even with terminal detach, the workspace **header** (buttons, checkboxes, meters, subtab
bar) can still overlay the dashboard. Root cause: Tabby manages tab visibility via
`content-tab-active` class on `<tab-body>` (`left: 0` vs `left: -1000%`). In edge cases
Tabby fails to remove `content-tab-active` from the workspace's `<tab-body>`, leaving both
tabs at `left: 0` — the workspace renders on top due to DOM order.

Fix: `hideHost()` / `showHost()` set `display: none/''` on both the workspace's `:host`
element AND the parent `<tab-body>` (found via `closest('tab-body')`). Setting only `:host`
to `display: none` is insufficient — the `<tab-body>` itself has a dark background
(`rgb(30, 31, 41)`) and full viewport dimensions, so it covers the dashboard even when the
component inside is hidden. Called from `blurred$`, `visibility$(false)`, `focused$`, and
`visibility$(true)`.

If the issue recurs: check that BOTH handlers call `hideHost()`, and that no new code path
calls `showHost()` or `mountActiveTerminal()` without checking `isFocused && isVisible`.

## Performance — never use sync I/O on the renderer main thread

### Sync file writes (writeFileSync / appendFileSync)

`TabbyDebugService.log()` originally used `fs.appendFileSync`. With dozens of `debug.log()`
calls per event cycle, this blocked the renderer for 1.3+ seconds.

Fix: replaced with `fs.createWriteStream` + `stream.write()` (non-blocking).

Rule: **never use writeFileSync/appendFileSync in any code path that runs on the renderer**.
Use WriteStream or `fs.promises`.

### Sync child process (execFileSync / spawnSync)

`refreshBranches()` used `execFileSync('git', ['branch'])` — ~250ms per call. Combined with
`cfg.changed$` firing on every config save, this created a feedback loop: save → changed$ →
loadWorkspace → refreshBranches (sync 250ms) → detectChanges → repeat. 53 sequential calls
= 13.6 seconds of main thread blocking.

Fix: replaced with async `execFile` callback + re-entrancy guard + debounced `cfg.changed$`
subscription (300ms).

Rule: **never use execFileSync/spawnSync** in component code. Always use async variants.
Debounce any subscription to `cfg.changed$` to prevent feedback loops with `cfg.save()`.

### Sync file reads in tick()

`ClaudeEventsService.tick()` used `fs.statSync/openSync/readSync/closeSync`. Replaced with
`fs.promises.stat/open/read/close`. Less impactful than writes (runs every 1s, small reads)
but still blocks the renderer unnecessarily.

## Angular — detectChanges before view init

Calling `cdr.detectChanges()` from constructor subscriptions (BehaviorSubject emits
immediately) causes `TypeError: Cannot read properties of null` because the template
bindings reference properties that don't exist until the view initializes.

Fix: `viewReady` flag set in `ngAfterViewInit`, guard all `detectChanges()` calls.

Rule: any subscription set up in the constructor that may emit synchronously (BehaviorSubject,
ReplaySubject, startWith) **must** guard detectChanges with a viewReady check.

## Angular — change detection strategy

Both components use `ChangeDetectionStrategy.OnPush` + `NgZone.runOutsideAngular()` +
rAF-coalesced `scheduleCD()`. This prevents our async operations (file polling, runtime
stats, config changes) from triggering Zone.js global change detection for ALL Tabby
components.

### Pattern

```typescript
// 1. Component decorator
@Component({ changeDetection: ChangeDetectionStrategy.OnPush, ... })

// 2. Inject NgZone
private zone: NgZone
this.zone = injector.get(NgZone)

// 3. rAF-coalesced CD — max 1 render per animation frame
private cdQueued = false
private scheduleCD(): void {
  if (this.cdQueued || !this.viewReady) return
  this.cdQueued = true
  requestAnimationFrame(() => {
    this.cdQueued = false
    if (!this.viewReady) return
    try { this.cdr.detectChanges() } catch {}
  })
}

// 4. Data subscriptions outside zone
this.zone.runOutsideAngular(() => {
  this.subscribeUntilDestroyed(obs$, (v) => {
    this.field = v
    this.scheduleCD()  // coalesced, not immediate
  })
})
```

### When to use direct `cdr.detectChanges()` vs `scheduleCD()`

- **`scheduleCD()`** — data-only updates (stats, usage, sessions, todos, config). Safe to
  defer by one animation frame (~16ms). Multiple updates in the same tick merge into one
  render.
- **Direct `cdr.detectChanges()`** — before DOM-dependent operations like terminal mounting
  (`mountActiveTerminal`), or DOM hacks (select revert in `switchBranch`). These need the
  DOM to be synchronously updated before the next line runs.

### What stays inside Zone

Template event handlers (`(click)`, `(keydown)`, `(change)`) run inside Zone automatically
via Angular's event bindings. With OnPush, template events mark the component dirty and
trigger CD — no manual call needed for user interactions.

`focused$`, `blurred$`, `visibility$` subscriptions stay inside Zone in `workspaceTab`
because they trigger DOM-dependent operations (terminal mount/detach, host show/hide).

Rule: new subscriptions default to `runOutsideAngular` + `scheduleCD()`. Only run inside
Zone if the callback does synchronous DOM manipulation that must complete before the next
line.

## Windows — cross-platform command resolution (src/launch.ts)

`node-pty` on Windows uses `CreateProcessW` which cannot spawn `.cmd`/`.bat` files directly.
The old `shellWrap()` wrapped ALL commands in `cmd.exe /c` - even native `.exe` binaries,
adding an unnecessary process layer.

Fix: `resolveForPty(name, args)` in `src/launch.ts` uses the `which` npm package (v4, CJS)
to resolve the actual executable path via `PATH` + `PATHEXT`:
- **.exe/.com** on Windows: spawn directly (no cmd.exe wrapper)
- **.cmd/.bat** on Windows: wrap in `COMSPEC /d /s /c "full-path"` (safe flags)
- **Not found**: fallback to COMSPEC (lets cmd.exe produce the error)
- **Unix**: resolve full path via PATH (execvp handles shebangs natively)

`cleanEnv(baseEnv, extras)` merges environment variables and strips nesting guards
(`CLAUDECODE`) that would prevent Claude from starting if Tabby was launched from a
Claude session.

Rule: always use `resolveForPty()` for terminal launches, never spawn bare command names.
Only async `which()` is allowed - `which.sync()` uses `fs.accessSync` (forbidden on renderer).
Rule: always strip `CLAUDECODE` from terminal env via `cleanEnv()`.

## Docker — container lifecycle

Uses `docker run` (not `docker sandbox run`) with custom image `claude-dock-sandbox:dev`
(built from `docker/Dockerfile`, based on `sandbox-templates:shell` + Claude CLI).

**Why not `docker sandbox run`**: sandbox infra creates symlinks for `settings.json` and
`.claude.json` pointing to `/mnt/claude-data/`. When `~/.claude` is bind-mounted, these
symlinks are written THROUGH the bind mount onto the host filesystem, destroying the
original files. `docker run` gives full control over mounts with no sandbox interference.

Container launch (`buildLaunchCommand`):
- Workspace mounted at its POSIX path: `-v C:\Users\NAME\project:/c/Users/NAME/project`
- `CLAUDE_DOCK_CWD` env var for entrypoint symlink creation
- `CLAUDE_DOCK_FORWARD_PORTS` env var for socat port forwarding
- Optional `~/.claude` and `~/.claude.json` bind mounts (Mount ~/.claude checkbox)
- `ANTHROPIC_API_KEY` forwarded if set

Entrypoint (`docker/entrypoint.sh`):
1. Creates Windows-path symlink (`/c/Users/NAME/.claude -> /home/agent/.claude`)
2. Restores dangling symlinks from backups (safety net)
3. Removes `.orphaned_at` plugin markers
4. Starts socat port forwarders
5. `exec "$@"` into claude

On terminal close, `cleanupSandbox()` runs `docker rm -f <name>` asynchronously
(fire-and-forget). Called from `closeTerminal`, `destroyed$`, and `destroy`.

Docker does not expand `~` in `-v` volume paths. `~/.claude:/home/agent/.claude` fails with
"bind source path does not exist: /.claude".

Rule: always use `path.join(os.homedir(), '.claude')` for absolute paths in Docker volume
mounts, never `~`.

## Tabby config — defaults required for persistence

Tabby's `ConfigService` deep-merges saved config with `ConfigProvider.defaults`. Keys not
declared in defaults may be stripped on save/load, causing settings to vanish after restart.

Fix: all persisted keys must be declared in `ClaudeDockConfigProvider.defaults`.

Per-workspace settings (useDockerSandbox, mountClaudeDir, dangerouslySkipPermissions) are
stored inside workspace objects in the `workspaces` array, read via `this.workspace?.field`,
and written via `workspaces.updateWorkspace(id, patch)`.

## Debug logging — disabled by default

`TabbyDebugService` writes structured JSON logs to `~/.claude/claude-dock/tabby-debug/`.
Logging is **OFF by default**. It is gated by env `CLAUDE_DOCK_DEBUG=1` or Tabby config
`claudeDock.debugLogging: true`.

When you need to debug, enable it, reproduce the issue, then **always**:
1. Disable logging back (`debugLogging: false` or remove the env var).
2. Delete log files: `rm -rf ~/.claude/claude-dock/tabby-debug/`

Never leave debug logging enabled after a session. Log files grow fast (~235 MB / 150 sessions)
and have no rotation.

## UI — Tabby styling conventions

Tabby is based on **Bootstrap 4**. Plugins must use BS4 classes, not BS5.

- **Selects**: `select.form-control.form-control-sm`, NOT `form-select` (BS5).
- **Buttons**: `btn btn-sm btn-outline-*` (standard BS4).
- **Lists**: `list-group` / `list-group-item` / `list-group-item-action`.
- **Settings tabs** in Tabby use `.form-line > .header > (.title + .description)` pattern.
  Our dashboard/workspace tabs are standalone content tabs, not settings tabs, so they
  use custom layout - but form controls must still be BS4-compatible.

## UI — CSS class prefix

All custom CSS classes use the `cd-` prefix (claude-dock). Previously was `cz-`
(claude-code-zit). Never use unprefixed custom class names to avoid collisions with
Tabby/Bootstrap globals.

CSS custom properties also use `--cd-` prefix (e.g., `--cd-green`, `--cd-radius`).

## UI — semantic markup and accessibility

Both component templates (DashboardTab, WorkspaceTab) use semantic HTML and ARIA:

- **Structure**: `<header>` for top bars, `<main>` for content areas, `<section>` for
  standalone screens (setup), `<h1>` for page title, `<h2>` for section titles.
- **Lists**: workspace list and todo list use `<ul>/<li>` (with `list-style: none`).
  Never nest `<button>` inside `<button>` — session rows use `<div role="button"
  tabindex="0">` with `(keydown.enter)` and `(keydown.space)` handlers for keyboard
  access. Inner action buttons (Close) use `$event.stopPropagation()` to avoid
  triggering the row click.
- **Usage bars**: `role="meter"` with `aria-label`, `[attr.aria-valuenow]`,
  `aria-valuemin="0"`, `aria-valuemax="100"` on all `.cd-usage-bar` / `.cd-ws-usage-bar`
  elements.
- **Tab bar**: `.cd-subtabs` has `role="tablist"` + `aria-label="Terminal tabs"`. Each
  `.cd-subtab` has `role="tab"`, `[attr.aria-selected]`, `[attr.tabindex]` (0 for active,
  -1 for inactive). Arrow keys navigate between tabs (`onSubtabKeydown`). Terminal host
  has `role="tabpanel"`.
- **Selects**: every `<select>` has an `aria-label` (e.g., "Sort workspaces", "Resume
  session", "Git branch").
- **Colors - BS4 first**: use Bootstrap 4 utility classes for element-level coloring:
  `bg-success`, `bg-warning`, `bg-danger`, `bg-secondary`, `bg-dark`, `text-dark`,
  `text-white`. Never create custom CSS tokens for colors that BS4 classes already cover.
  Custom `--cd-*` color tokens exist ONLY for things BS4 cannot do: rgba overlays
  (`--cd-green-subtle`, `--cd-green-border`, `--cd-green-hover`, `--cd-green-active`,
  `--cd-overlay`), usage bar gradients (`--cd-green`, `--cd-yellow`, `--cd-red`),
  checkbox accent-color (`--cd-green`, `--cd-orange`), and border colors (`--cd-border`,
  `--cd-border-light`). WorkspaceTab-only: `--cd-option-bg`, `--cd-option-text`,
  `--cd-terminal-bg`, `--cd-green-tab`.
- **Spacing tokens**: never use raw pixel values for gap/margin/padding - use
  `--cd-gap-micro` (2px), `--cd-gap-xs` (4px), `--cd-gap-xs-plus` (6px),
  `--cd-gap-sm` (8px), `--cd-gap-md` (12px). Radii: `--cd-radius` (8px),
  `--cd-radius-sm` (4px), `--cd-radius-pill` (999px). Excluded from tokenization:
  `1px` borders, triangle geometry, fixed widths, font sizes, one-off structural padding.
- **Todo indicators**: todo list uses colored dot indicators (`cd-todo-dot`) instead of
  text markers. Pending: outlined circle (dim). In-progress: filled green circle.
  Completed: outlined circle (very dim) + strikethrough text.
- **Display name**: the plugin is titled "Claude Dock" in the UI.

## Hook processing — bidirectional TCP protocol

Claude Code fires 14 hook events during a session lifecycle. Our plugin handles all of them
via a TCP server on port 19542. Hooks fall into two categories:

**Async (fire-and-forget via dispatcher->worker):** SessionStart, UserPromptSubmit,
PreToolUse, PostToolUse, PostToolUseFailure, Notification, SubagentStart, PreCompact,
SessionEnd. These update dashboard session state (status, activity, errors, todos) but
don't return decisions to Claude Code.

**Sync (bidirectional TCP, socket held open):** PermissionRequest, Stop, SubagentStop,
TeammateIdle, TaskCompleted. These hold the TCP socket open so the dashboard can send a
response back to the hook process, which then writes the decision to stdout/stderr.

### Sync hook response protocol

Hook sends JSON with `awaiting_response: true` + `request_id` (UUID). Tabby stores the
socket in `pendingPermissions` Map keyed by `request_id`. Dashboard shows interactive
buttons. User clicks -> Tabby writes response JSON to socket -> hook formats output:

| Hook | Dashboard UI | Allow response | Block response |
|------|-------------|----------------|----------------|
| PermissionRequest | Allow/Deny buttons | stdout: `{decision:{behavior:"allow"}}` | stdout: `{decision:{behavior:"deny",message:"..."}}` |
| Stop | Continue + text input | exit 0, no stdout | stdout: `{decision:"block",reason:"..."}` |
| SubagentStop | Continue button | exit 0, no stdout | stdout: `{decision:"block",reason:"..."}` |
| TeammateIdle | Continue button | exit 0 | exit 2, stderr: message |
| TaskCompleted | Accept/Reject + text | exit 0 | exit 2, stderr: message |

### Dashboard-active optimization

Non-essential sync hooks (Stop, SubagentStop, TeammateIdle, TaskCompleted) auto-resolve
with `behavior: "allow"` when the dashboard tab is not focused (`dashboardActive` flag).
This prevents 30-second blocking delays when the user is working in the terminal.
PermissionRequest always holds regardless of dashboard state (600s timeout).

### AskUserQuestion

AskUserQuestion is a tool, not a hook event. It triggers PermissionRequest (known bug
[#15400](https://github.com/anthropics/claude-code/issues/15400)). The dashboard shows
the question text and options in the permission card via `buildActivityString`. The user
can Allow/Deny but cannot select an answer option (no API support yet).

### Key files

- `bin/claude-dock-hook.js`: `SYNC_HOOKS` config, `runSyncHook()`, `formatSyncResponse()`
- `src/services/claudeEvents.service.ts`: `pendingPermissions` Map, `respondToHookAction()`,
  `clearPendingForSession()`, `dashboardActive` flag
- `src/components/dashboardTab.component.ts`: `.cd-action-card` UI, action methods
- `plugin/hooks/hooks.json`: sync hooks have no `"async": true`

## Debug screenshots

Save debug screenshots (layout issues, UI bugs, responsive testing) to `.screenshots/`.
This directory is gitignored. Use descriptive filenames, e.g. `overlap-bug-dashboard.png`,
`v5-narrow-450.png`. When taking screenshots via MCP `take_screenshot`, save them there.

## Development — CSS workflow

When testing style changes with an active DevTools debug session: **always prototype via
`evaluate_script` first** (inject a `<style>` tag into `document.head`), take screenshots,
and get user approval. Only then apply the changes to the source `.component.ts` file.
Never modify source CSS before previewing in DevTools.

## Development — mock data for layout testing

Script: `node scripts/insert-mock-dashboard.js [sessions] [projects]`

Connects to Tabby via CDP (port 9222), finds the DashboardTabComponent instance through
Angular's `ɵgetLContext`, patches `visibleRuntimeSessions()` and `todosFor()` with
generated sessions and mock todos, and calls `recompute()`. Zero external dependencies.
Every 3rd session gets 2-5 random todos with mixed statuses (pending/in_progress/completed).

```bash
node scripts/insert-mock-dashboard.js            # 30 sessions, 5 projects
node scripts/insert-mock-dashboard.js 100 10     # 100 sessions, 10 projects
node scripts/insert-mock-dashboard.js clear       # remove mock data, restore live sessions
```

How it finds the component: `require('@angular/core').ɵgetLContext(dashboardElement)` returns
the LView, component instance is at `lView[8]`. The patched `visibleRuntimeSessions` method
overrides the default `events.sessions$.value` read - needed because the events service tick
would overwrite `sessions$.next()` calls.

To resize the Tabby window for testing: use `@electron/remote` via `evaluate_script`:
`require('@electron/remote').getCurrentWindow().setSize(width, height)`.

## Development — Tabby remote debugging

To inspect the plugin live in Chrome DevTools (or via MCP debug-in-chrome-with-devtools),
launch Tabby with the remote debugging flag:

```bash
~/AppData/Local/Programs/Tabby/Tabby.exe --remote-debugging-port=9222
```

This enables Chrome DevTools Protocol on port 9222. Tabby always exposes exactly one page
(`file:///...app.asar/dist/index.html`) -- skip `list_pages` and go straight to
`take_screenshot`, `evaluate_script`, `take_snapshot` to inspect DOM and debug layout.
Use `@electron/remote` via `evaluate_script` to resize the window for responsive testing:
`require('@electron/remote').getCurrentWindow().setSize(width, height)`.

**After `npm run build`**: do NOT restart Tabby automatically. Print the restart command
and let the user run it. The user manages the Tabby process lifecycle manually.

Restart command (give to user, do not execute):
```bash
powershell -Command "Stop-Process -Name Tabby -Force -ErrorAction SilentlyContinue"; sleep 2; ~/AppData/Local/Programs/Tabby/Tabby.exe --remote-debugging-port=9222 &
```

## Plugin system — orphaning and enabledPlugins

Claude Code orphans plugins in `~/.claude/plugins/cache/` that are not listed in
`settings.json` `enabledPlugins`. The npm postinstall script registers
`claude-dock@claude-dock` in `enabledPlugins` and copies plugin files to the cache.
The Docker entrypoint removes `.orphaned_at` markers on startup as a safety net.
