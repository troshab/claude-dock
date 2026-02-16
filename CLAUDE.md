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
