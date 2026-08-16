/**
 * Subtask extension - fork the current conversation into a background subagent.
 *
 * `/subtask <task>` snapshots the current conversation (system prompt, model,
 * thinking level, and full message history up to this point) into a new session
 * file, then spawns a background `pi` process on that snapshot to work on the
 * task. The fork's tool calls stay in its own transcript; only its final result
 * is delivered back into this conversation as a message. Meanwhile you keep
 * working in the main session.
 *
 * This is a conversational fork, not a fresh subagent: the child sees
 * everything the main session saw at the moment it spawned (snapshot, not
 * continuous sync - later parent messages don't reach the fork). Because the
 * child's system prompt and history are identical to the parent's, its first
 * request can reuse the parent's provider-side prompt cache.
 *
 * Commands:
 *   /subtask <task>   Start a fork working on <task> in the background
 *   /subtasks         Manage forks: steer, follow up, stop, view output, dismiss
 *
 * Notes:
 * - Running forks appear in a panel below the editor.
 * - A fork's transcript is a normal session file: resume it any time with
 *   `pi --session <file>`. Follow-ups from /subtasks respawn it in place.
 *   With --no-session parents, snapshots go to a temp dir and are cleaned up.
 * - Config flags from the parent invocation (tool restrictions, -e extensions,
 *   system-prompt additions, trust overrides) are forwarded to the child.
 * - Forks share your checkout. Safe for read-only investigation; for parallel
 *   edits, constrain each fork to non-overlapping files.
 * - A fork can't spawn further forks (PI_SUBTASK_CHILD guard).
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

const DONE_ROW_LINGER_MS = 5_000;
const FAILED_ROW_LINGER_MS = 30_000;
const MAX_RETAINED_FINISHED = 20;
const RESULT_CAP_BYTES = 50 * 1024;
const KILL_GRACE_MS = 3_000;

interface ForkUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface Fork {
	id: number;
	name: string;
	task: string;
	sessionFile: string;
	proc: ChildProcess | null;
	status: "starting" | "running" | "done" | "failed" | "stopped";
	activity: string;
	finalText: string;
	errorText: string;
	usage: ForkUsage;
	startedAt: number;
	/** Set when the child accepted our prompt command. */
	promptAccepted: boolean;
	/** Set when the child's agent loop actually started. */
	agentStarted: boolean;
	/** Guards against double completion (settle event + process exit). */
	completed: boolean;
	/** Set when the fork finishes; used to age rows out of the widget. */
	finishedAt?: number;
	/** Temp dir holding the snapshot when the parent session is ephemeral. */
	tempDir?: string;
	lingerTimer?: ReturnType<typeof setTimeout>;
}

interface SubtaskResultDetails {
	name: string;
	task: string;
	status: Fork["status"];
	sessionFile: string;
	usage: ForkUsage;
	elapsedMs: number;
}

function forkName(task: string): string {
	const words = task.trim().split(/\s+/).slice(0, 4).join(" ");
	return words.length > 32 ? `${words.slice(0, 32)}...` : words;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: ForkUsage): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function statusIcon(status: Fork["status"]): string {
	switch (status) {
		case "starting":
			return "○";
		case "running":
			return "◐";
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "stopped":
			return "■";
	}
}

function formatActivity(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return `$ ${String(args.command ?? "").slice(0, 50)}`;
		case "read":
		case "write":
		case "edit":
			return `${toolName} ${path.basename(String(args.file_path ?? args.path ?? ""))}`;
		case "grep":
			return `grep /${String(args.pattern ?? "").slice(0, 30)}/`;
		default: {
			const preview = JSON.stringify(args ?? {});
			return `${toolName} ${preview.length > 40 ? `${preview.slice(0, 40)}...` : preview}`;
		}
	}
}

function lastAssistantText(msg: Message): string {
	if (msg.role !== "assistant") return "";
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function capResult(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= RESULT_CAP_BYTES) return text;
	let truncated = text.slice(0, RESULT_CAP_BYTES);
	while (Buffer.byteLength(truncated, "utf8") > RESULT_CAP_BYTES) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Truncated. Full transcript in the fork's session file.]`;
}

/**
 * Resolve how to spawn a child pi process, mirroring how this one was started
 * (dev entry script, compiled binary, or `pi` on PATH).
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		// Keep execArgv so loader flags (e.g. tsx via ./pi-test.sh) survive the respawn.
		return { command: process.execPath, args: [...process.execArgv, currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/**
 * CLI flags to carry over from the parent invocation so the child runs with
 * the same configuration (tool restrictions, extra extensions, system-prompt
 * additions, trust overrides), not just the same transcript.
 */
const FORWARDED_VALUE_FLAGS = new Set([
	"--provider",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--session-dir",
]);
const FORWARDED_BOOL_FLAGS = new Set([
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-context-files",
	"-nc",
	"--approve",
	"-a",
	"--no-approve",
	"-na",
	"--offline",
]);

function parentConfigArgs(): string[] {
	const argv = process.argv.slice(2);
	const forwarded: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (FORWARDED_BOOL_FLAGS.has(arg)) {
			forwarded.push(arg);
		} else if (FORWARDED_VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
			forwarded.push(arg, argv[++i]);
		}
	}
	return forwarded;
}

/**
 * Write the current conversation branch to a new session file: the snapshot
 * the fork starts from. Mirrors SessionManager.createBranchedSession() but
 * without mutating the live session: copies the root-to-leaf path (including
 * model/thinking/compaction entries, minus label bookmarks), re-chains
 * parentIds, and records the parent session in the header.
 */
function writeSnapshot(ctx: ExtensionContext): { file: string; tempDir?: string } {
	const header = ctx.sessionManager.getHeader();
	const branch = ctx.sessionManager.getBranch();
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	const rawSessionDir = ctx.sessionManager.getSessionDir();

	// An ephemeral parent (--no-session) has no session dir; keep its fork
	// snapshots out of the project and off the normal session list.
	const ephemeral = !parentSessionFile || !rawSessionDir;
	const sessionDir = ephemeral ? fs.mkdtempSync(path.join(os.tmpdir(), "pi-subtask-")) : path.resolve(rawSessionDir);
	if (!ephemeral) fs.mkdirSync(sessionDir, { recursive: true });

	const id = uuidv7();
	const timestamp = new Date().toISOString();
	const file = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);

	const lines: string[] = [JSON.stringify({ ...header, id, timestamp, parentSession: parentSessionFile })];
	let parentId: string | null = null;
	for (const entry of branch) {
		if (entry.type === "label") continue;
		lines.push(JSON.stringify({ ...entry, parentId }));
		parentId = entry.id;
	}
	fs.writeFileSync(file, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
	return { file, tempDir: ephemeral ? sessionDir : undefined };
}

export default function (pi: ExtensionAPI) {
	// A fork can't spawn further forks.
	if (process.env.PI_SUBTASK_CHILD === "1") return;

	const forks = new Map<number, Fork>();
	let nextId = 1;
	let lastCtx: ExtensionContext | undefined;

	// ---------------------------------------------------------------- widget

	function widgetRows(): Fork[] {
		// Finished rows age out of the widget but stay available in /subtasks.
		return [...forks.values()].filter((f) => {
			if (!f.finishedAt) return true;
			const linger = f.status === "done" ? DONE_ROW_LINGER_MS : FAILED_ROW_LINGER_MS;
			return Date.now() - f.finishedAt < linger;
		});
	}

	function renderWidget() {
		if (!lastCtx?.hasUI) return;
		try {
			const rows = widgetRows();
			if (rows.length === 0) {
				lastCtx.ui.setWidget("subtasks", undefined);
				return;
			}
			const lines = rows.map((f) => {
				const elapsed = Math.round((Date.now() - f.startedAt) / 1000);
				const usage = formatUsage(f.usage);
				const activity = f.status === "running" || f.status === "starting" ? f.activity : f.status;
				return `${statusIcon(f.status)} ${f.name} · ${activity}${usage ? ` · ${usage}` : ""} · ${elapsed}s`;
			});
			lastCtx.ui.setWidget("subtasks", [`subtasks (${rows.length}) — /subtasks to manage`, ...lines], {
				placement: "belowEditor",
			});
		} catch {
			// UI context can go stale across session replacement; drop the update.
		}
	}

	function removeFork(fork: Fork) {
		if (fork.lingerTimer) clearTimeout(fork.lingerTimer);
		if (fork.tempDir) {
			try {
				fs.rmSync(fork.tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
		forks.delete(fork.id);
	}

	/** Keep finished forks resumable, but bound how many we retain. */
	function trimRetainedForks() {
		const finished = [...forks.values()].filter((f) => f.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!);
		while (finished.length > MAX_RETAINED_FINISHED) {
			removeFork(finished.shift()!);
		}
	}

	// ------------------------------------------------------------- lifecycle

	function deliverResult(fork: Fork) {
		const elapsedMs = Date.now() - fork.startedAt;
		const details: SubtaskResultDetails = {
			name: fork.name,
			task: fork.task,
			status: fork.status,
			sessionFile: fork.sessionFile,
			usage: fork.usage,
			elapsedMs,
		};
		const body =
			fork.status === "done"
				? capResult(fork.finalText || "(no output)")
				: `The fork ${fork.status === "stopped" ? "was stopped" : "failed"}.${fork.errorText ? `\n\nError:\n${capResult(fork.errorText)}` : ""}${fork.finalText ? `\n\nPartial output:\n${capResult(fork.finalText)}` : ""}`;
		try {
			pi.sendMessage(
				{
					customType: "subtask-result",
					content: `A background subtask forked from this conversation has finished.\n\nTask: ${fork.task}\nStatus: ${fork.status}\n\nResult:\n${body}`,
					display: true,
					details,
				},
				{ triggerTurn: true },
			);
		} catch (err) {
			console.error("subtask: failed to deliver result:", err);
		}
	}

	function completeFork(fork: Fork, status: "done" | "failed" | "stopped") {
		if (fork.completed) return;
		fork.completed = true;
		fork.status = status;
		const proc = fork.proc;
		fork.proc = null;
		if (proc && proc.exitCode === null) {
			try {
				proc.stdin?.end();
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
			}, KILL_GRACE_MS);
			proc.kill("SIGTERM");
		}
		if (status !== "stopped") deliverResult(fork);
		// The fork stays in the map (resumable via /subtasks) but its widget row
		// ages out; schedule a refresh so the row disappears without new events.
		fork.finishedAt = Date.now();
		trimRetainedForks();
		if (fork.lingerTimer) clearTimeout(fork.lingerTimer);
		const linger = status === "done" ? DONE_ROW_LINGER_MS : FAILED_ROW_LINGER_MS;
		fork.lingerTimer = setTimeout(renderWidget, linger + 100);
		renderWidget();
	}

	function spawnFork(fork: Fork, cwd: string, prompt: string) {
		const invocation = getPiInvocation(["--mode", "rpc", "--session", fork.sessionFile, ...parentConfigArgs()]);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			env: { ...process.env, PI_SUBTASK_CHILD: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		fork.proc = proc;
		fork.status = "starting";
		fork.activity = "starting...";
		fork.completed = false;
		fork.promptAccepted = false;
		fork.agentStarted = false;
		fork.errorText = "";
		fork.finishedAt = undefined;
		let stderr = "";
		let buffer = "";
		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");

		const handleEvent = (event: Record<string, unknown>) => {
			switch (event.type) {
				case "response": {
					if (event.command === "prompt") {
						if (event.success) {
							fork.promptAccepted = true;
							fork.status = "running";
						} else {
							fork.errorText = String(event.error ?? "prompt rejected");
							completeFork(fork, "failed");
						}
					}
					break;
				}
				case "agent_start":
					fork.agentStarted = true;
					fork.status = "running";
					break;
				case "tool_execution_start":
					fork.activity = formatActivity(
						String(event.toolName ?? "tool"),
						(event.args as Record<string, unknown>) ?? {},
					);
					break;
				case "message_end": {
					const msg = event.message as Message | undefined;
					if (msg?.role === "assistant") {
						fork.usage.turns++;
						const usage = msg.usage as Usage | undefined;
						if (usage) {
							fork.usage.input += usage.input || 0;
							fork.usage.output += usage.output || 0;
							fork.usage.cacheRead += usage.cacheRead || 0;
							fork.usage.cacheWrite += usage.cacheWrite || 0;
							fork.usage.cost += usage.cost?.total || 0;
						}
						const text = lastAssistantText(msg);
						if (text) {
							fork.finalText = text;
							fork.activity = text.split("\n")[0].slice(0, 50);
						}
						// A later successful message clears the error from a retried turn.
						if (msg.stopReason === "error") fork.errorText = msg.errorMessage ?? "LLM error";
						else fork.errorText = "";
					}
					break;
				}
				case "agent_settled": {
					if (fork.promptAccepted && fork.agentStarted) {
						completeFork(fork, fork.errorText ? "failed" : "done");
					}
					break;
				}
				case "extension_ui_request": {
					// A child extension asked for user input; the fork is headless, so
					// cancel the dialog instead of letting the child block forever.
					const method = event.method;
					if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
						proc.stdin?.write(
							`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`,
						);
					}
					break;
				}
			}
			renderWidget();
		};

		proc.stdout.on("data", (data: string) => {
			buffer += data;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					handleEvent(JSON.parse(line));
				} catch {
					/* skip malformed line */
				}
			}
		});
		proc.stderr.on("data", (data: string) => {
			stderr += data;
		});
		proc.on("close", (code) => {
			if (!fork.completed) {
				if (code !== 0 && !fork.errorText) fork.errorText = stderr.trim() || `pi exited with code ${code}`;
				completeFork(fork, fork.status === "stopped" ? "stopped" : code === 0 ? "done" : "failed");
			}
		});
		proc.on("error", (err) => {
			if (!fork.completed) {
				fork.errorText = `failed to spawn pi: ${err.message}`;
				completeFork(fork, "failed");
			}
		});

		proc.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
	}

	function sendToFork(fork: Fork, message: string, cwd: string) {
		if (fork.proc && !fork.completed) {
			// Running: queue as steering input on the live child.
			fork.proc.stdin?.write(`${JSON.stringify({ type: "prompt", message, streamingBehavior: "steer" })}\n`);
			return;
		}
		// Finished: resume the fork's session file with a fresh process.
		if (fork.lingerTimer) clearTimeout(fork.lingerTimer);
		fork.usage.turns = 0;
		spawnFork(fork, cwd, message);
		renderWidget();
	}

	// -------------------------------------------------------------- commands

	pi.registerCommand("subtask", {
		description: "Fork the conversation into a background subagent that works on <task>",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /subtask <task>", "error");
				return;
			}
			let snapshot: { file: string; tempDir?: string };
			try {
				snapshot = writeSnapshot(ctx);
			} catch (err) {
				ctx.ui.notify(
					`subtask: could not snapshot conversation: ${err instanceof Error ? err.message : err}`,
					"error",
				);
				return;
			}
			const fork: Fork = {
				id: nextId++,
				name: forkName(task),
				task,
				sessionFile: snapshot.file,
				tempDir: snapshot.tempDir,
				proc: null,
				status: "starting",
				activity: "",
				finalText: "",
				errorText: "",
				usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				startedAt: Date.now(),
				promptAccepted: false,
				agentStarted: false,
				completed: false,
			};
			forks.set(fork.id, fork);
			spawnFork(fork, ctx.cwd, task);
			renderWidget();
			ctx.ui.notify(`Subtask "${fork.name}" started in the background`, "info");
		},
	});

	pi.registerCommand("subtasks", {
		description: "List and manage running and recent subtask forks",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			const rows = [...forks.values()];
			if (rows.length === 0) {
				ctx.ui.notify("No subtasks. Start one with /subtask <task>", "info");
				return;
			}
			const labels = rows.map((f) => `${statusIcon(f.status)} [${f.id}] ${f.name} — ${f.status}`);
			const picked = await ctx.ui.select("Subtasks", labels);
			if (picked === undefined) return;
			const fork = rows[labels.indexOf(picked)];
			if (!fork) return;

			const running = fork.proc !== null && !fork.completed;
			const actions = running
				? ["Steer (send message)", "Stop", "Show output"]
				: ["Follow up (resume fork)", "Show output", "Dismiss"];
			const action = await ctx.ui.select(`${fork.name} (${fork.status})`, actions);
			if (action === undefined) return;

			if (action.startsWith("Steer") || action.startsWith("Follow up")) {
				const message = await ctx.ui.editor(`Message to "${fork.name}"`, "");
				if (!message?.trim()) return;
				sendToFork(fork, message.trim(), ctx.cwd);
				ctx.ui.notify(running ? "Steering message queued" : "Fork resumed", "info");
			} else if (action === "Stop") {
				fork.proc?.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
				completeFork(fork, "stopped");
				ctx.ui.notify(`Stopped "${fork.name}"`, "info");
			} else if (action === "Show output") {
				pi.appendEntry("subtask-output", {
					name: fork.name,
					task: fork.task,
					status: fork.status,
					sessionFile: fork.sessionFile,
					text: fork.finalText || fork.errorText || "(no output yet)",
				});
			} else if (action === "Dismiss") {
				removeFork(fork);
				renderWidget();
			}
		},
	});

	// ------------------------------------------------------------- rendering

	pi.registerMessageRenderer<SubtaskResultDetails>("subtask-result", (message, { expanded }, theme) => {
		const details = message.details;
		const ok = details?.status === "done";
		const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const usage = details ? formatUsage(details.usage) : "";
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(`subtask ${details?.name ?? ""}`))}${usage ? theme.fg("dim", ` · ${usage}`) : ""}`;

		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		const body = typeof message.content === "string" ? message.content : "";
		const resultText = body.split("\nResult:\n").slice(1).join("\nResult:\n") || body;
		if (expanded) {
			if (details) container.addChild(new Text(theme.fg("dim", `task: ${details.task}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(resultText.trim(), 0, 0, getMarkdownTheme()));
			if (details) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `transcript: ${details.sessionFile}`), 0, 0));
			}
		} else {
			const preview = resultText.trim().split("\n").slice(0, 6).join("\n");
			container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
			container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
		}
		return container;
	});

	pi.registerEntryRenderer<{ name: string; task: string; status: string; sessionFile: string; text: string }>(
		"subtask-output",
		(entry, _options, theme) => {
			const data = entry.data;
			if (!data) return undefined;
			const container = new Container();
			container.addChild(new Text(theme.fg("toolTitle", theme.bold(`subtask output: ${data.name}`)), 0, 0));
			container.addChild(new Text(theme.fg("dim", `${data.status} · ${data.sessionFile}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(data.text.trim(), 0, 0, getMarkdownTheme()));
			return container;
		},
	);

	// ------------------------------------------------------------ lifecycle

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		renderWidget();
	});

	pi.on("session_shutdown", async () => {
		for (const fork of [...forks.values()]) {
			const proc = fork.proc;
			if (proc && proc.exitCode === null) {
				fork.completed = true;
				proc.kill("SIGTERM");
			}
			removeFork(fork);
		}
		forks.clear();
	});
}
