# pi-extension-e2b

E2B cloud sandbox integration for [pi](https://github.com/badlogic/pi-mono). Redirects all tool execution (bash, read, write, edit, ls, find, grep) to an [E2B](https://e2b.dev) cloud sandbox, giving the agent a full Linux environment with internet access — completely isolated from your local machine.

## Install

```bash
pi install npm:pi-extension-e2b
```

## Setup

Set your E2B API key:

```bash
export E2B_API_KEY=your_key_here
```

## Usage

```bash
pi --e2b                          # Create new sandbox (no file sync)
pi --e2b --e2b-sync              # Create new sandbox and sync local files
pi --e2b --e2b-template custom    # Use a custom E2B template
pi --e2b --e2b-sandbox <id>       # Reconnect to an existing sandbox
```

## Commands

| Command | Description |
|---------|-------------|
| `/e2b` | Show sandbox status & info |
| `/e2b-upload` | Upload local file(s) to the sandbox |
| `/e2b-download` | Download file(s) from the sandbox |
| `/e2b-reconnect` | Connect to an existing sandbox by ID |

## Keyboard Shortcut

**Ctrl+Shift+E** — Toggle E2B sandbox on/off mid-session.

## LLM-Callable Tools

| Tool | Description |
|------|-------------|
| `e2b_port_url` | Get the public URL for a port running in the sandbox |

## How It Works

When enabled, the extension replaces all 7 built-in pi tools (bash, read, write, edit, ls, find, grep) with E2B-backed implementations that execute in the remote sandbox. File sync uses `git archive` (or tar fallback) to upload your project. A keepalive timer extends the sandbox timeout automatically.

## License

MIT
