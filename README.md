# pi-extension-e2b

E2B cloud sandbox integration for [pi](https://github.com/earendil-works/pi-mono). Redirects all tool execution (bash, read, write, edit, ls, find, grep) to an [E2B](https://e2b.dev) cloud sandbox, giving the agent a full Linux environment with internet access — completely isolated from your local machine.

## Install

```bash
pi install npm:pi-extension-e2b
```

## Setup

Set your E2B API key:

```bash
export E2B_API_KEY=your_key_here
```

## Requirements

- pi `>=0.80.0`
- e2b SDK v2 requires Node `>=20.18.1` when pi runs under Node
- Custom templates built with envd `<0.2.0` must be rebuilt; v2 sandboxes are secure by default

## Usage

```bash
pi --e2b                          # Create new sandbox (no file sync)
pi --e2b --e2b-sync              # Create new sandbox and sync local files
pi --e2b --e2b-persist           # Pause sandbox on session end or timeout
pi --e2b --e2b-template custom    # Use a custom E2B template
pi --e2b --e2b-sandbox <id>       # Reconnect to an existing sandbox
```

## Commands

| Command | Description |
|---------|-------------|
| `/e2b` | Show sandbox status & info |
| `/e2b-upload` | Upload local file(s) to the sandbox |
| `/e2b-download` | Download file(s) from the sandbox |
| `/e2b-pause` | Pause the sandbox and restore local tools |
| `/e2b-list` | List pi-created sandboxes; reconnect or kill one |
| `/e2b-reconnect` | Connect to an existing sandbox by ID |

## Persistence

With `--e2b-persist`, the sandbox is paused instead of killed when the session ends or its timeout fires. Use `/e2b-reconnect <id>` or `/e2b-list` to resume it later; `/e2b-list` can also kill paused sandboxes. Paused sandboxes retain their state but accrue E2B storage charges until they are killed.

## Keyboard Shortcut

**Ctrl+Shift+E** — Toggle E2B sandbox on/off mid-session. With `--e2b-persist`, disabling pauses the sandbox instead of killing it.

## LLM-Callable Tools

| Tool | Description |
|------|-------------|
| `e2b_port_url` | Get the public URL for a port running in the sandbox |

## How It Works

When enabled, the extension replaces all 7 built-in pi tools (bash, read, write, edit, ls, find, grep) with E2B-backed implementations that execute in the remote sandbox. New sandboxes are tagged with `app=pi-e2b` and the local project name for listing. File sync uses `git archive` (or tar fallback) to upload your project. A keepalive timer extends the sandbox timeout automatically.

## License

MIT
