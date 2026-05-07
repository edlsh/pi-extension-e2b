/**
 * E2B Cloud Sandbox Extension for pi
 *
 * Redirects all tool execution (bash, read, write, edit, ls, find, grep) to an
 * E2B cloud sandbox. Optionally syncs the local project directory on startup.
 *
 * Usage:
 *   pi --e2b                          # Create new sandbox (no file sync)
 *   pi --e2b --e2b-sync              # Create new sandbox and sync local files
 *   pi --e2b --e2b-template custom    # Use a custom template
 *   pi --e2b --e2b-sandbox <id>       # Reconnect to an existing sandbox
 *
 * Commands:
 *   /e2b              - Show sandbox status & info
 *   /e2b-upload       - Upload local file(s) to the sandbox
 *   /e2b-download     - Download file(s) from the sandbox
 *   /e2b-reconnect    - Connect to an existing sandbox by ID
 *
 * Custom Tools (LLM-callable):
 *   e2b_port_url      - Get the public URL for a sandbox port
 *
 * Environment:
 *   E2B_API_KEY       - Your E2B API key
 *
 * Setup:
 *   1. Place in ~/.pi/agent/extensions/e2b/
 *   2. Run `npm install` in that directory
 *   3. Set E2B_API_KEY environment variable
 */

import { Sandbox } from "e2b";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	type ReadOperations,
	type WriteOperations,
	type EditOperations,
	type LsOperations,
	type FindOperations,
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	createLsTool,
	createFindTool,
	createGrepTool,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import nodePath from "node:path";

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const REMOTE_PROJECT_DIR = "/home/user/project";
const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // extend every 5 minutes
const CMD_TIMEOUT_MS = 5 * 60 * 1000; // default command timeout: 5 minutes
const GREP_DEFAULT_LIMIT = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// Shell quoting helper
// ═══════════════════════════════════════════════════════════════════════════════

function sq(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ═══════════════════════════════════════════════════════════════════════════════
// E2B Operations – thin adapters over the E2B SDK
// ═══════════════════════════════════════════════════════════════════════════════

function createE2bReadOps(getSandbox: () => Sandbox): ReadOperations {
	return {
		readFile: async (p: string) => {
			const sbx = getSandbox();
			const bytes = await sbx.files.read(p, { format: "bytes" });
			return Buffer.from(bytes);
		},
		access: async (p: string) => {
			const sbx = getSandbox();
			const ok = await sbx.files.exists(p);
			if (!ok) throw new Error(`ENOENT: no such file or directory, access '${p}'`);
		},
		detectImageMimeType: async (p: string) => {
			try {
				const sbx = getSandbox();
				const r = await sbx.commands.run(`file --mime-type -b ${sq(p)}`, { timeoutMs: 10_000 });
				const m = r.stdout.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m)
					? (m as "image/jpeg" | "image/png" | "image/gif" | "image/webp")
					: null;
			} catch {
				return null;
			}
		},
	};
}

function createE2bWriteOps(getSandbox: () => Sandbox): WriteOperations {
	return {
		writeFile: async (p: string, content: string | Buffer) => {
			const sbx = getSandbox();
			if (Buffer.isBuffer(content)) {
				await sbx.files.write(p, new Blob([content]));
			} else {
				await sbx.files.write(p, content);
			}
		},
		mkdir: async (dir: string) => {
			const sbx = getSandbox();
			await sbx.files.makeDir(dir);
		},
	};
}

function createE2bEditOps(getSandbox: () => Sandbox): EditOperations {
	const r = createE2bReadOps(getSandbox);
	const w = createE2bWriteOps(getSandbox);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createE2bBashOps(getSandbox: () => Sandbox): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const sbx = getSandbox();
			const cmd = `cd ${sq(cwd)} && ${command}`;
			const timeoutMs = timeout && timeout > 0 ? timeout * 1000 : CMD_TIMEOUT_MS;

			// Start in background for abort support
			const handle = await sbx.commands.run(cmd, {
				background: true,
				timeoutMs,
				onStdout: (data: string) => onData(Buffer.from(data)),
				onStderr: (data: string) => onData(Buffer.from(data)),
			});

			// Abort handling
			const onAbort = () => {
				handle.kill().catch(() => {});
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			// Close the race window: if signal fired between handle creation and listener registration
			if (signal?.aborted) {
				handle.kill().catch(() => {});
				throw new Error("aborted");
			}

			// Extra timeout guard (in case E2B's built-in timeout doesn't fire)
			let timedOut = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			if (timeout && timeout > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					handle.kill().catch(() => {});
				}, timeout * 1000 + 2000); // 2s grace over E2B timeout
			}

			try {
				// handle.wait() throws CommandExitError on non-zero exit code
				const result = await handle.wait();
				return { exitCode: result.exitCode }; // will be 0
			} catch (err: any) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				// CommandExitError has .exitCode
				if (typeof err?.exitCode === "number") {
					return { exitCode: err.exitCode };
				}
				throw err;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

function createE2bLsOps(getSandbox: () => Sandbox): LsOperations {
	return {
		exists: async (p: string) => {
			const sbx = getSandbox();
			return sbx.files.exists(p);
		},
		stat: async (p: string) => {
			const sbx = getSandbox();
			const exists = await sbx.files.exists(p);
			if (!exists) throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
			const r = await sbx.commands.run(`test -d ${sq(p)} && echo dir || echo file`, { timeoutMs: 10_000 });
			const isDir = r.stdout.trim() === "dir";
			return { isDirectory: () => isDir };
		},
		readdir: async (p: string) => {
			const sbx = getSandbox();
			const entries = await sbx.files.list(p);
			return entries.map((e: any) => e.name);
		},
	};
}

function createE2bFindOps(getSandbox: () => Sandbox): FindOperations {
	return {
		exists: async (p: string) => {
			const sbx = getSandbox();
			return sbx.files.exists(p);
		},
		glob: async (pattern: string, cwd: string, opts: { ignore: string[]; limit: number }) => {
			const sbx = getSandbox();
			const ignoreJson = JSON.stringify(opts.ignore || []);
			// Use Python's glob for reliable recursive glob expansion
			const script = [
				"import glob,sys,os,json,fnmatch",
				"os.chdir(sys.argv[1])",
				"pat=sys.argv[2]; lim=int(sys.argv[3]); ign=json.loads(sys.argv[4])",
				"res=sorted(glob.glob(pat,recursive=True)); c=0",
				"for r in res:",
				"  if c>=lim: break",
				"  skip=any(fnmatch.fnmatch(r,i) for i in ign)",
				"  if not skip: print(os.path.join(sys.argv[1],r)); c+=1",
			].join("\n");
			const result = await sbx.commands.run(
				`python3 -c ${sq(script)} ${sq(cwd)} ${sq(pattern)} ${opts.limit} ${sq(ignoreJson)}`,
				{ timeoutMs: 30_000 },
			);
			return result.stdout.trim().split("\n").filter(Boolean);
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// File sync – tar the local project, upload, extract in sandbox
// ═══════════════════════════════════════════════════════════════════════════════

async function syncLocalToSandbox(
	sbx: Sandbox,
	localCwd: string,
): Promise<{ fileCount: number; size: string }> {
	const tmpTar = nodePath.join(
		process.env.TMPDIR || "/tmp",
		`e2b-sync-${Date.now()}.tar.gz`,
	);

	try {
		const isGitRepo = existsSync(nodePath.join(localCwd, ".git"));

		if (isGitRepo) {
			try {
				execSync(`git archive --format=tar HEAD | gzip > ${sq(tmpTar)}`, {
					cwd: localCwd,
					stdio: "pipe",
					timeout: 120_000,
				});
			} catch {
				// Fallback if git archive fails (maybe no commits yet)
				execSync(
					`tar -czf ${sq(tmpTar)} --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='dist' --exclude='build' --exclude='__pycache__' --exclude='.venv' --exclude='venv' -C ${sq(localCwd)} .`,
					{ stdio: "pipe", timeout: 120_000 },
				);
			}
		} else {
			execSync(
				`tar -czf ${sq(tmpTar)} --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='dist' --exclude='build' --exclude='__pycache__' --exclude='.venv' --exclude='venv' -C ${sq(localCwd)} .`,
				{ stdio: "pipe", timeout: 120_000 },
			);
		}

		const tarBuffer = readFileSync(tmpTar);
		const sizeStr = formatSize(tarBuffer.length);

		// Upload archive
		await sbx.files.write("/tmp/project-sync.tar.gz", new Blob([tarBuffer]));

		// Create project dir and extract
		await sbx.commands.run(
			`mkdir -p ${REMOTE_PROJECT_DIR} && tar -xzf /tmp/project-sync.tar.gz -C ${REMOTE_PROJECT_DIR} && rm -f /tmp/project-sync.tar.gz`,
			{ timeoutMs: 60_000 },
		);

		// Count files
		let fileCount = 0;
		try {
			const countResult = await sbx.commands.run(
				`find ${REMOTE_PROJECT_DIR} -type f 2>/dev/null | wc -l`,
				{ timeoutMs: 10_000 },
			);
			fileCount = parseInt(countResult.stdout.trim()) || 0;
		} catch {
			// non-critical
		}

		return { fileCount, size: sizeStr };
	} finally {
		try {
			if (existsSync(tmpTar)) unlinkSync(tmpTar);
		} catch {}
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Safe UI helpers – prevent crashes when ctx.hasUI is false
// ═══════════════════════════════════════════════════════════════════════════════

function safeThemeFg(ctx: { ui: any; hasUI?: boolean }, color: string, text: string): string {
	try {
		return ctx.ui?.theme?.fg?.(color, text) ?? text;
	} catch {
		return text;
	}
}

function safeNotify(ctx: { ui: any; hasUI?: boolean }, message: string, level: string) {
	try {
		if ((ctx as any).hasUI !== false) {
			ctx.ui.notify(message, level);
		}
	} catch {}
}

function safeSetStatus(ctx: { ui: any; hasUI?: boolean }, key: string, text: string | undefined) {
	try {
		if ((ctx as any).hasUI !== false) {
			ctx.ui.setStatus(key, text);
		}
	} catch {}
}

function safeSetWidget(ctx: { ui: any; hasUI?: boolean }, key: string, content: string[] | undefined) {
	try {
		if ((ctx as any).hasUI !== false) {
			ctx.ui.setWidget(key, content);
		}
	} catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	// ── Flags ──────────────────────────────────────────────────────────────────

	pi.registerFlag("e2b", {
		description: "Enable E2B cloud sandbox execution",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("e2b-template", {
		description: "E2B sandbox template to use (default: base)",
		type: "string",
	});

	pi.registerFlag("e2b-sandbox", {
		description: "Connect to an existing E2B sandbox by ID",
		type: "string",
	});

	pi.registerFlag("e2b-sync", {
		description: "Sync local project files to the sandbox on startup (default: false)",
		type: "boolean",
		default: false,
	});

	// ── Shared state ───────────────────────────────────────────────────────────

	const localCwd = process.cwd();

	let sandbox: Sandbox | null = null;
	let sandboxEnabled = false;
	let sandboxId: string | null = null;
	let sandboxTemplate: string | null = null;
	let startedAt: Date | null = null;
	let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

	const getSandbox = (): Sandbox => {
		if (!sandbox) throw new Error("E2B sandbox not initialised");
		return sandbox;
	};

	// Helper: start keepalive timer
	function startKeepalive() {
		stopKeepalive();
		let consecutiveFailures = 0;
		keepaliveTimer = setInterval(async () => {
			if (sandbox) {
				try {
					await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
					consecutiveFailures = 0;
				} catch {
					consecutiveFailures++;
					if (consecutiveFailures >= 3) {
						// Sandbox is likely dead — stop polling
						stopKeepalive();
					}
				}
			}
		}, KEEPALIVE_INTERVAL_MS);
		// Don't prevent Node from exiting cleanly
		if (typeof keepaliveTimer === "object" && keepaliveTimer && "unref" in keepaliveTimer) {
			(keepaliveTimer as NodeJS.Timeout).unref();
		}
	}

	function stopKeepalive() {
		if (keepaliveTimer) {
			clearInterval(keepaliveTimer);
			keepaliveTimer = null;
		}
	}

	// Helper: update the persistent widget above the editor
	function updateWidget(ctx: { ui: any; hasUI?: boolean }) {
		if (sandboxEnabled && sandboxId) {
			const uptime = startedAt
				? `${Math.floor((Date.now() - startedAt.getTime()) / 60000)}m`
				: "?";
			safeSetWidget(ctx, "e2b",
				[`󰅟 E2B Sandbox: ${sandboxId} (${sandboxTemplate}, ${uptime}) — Ctrl+Shift+E to disable`],
			);
		} else {
			safeSetWidget(ctx, "e2b",
				[`󰌢 Local mode — Ctrl+Shift+E to enable E2B sandbox`],
			);
		}
	}

	// Helper: restore all 7 built-in tools to local execution
	function restoreLocalTools() {
		pi.registerTool({ ...createReadTool(localCwd) });
		pi.registerTool({ ...createWriteTool(localCwd) });
		pi.registerTool({ ...createEditTool(localCwd) });
		pi.registerTool({ ...createBashTool(localCwd), label: "bash" });
		pi.registerTool({ ...createLsTool(localCwd) });
		pi.registerTool({ ...createFindTool(localCwd) });
		pi.registerTool({ ...createGrepTool(localCwd) });
	}

	// Helper: tear down the sandbox
	async function teardownSandbox(ctx: { ui: any; hasUI?: boolean }) {
		stopKeepalive();
		if (sandbox) {
			try {
				await sandbox.kill();
			} catch {}
		}
		sandbox = null;
		sandboxEnabled = false;
		sandboxId = null;
		sandboxTemplate = null;
		startedAt = null;

		restoreLocalTools();

		safeSetStatus(ctx, "e2b", undefined);
		updateWidget(ctx);
		safeNotify(ctx, "E2B sandbox disabled — tools restored to local execution.", "info");
	}

	// Helper: initialise sandbox & register tools
	async function initialiseSandbox(
		apiKey: string,
		template: string | undefined,
		existingSandboxId: string | undefined,
		ctx: { ui: any; hasUI?: boolean },
		syncFiles: boolean = false,
	) {
		try {
			// 1. Create or reconnect ─────────────────────────────────────────────────

			if (existingSandboxId) {
				safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "warning", `󰑓 E2B: Connecting to ${existingSandboxId}…`));
				sandbox = await Sandbox.connect(existingSandboxId, { apiKey });
				sandboxId = existingSandboxId;
				sandboxTemplate = "reconnected";
			} else {
				sandboxTemplate = template || "base";
				safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "warning", `󰑓 E2B: Creating ${sandboxTemplate} sandbox…`));
				sandbox = template
					? await Sandbox.create(template, { apiKey, timeoutMs: SANDBOX_TIMEOUT_MS })
					: await Sandbox.create({ apiKey, timeoutMs: SANDBOX_TIMEOUT_MS });
				sandboxId = sandbox.sandboxId;
			}

			startedAt = new Date();
			sandboxEnabled = true;

			// Ensure remote project directory exists (even without file sync)
			await sandbox.commands.run(`mkdir -p ${REMOTE_PROJECT_DIR}`, { timeoutMs: 10_000 });

			// 2. Sync files (only when --e2b-sync is passed) ────────────────────────

			if (syncFiles) {
				safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "warning", `󰑓 E2B: Syncing files to ${sandboxId}…`));
				try {
					const sync = await syncLocalToSandbox(sandbox, localCwd);
					safeNotify(ctx, `E2B Sandbox ready! (${sandboxId})\n  󰉋 ${sync.fileCount} files synced (${sync.size})`, "info");
				} catch (syncErr) {
					safeNotify(ctx,
						`E2B sandbox ready but file sync failed: ${syncErr instanceof Error ? syncErr.message : syncErr}\nUse /e2b-upload to sync files manually.`,
						"warning",
					);
				}
			} else {
				safeNotify(ctx, `E2B Sandbox ready! (${sandboxId})\n  󰉋 No file sync (use --e2b-sync or /e2b-upload to sync files)`, "info");
			}

			// 3. Install ripgrep (for grep tool) ─────────────────────────────────────

			try {
				await sandbox.commands.run(
					"which rg >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq ripgrep >/dev/null 2>&1)",
					{ timeoutMs: 120_000 },
				);
			} catch {
				// grep will fall back to plain grep
			}

			// 4. Register tool overrides ─────────────────────────────────────────────

			const remoteCwd = REMOTE_PROJECT_DIR;

			pi.registerTool({
				...createReadTool(remoteCwd, { operations: createE2bReadOps(getSandbox) }),
				label: "read (E2B)",
			});

			pi.registerTool({
				...createWriteTool(remoteCwd, { operations: createE2bWriteOps(getSandbox) }),
				label: "write (E2B)",
			});

			pi.registerTool({
				...createEditTool(remoteCwd, { operations: createE2bEditOps(getSandbox) }),
				label: "edit (E2B)",
			});

			pi.registerTool({
				...createBashTool(remoteCwd, { operations: createE2bBashOps(getSandbox) }),
				label: "bash (E2B)",
			});

			pi.registerTool({
				...createLsTool(remoteCwd, { operations: createE2bLsOps(getSandbox) }),
				label: "ls (E2B)",
			});

			pi.registerTool({
				...createFindTool(remoteCwd, { operations: createE2bFindOps(getSandbox) }),
				label: "find (E2B)",
			});

			// Grep – full override (built-in grep spawns local rg, won't reach sandbox)
			pi.registerTool({
				name: "grep",
				label: "grep (E2B)",
				description: `Search file contents for a pattern inside the E2B sandbox. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to 500 chars.`,
				parameters: Type.Object({
					pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
					path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
					glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
					ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
					literal: Type.Optional(
						Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
					),
					context: Type.Optional(
						Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
					),
					limit: Type.Optional(
						Type.Number({ description: "Maximum number of matches to return (default: 100)" }),
					),
				}),
				async execute(
					_toolCallId: string,
					params: {
						pattern: string;
						path?: string;
						glob?: string;
						ignoreCase?: boolean;
						literal?: boolean;
						context?: number;
						limit?: number;
					},
					signal?: AbortSignal,
				) {
					if (signal?.aborted) throw new Error("Operation aborted");

					const sbx = getSandbox();
					const limit = params.limit ?? GREP_DEFAULT_LIMIT;
					const searchPath = params.path
						? params.path.startsWith("/")
							? params.path
							: `${remoteCwd}/${params.path.replace(/^@/, "")}`
						: remoteCwd;

					// Build rg args
					const args: string[] = ["--line-number", "--color=never", "--hidden"];
					if (params.ignoreCase) args.push("--ignore-case");
					if (params.literal) args.push("--fixed-strings");
					if (params.glob) args.push("--glob", sq(params.glob));
					if (params.context && params.context > 0) args.push(`-C${params.context}`);
					args.push(`-m${limit}`);
					args.push("--", sq(params.pattern), sq(searchPath));

					// Fallback: grep -rn
					const fallbackArgs: string[] = ["-rn"];
					if (params.ignoreCase) fallbackArgs.push("-i");
					if (params.literal) fallbackArgs.push("-F");
					fallbackArgs.push(sq(params.pattern), sq(searchPath));

					const cmd = `(rg ${args.join(" ")} 2>/dev/null || grep ${fallbackArgs.join(" ")} 2>/dev/null) | head -n ${limit}; true`;

					let output: string;
					try {
						const result = await sbx.commands.run(cmd, { timeoutMs: 30_000 });
						output = (result.stdout || "").trim();
					} catch (err: any) {
						output = (typeof err?.stdout === "string" ? err.stdout : "").trim();
					}

					if (!output) {
						return { content: [{ type: "text" as const, text: "No matches found" }] };
					}

					// Relativise paths
					const prefix = searchPath.endsWith("/") ? searchPath : searchPath + "/";
					const lines = output.split("\n").map((line: string) => {
						if (line.startsWith(prefix)) return line.slice(prefix.length);
						return line;
					});

					const raw = lines.join("\n");
					const truncation = truncateHead(raw, { maxLines: DEFAULT_MAX_LINES });
					let text = truncation.content;

					if (truncation.truncated) {
						text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`;
					}

					return { content: [{ type: "text" as const, text }] };
				},
			});

			// 5. e2b_port_url – LLM-callable ─────────────────────────────────────────

			pi.registerTool({
				name: "e2b_port_url",
				label: "E2B Port URL",
				description:
					"Get the public URL to access a port running inside the E2B sandbox (e.g. for web servers, APIs, databases).",
				promptSnippet: "Get public URL for an E2B sandbox port (web servers, APIs)",
				parameters: Type.Object({
					port: Type.Number({ description: "Port number running in the sandbox", minimum: 1, maximum: 65535 }),
				}),
				async execute(_toolCallId: string, params: { port: number }) {
					if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65535) {
						throw new Error(`Invalid port number: ${params.port} (must be 1-65535)`);
					}
					const sbx = getSandbox();
					const host = sbx.getHost(params.port);
					return {
						content: [{ type: "text" as const, text: `https://${host}` }],
						details: { port: params.port, host },
					};
				},
			});

			// 6. Keepalive ───────────────────────────────────────────────────────────

			startKeepalive();

			safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "accent", `󰅟 E2B: ${sandboxId} (${sandboxTemplate})`));
			updateWidget(ctx);
		} catch (initErr) {
			// Sandbox may or may not have been created — kill it if it exists
			stopKeepalive();
			if (sandbox) {
				try { await sandbox.kill(); } catch {}
			}
			sandbox = null;
			sandboxEnabled = false;
			sandboxId = null;
			sandboxTemplate = null;
			startedAt = null;
			throw initErr;
		}
	}

	// ── Keyboard shortcut: Ctrl+Shift+E to toggle ──────────────────────────────

	pi.registerShortcut("ctrl+shift+e", {
		description: "Toggle E2B cloud sandbox on/off",
		handler: async (ctx) => {
			if (sandboxEnabled && sandbox) {
				// ── Disable ─────────────────────────────────────────────────────
				const ok = await ctx.ui.confirm(
					"Disable E2B Sandbox?",
					`Kill sandbox ${sandboxId} and restore local tools?`,
				);
				if (!ok) return;
				await teardownSandbox(ctx);
			} else {
				// ── Enable ──────────────────────────────────────────────────────
				const apiKey = process.env.E2B_API_KEY;
				if (!apiKey) {
					safeNotify(ctx, "E2B_API_KEY environment variable is not set!", "error");
					return;
				}

				const template = pi.getFlag("e2b-template") as string | undefined;

				safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "warning", "󰑓 E2B: Starting sandbox…"));
				updateWidget(ctx);

				try {
					await initialiseSandbox(apiKey, template, undefined, ctx, pi.getFlag("e2b-sync") as boolean);
					safeNotify(ctx, `E2B sandbox enabled! (${sandboxId})`, "info");
				} catch (err) {
					sandboxEnabled = false;
					sandbox = null;
					safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "error", "󰅙 E2B: Failed"));
					updateWidget(ctx);
					safeNotify(ctx,
						`E2B sandbox failed: ${err instanceof Error ? err.message : err}`,
						"error",
					);
				}
			}
		},
	});

	// ── Events ─────────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const e2bFlag = pi.getFlag("e2b") as boolean;
		const template = pi.getFlag("e2b-template") as string | undefined;
		const existingSandboxId = pi.getFlag("e2b-sandbox") as string | undefined;

		updateWidget(ctx);

		if (!e2bFlag && !existingSandboxId) return;

		const apiKey = process.env.E2B_API_KEY;
		if (!apiKey) {
			safeNotify(ctx, "E2B_API_KEY environment variable is not set!", "error");
			return;
		}

		try {
			const syncFiles = pi.getFlag("e2b-sync") as boolean;
			await initialiseSandbox(apiKey, template, existingSandboxId, ctx, syncFiles);
		} catch (err) {
			sandboxEnabled = false;
			sandbox = null;
			safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "error", "󰅙 E2B: Failed to initialise"));
			updateWidget(ctx);
			safeNotify(ctx,
				`E2B sandbox initialisation failed: ${err instanceof Error ? err.message : err}`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		stopKeepalive();
		if (sandbox && sandboxEnabled) {
			try {
				await sandbox.kill();
			} catch {}
			sandbox = null;
			sandboxEnabled = false;
			sandboxId = null;
			sandboxTemplate = null;
			startedAt = null;
		}
	});

	// Redirect user ! commands to the sandbox
	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandbox) return;
		return { operations: createE2bBashOps(getSandbox) };
	});

	// Replace local CWD with remote CWD in system prompt
	pi.on("before_agent_start", async (event) => {
		if (!sandboxEnabled || !sandbox) return;
		let sp = event.systemPrompt;
		sp = sp.replace(
			`Current working directory: ${localCwd}`,
			`Current working directory: ${REMOTE_PROJECT_DIR} (E2B Cloud Sandbox: ${sandboxId})`,
		);
		return {
			systemPrompt:
				sp +
				`\n\nYou are operating inside an E2B cloud sandbox (ID: ${sandboxId}). All file operations and commands execute in the remote sandbox, not on the local machine. The sandbox is a full Linux environment with internet access. Use the e2b_port_url tool to get public URLs for any ports you start.`,
		};
	});

	// ── Commands ────────────────────────────────────────────────────────────────

	pi.registerCommand("e2b", {
		description: "Show E2B sandbox status and info",
		handler: async (_args, ctx) => {
			if (!sandboxEnabled || !sandbox) {
				safeNotify(ctx, "E2B sandbox is not active. Use --e2b flag to enable.", "info");
				return;
			}

			const uptime = startedAt
				? `${Math.floor((Date.now() - startedAt.getTime()) / 60000)} minutes`
				: "unknown";

			let runningProcs = "?";
			try {
				const procs = await sandbox.commands.list();
				runningProcs = String(procs.length);
			} catch {}

			const lines = [
				"󰅟 E2B Sandbox Status",
				"",
				`  ID:         ${sandboxId}`,
				`  Template:   ${sandboxTemplate}`,
				`  Started:    ${startedAt?.toISOString() || "unknown"}`,
				`  Uptime:     ${uptime}`,
				`  Remote CWD: ${REMOTE_PROJECT_DIR}`,
				`  Processes:  ${runningProcs}`,
				"",
				"  Commands:",
				"    /e2b-upload [local-path]               Re-sync all or upload specific file",
				"    /e2b-download <remote-path> [local]    Download file from sandbox",
				"    /e2b-reconnect <sandbox-id>            Reconnect to another sandbox",
			];
			safeNotify(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("e2b-upload", {
		description: "Upload local file(s) to the E2B sandbox (no args = re-sync project)",
		handler: async (args, ctx) => {
			if (!sandbox || !sandboxEnabled) {
				safeNotify(ctx, "E2B sandbox not active", "error");
				return;
			}

			if (!args?.trim()) {
				safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "warning", "󰑓 E2B: Re-syncing files…"));
				try {
					const sync = await syncLocalToSandbox(sandbox, localCwd);
					safeNotify(ctx, `Synced ${sync.fileCount} files (${sync.size})`, "info");
				} catch (err) {
					safeNotify(ctx, `Sync failed: ${err instanceof Error ? err.message : err}`, "error");
				}
				safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "accent", `󰅟 E2B: ${sandboxId} (${sandboxTemplate})`));
				return;
			}

			const parts = args.trim().split(/\s+/);
			const localPath = nodePath.resolve(localCwd, parts[0]);
			if (!localPath.startsWith(localCwd + nodePath.sep) && localPath !== localCwd) {
				safeNotify(ctx, `Path escapes project directory: ${parts[0]}`, "error");
				return;
			}
			const remotePath = parts[1] || `${REMOTE_PROJECT_DIR}/${parts[0]}`;
			if (!existsSync(localPath)) {
				safeNotify(ctx, `Local file not found: ${localPath}`, "error");
				return;
			}

			try {
				const content = readFileSync(localPath);
				// Ensure parent directory exists on remote
				const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
				if (remoteDir) {
					await sandbox.commands.run(`mkdir -p ${sq(remoteDir)}`, { timeoutMs: 10_000 });
				}
				await sandbox.files.write(remotePath, new Blob([content]));
				safeNotify(ctx, `Uploaded: ${parts[0]} → ${remotePath} (${formatSize(content.length)})`, "info");
			} catch (err) {
				safeNotify(ctx, `Upload failed: ${err instanceof Error ? err.message : err}`, "error");
			}
		},
	});

	pi.registerCommand("e2b-download", {
		description: "Download file(s) from the E2B sandbox to local machine",
		handler: async (args, ctx) => {
			if (!sandbox || !sandboxEnabled) {
				safeNotify(ctx, "E2B sandbox not active", "error");
				return;
			}

			if (!args?.trim()) {
				safeNotify(ctx, "Usage: /e2b-download <remote-path> [local-path]", "info");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const remotePath = parts[0].startsWith("/") ? parts[0] : `${REMOTE_PROJECT_DIR}/${parts[0]}`;
			const localPath = nodePath.resolve(localCwd, parts[1] || parts[0]);
			if (!localPath.startsWith(localCwd + nodePath.sep) && localPath !== localCwd) {
				safeNotify(ctx, `Path escapes project directory: ${parts[1] || parts[0]}`, "error");
				return;
			}

			try {
				const bytes = await sandbox.files.read(remotePath, { format: "bytes" });
				mkdirSync(nodePath.dirname(localPath), { recursive: true });
				writeFileSync(localPath, Buffer.from(bytes));
				safeNotify(ctx, `Downloaded: ${remotePath} → ${localPath} (${formatSize(bytes.length)})`, "info");
			} catch (err) {
				safeNotify(ctx, `Download failed: ${err instanceof Error ? err.message : err}`, "error");
			}
		},
	});

	pi.registerCommand("e2b-reconnect", {
		description: "Connect to an existing E2B sandbox by ID",
		handler: async (args, ctx) => {
			const newId = args?.trim();
			if (!newId) {
				safeNotify(ctx, "Usage: /e2b-reconnect <sandbox-id>", "info");
				return;
			}

			const apiKey = process.env.E2B_API_KEY;
			if (!apiKey) {
				safeNotify(ctx, "E2B_API_KEY not set", "error");
				return;
			}

			// Tear down old sandbox if active
			if (sandbox && sandboxEnabled) {
				await teardownSandbox(ctx);
			}

			try {
				await initialiseSandbox(apiKey, undefined, newId, ctx, false);
			} catch (err) {
				sandboxEnabled = false;
				sandbox = null;
				safeSetStatus(ctx, "e2b", safeThemeFg(ctx, "error", "󰅙 E2B: Connection failed"));
				updateWidget(ctx);
				safeNotify(ctx, `Failed to connect: ${err instanceof Error ? err.message : err}`, "error");
			}
		},
	});
}
