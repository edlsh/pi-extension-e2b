# Changelog

## [2.0.0] - 2026-07-12

### Changed

- **BREAKING:** Updated the e2b SDK from `^1.2.0` to `^2.31.0`. E2B v2 requires Node `>=20.18.1`, is secure by default, and requires custom templates built with envd `<0.2.0` to be rebuilt.
- **BREAKING:** Raised the pi peer dependency to `>=0.80.0`.
- Replaced the `@sinclair/typebox` peer/import with `typebox`.
- Reconnect now extends the sandbox timeout to 60 minutes and reports the real template name instead of `"reconnected"`.
- Reconnecting to a paused sandbox now resumes it automatically.

### Added

- `--e2b-persist` pauses the sandbox on session end or timeout instead of killing it.
- `/e2b-pause` pauses the active sandbox and restores local tools.
- `/e2b-list` lists pi-created running and paused sandboxes with reconnect and kill actions.
- New sandboxes receive `app=pi-e2b` and `project` metadata tags.
- `/e2b` now reports sandbox state, expiry, CPU, memory, and disk metrics.

### Internal

- Replaced the no-op `check` script with `tsc --noEmit`.
- Added pnpm `minimumReleaseAge=10080` and `ignore-scripts=true`.

## [1.2.0] - 2026-06-03

### Added

- `promptGuidelines` on the `e2b_port_url` tool — guideline bullets are now appended to the system-prompt Guidelines section automatically, replacing the ad-hoc system-prompt append.
- Terminal window/tab title is set to `π E2B: <sandboxId>` while a sandbox is active (TUI mode only); restored to `π` on disable.
- Streaming working-message indicator shows `Starting E2B sandbox…` / `Connecting to E2B sandbox…` / `Syncing project files to E2B sandbox…` during the sandbox lifecycle (TUI mode only).
- Interactive `ui.input()` prompt when `/e2b-reconnect` is called without a sandbox ID.
- Interactive `ui.select()` template picker on `Ctrl+Shift+E` enable when no `--e2b-template` flag is set.
- `session_before_fork` confirmation dialog warning that both forks will share the same sandbox.
- Context-usage percent (`· ctx NN%`) is appended to the E2B status widget when available.

### Changed

- `safeNotify` / `safeSetStatus` / `safeSetWidget` / `safeThemeFg` / `updateWidget` / `initialiseSandbox` / `teardownSandbox` now use the typed `ExtensionContext` (and `UICtx = Pick<ExtensionContext, "ui" | "hasUI">`) instead of `(ctx as any).hasUI` guards.
- Peer dependency on `@earendil-works/pi-coding-agent` bumped to `>=0.78.0` to gate on `promptGuidelines`, `ctx.getContextUsage()`, `ui.setTitle`, `ui.setWorkingMessage`, `ui.input`, `ui.select`, and the `session_before_fork` event.

### Fixed

- All Buffer uploads to the sandbox (the write tool, project file sync, and `/e2b-upload`) now go through a shared `bufferToArrayBuffer` helper that copies into a fresh `ArrayBuffer` and passes it directly to `sbx.files.write`, rather than wrapping in `new Blob([buffer])`. The previous form failed strict-mode type-check because `Buffer<ArrayBufferLike>` is not assignable to `BlobPart`.
- Custom `grep` tool result objects now include `details: undefined` to satisfy the required `AgentToolResult.details` field.

## [1.1.0] - 2026-05-07

### Changed

- Updated peer dependency and references for the move to `earendil-works/pi-mono` and `@earendil-works/*` package scopes. `@mariozechner/pi-coding-agent` peer dep is now `@earendil-works/pi-coding-agent`.

### Fixed

- Close abort-signal race window when killing bash command handles (signal could fire between handle creation and listener registration).
- Stop the sandbox keepalive timer after 3 consecutive `setTimeout` failures so a dead sandbox no longer keeps polling, and `unref()` the timer so it doesn't block clean Node exit.
- Wrap sandbox connect/create in try/catch so creation errors surface cleanly instead of leaking partial state.

## [1.0.0] - 2026-03-22

_Initial release._

### Added

- Redirect all 7 built-in pi tools (bash, read, write, edit, ls, find, grep) to an E2B cloud sandbox ([`c913892`](https://github.com/edlsh/pi-extension-e2b/commit/c913892))
- `--e2b` flag to enable sandbox execution, `--e2b-sync` to sync local files, `--e2b-template` and `--e2b-sandbox` for template and reconnect support
- `/e2b`, `/e2b-upload`, `/e2b-download`, `/e2b-reconnect` slash commands
- `e2b_port_url` LLM-callable tool to get public URLs for sandbox ports
- `Ctrl+Shift+E` keyboard shortcut to toggle sandbox on/off mid-session
- Automatic keepalive timer extending sandbox timeout every 5 minutes
- File sync via `git archive` with tar fallback for non-git projects
- System prompt injection informing the LLM it's operating in a sandbox
- `user_bash` event hook to redirect `!` shell commands to the sandbox

[1.0.0]: https://github.com/edlsh/pi-extension-e2b/releases/tag/v1.0.0
[1.1.0]: https://github.com/edlsh/pi-extension-e2b/releases/tag/v1.1.0
[1.2.0]: https://github.com/edlsh/pi-extension-e2b/releases/tag/v1.2.0
[2.0.0]: https://github.com/edlsh/pi-extension-e2b/releases/tag/v2.0.0
