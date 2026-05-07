# Changelog

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
