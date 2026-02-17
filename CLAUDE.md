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
can remain visible, covering the dashboard content.

Root cause: terminal detach was only in `blurred$`, but `blurred$` may not fire when focus
is on a header element (checkbox, button, `<select>`, subtab bar) — Tabby only emits
`visibility$(false)` in those cases. Any new interactive element added to the workspace
header is a potential trigger.

Fix: `visibility$(false)` handler now also detaches the terminal (mirrors `blurred$`).
Both `blurred$` and `visibility$(false)` detach; `focused$` + `visibility$(true)` remount.

If the issue recurs: check that BOTH handlers detach, and that no new code path calls
`mountActiveTerminal()` without checking `isFocused && isVisible`.

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

## Windows — node-pty cannot spawn .cmd files directly

`node-pty` on Windows throws `Error: File not found` when given a `.cmd` file (like `claude`)
as the command. It only works with `.exe` binaries.

Fix: `shellWrap()` method wraps commands in `cmd.exe /c` on Windows.

Rule: always wrap non-exe commands through `cmd.exe /c` on `process.platform === 'win32'`.

## Docker — tilde expansion and volume mounts

Docker does not expand `~` in `-v` volume paths. `~/.claude:/home/agent/.claude` fails with
"bind source path does not exist: /.claude".

Fix: use `path.join(os.homedir(), '.claude')` for the absolute path.

Rule: always use absolute paths in Docker volume mounts, never `~`.

## Tabby config — defaults required for persistence

Tabby's `ConfigService` deep-merges saved config with `ConfigProvider.defaults`. Keys not
declared in defaults may be stripped on save/load, causing settings to vanish after restart.

Fix: all persisted keys must be declared in `ClaudeCodeZitConfigProvider.defaults`.

Per-workspace settings (useDockerSandbox, mountClaudeDir, dangerouslySkipPermissions) are
stored inside workspace objects in the `workspaces` array, read via `this.workspace?.field`,
and written via `workspaces.updateWorkspace(id, patch)`.

## Plugin system — orphaning and enabledPlugins

Claude Code orphans plugins in `~/.claude/plugins/cache/` that are not listed in
`settings.json` `enabledPlugins`. The install script must add the plugin key
(`troshab@claude-code-zit`) to `enabledPlugins` and remove `.orphaned_at` markers.
