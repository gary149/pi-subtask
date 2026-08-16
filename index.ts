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
 *   /subtask <task>       Start a fork working on <task> in the background
 *   /subtask-tool on|off  Toggle the model-facing `subtask` tool, which lets
 *                         the model spawn forks itself (on by default)
 *
 * Panel: press down on an empty prompt to select a fork directly in the
 * status rows below the editor (up/down move, x stops/dismisses, esc or
 * typing returns to the prompt); focusing the panel also reveals finished
 * forks that aged out of the idle view, so they stay resumable. Enter
 * replaces the main view with the fork's live transcript, Claude Code
 * style: the prompt stays and is relabeled @fork - typing steers the fork
 * while it runs or resumes it when finished, pageUp/pageDown scroll, esc
 * returns to the main view.
 *
 * Notes:
 * - Running forks appear in a panel below the editor.
 * - A fork's transcript is a normal session file: resume it any time with
 *   `pi --session <file>`. Follow-ups respawn it in place.
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
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CustomEditor,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	Container,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DONE_ROW_LINGER_MS = 5_000;
const FAILED_ROW_LINGER_MS = 30_000;
const MAX_RETAINED_FINISHED = 20;
const RESULT_CAP_BYTES = 50 * 1024;
const KILL_GRACE_MS = 3_000;
const MAX_TRANSCRIPT_ITEMS = 500;
const MAX_MODEL_FORKS = 4;

interface ForkUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

type TranscriptItem =
	| { type: "user"; text: string; ts: number }
	| { type: "assistant"; text: string; ts: number }
	| { type: "tool"; name: string; args: Record<string, unknown>; ts: number }
	| {
			type: "tool_result";
			name: string;
			ok: boolean;
			summary: string;
			ts: number;
	  }
	| { type: "system"; text: string; ts: number };

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
	/** True when the fork was spawned by the model via the subtask tool. */
	spawnedByModel: boolean;
	/** Parent session id at spawn time; delivery is skipped if it changed. */
	parentSessionId: string;
	/** Parent leaf entry id at spawn time; delivery is skipped if /tree moved
	 * the conversation onto a branch that doesn't contain it. */
	parentLeafId: string | null;
	/** Working directory the fork runs in (spawn and resume). */
	cwd: string;
	/** Model and thinking level pinned at spawn (survives empty snapshots). */
	model?: string;
	thinkingLevel?: string;
	/** Context window of the pinned model, for the ctx gauge. */
	contextWindow?: number;
	/** Latest turn's total context tokens and generation speed. */
	lastTotalTokens: number;
	tps?: number;
	turnStartedAt?: number;
	/** Ring buffer of transcript items feeding the live viewer. */
	transcript: TranscriptItem[];
	/** Set by an open viewer so new items trigger a repaint. */
	onTranscriptUpdate?: () => void;
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
	resultText: string;
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

/** Usage line in pi's own footer format: ↑in ↓out Rcache CH% $cost. */
function formatUsage(usage: ForkUsage): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	const promptTokens = usage.input + usage.cacheRead;
	if (usage.cacheRead && promptTokens > 0) {
		parts.push(`CH${((usage.cacheRead / promptTokens) * 100).toFixed(1)}%`);
	}
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function statusIcon(status: Fork["status"]): string {
	switch (status) {
		case "starting":
			return "○";
		case "running":
			return "✻";
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "stopped":
			return "■";
	}
}

function formatActivity(
	toolName: string,
	args: Record<string, unknown>,
): string {
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

function formatToolLine(
	toolName: string,
	args: Record<string, unknown>,
): string {
	switch (toolName) {
		case "bash":
			return `$ ${String(args.command ?? "")}`;
		case "read":
		case "write":
		case "edit":
		case "ls":
			return `${toolName} ${String(args.file_path ?? args.path ?? "")}`;
		case "grep":
			return `grep /${String(args.pattern ?? "")}/ in ${String(args.path ?? ".")}`;
		case "find":
			return `find ${String(args.pattern ?? "*")} in ${String(args.path ?? ".")}`;
		default: {
			const preview = JSON.stringify(args ?? {});
			return `${toolName} ${preview.length > 80 ? `${preview.slice(0, 80)}...` : preview}`;
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
	while (Buffer.byteLength(truncated, "utf8") > RESULT_CAP_BYTES)
		truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Truncated. Full transcript in the fork's session file.]`;
}

/** Truncate a string to a display width (ANSI/wide-char aware). */
function clipLine(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	return `${truncateToWidth(text, Math.max(0, width - 1), "")}…`;
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
		return {
			command: process.execPath,
			args: [...process.execArgv, currentScript, ...args],
		};
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
const PATH_VALUE_FLAGS = new Set([
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

/**
 * Pi built-in flags that must NOT reach the child: session identity, run mode,
 * and display-only flags. Anything else starting with `--` is assumed to be an
 * extension-registered flag (e.g. plan-mode's --plan) and is forwarded using
 * the same value heuristic as pi's own CLI parser, so parent safety modes
 * carry over to the fork.
 */
const DROPPED_BUILTIN_FLAGS = new Set([
	"--mode",
	"--print",
	"-p",
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--session",
	"--session-id",
	"--fork",
	"--no-session",
	"--name",
	"-n",
	"--model",
	"--models",
	"--thinking",
	"--theme",
	"--use-theme",
	"--no-themes",
	"--export",
	"--list-models",
	"--verbose",
	"--tui-mode",
	"--help",
	"-h",
	"--version",
	"-v",
]);
const DROPPED_VALUE_FLAGS = new Set([
	"--mode",
	"--session",
	"--session-id",
	"--fork",
	"--name",
	"-n",
	"--model",
	"--models",
	"--thinking",
	"--theme",
	"--use-theme",
	"--export",
	"--tui-mode",
]);

function parentConfigArgs(): string[] {
	const argv = process.argv.slice(2);
	const forwarded: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (FORWARDED_BOOL_FLAGS.has(arg)) {
			forwarded.push(arg);
		} else if (FORWARDED_VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
			let value = argv[++i];
			// Path-bearing values must survive the child running in another cwd.
			if (PATH_VALUE_FLAGS.has(arg)) value = path.resolve(value);
			forwarded.push(arg, value);
		} else if (DROPPED_BUILTIN_FLAGS.has(arg)) {
			if (DROPPED_VALUE_FLAGS.has(arg)) i++;
		} else if (arg.startsWith("--")) {
			// Unknown flag: extension-registered. Mirror pi's parser (args.ts):
			// --flag=value passes through as one token; otherwise the next token
			// is the value unless it looks like another flag or an @file.
			forwarded.push(arg);
			if (!arg.includes("=")) {
				const next = argv[i + 1];
				if (
					next !== undefined &&
					!next.startsWith("-") &&
					!next.startsWith("@")
				) {
					forwarded.push(next);
					i++;
				}
			}
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
function writeSnapshot(
	ctx: ExtensionContext,
	forkCwd: string,
): {
	file: string;
	tempDir?: string;
} {
	const header = ctx.sessionManager.getHeader();
	const branch = ctx.sessionManager.getBranch();
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	const rawSessionDir = ctx.sessionManager.getSessionDir();

	// An ephemeral parent (--no-session) has no session dir; keep its fork
	// snapshots out of the project and off the normal session list.
	const ephemeral = !parentSessionFile || !rawSessionDir;
	const sessionDir = ephemeral
		? fs.mkdtempSync(path.join(os.tmpdir(), "pi-subtask-"))
		: path.resolve(rawSessionDir);
	if (!ephemeral) fs.mkdirSync(sessionDir, { recursive: true });

	const id = uuidv7();
	const timestamp = new Date().toISOString();
	const file = path.join(
		sessionDir,
		`${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
	);

	const lines: string[] = [
		JSON.stringify({
			...header,
			id,
			timestamp,
			// pi derives the child's runtime cwd from the header, not from the
			// spawned process cwd.
			cwd: forkCwd,
			parentSession: parentSessionFile,
		}),
	];
	let parentId: string | null = null;
	for (const entry of branch) {
		if (entry.type === "label") continue;
		lines.push(JSON.stringify({ ...entry, parentId }));
		parentId = entry.id;
	}
	fs.writeFileSync(file, `${lines.join("\n")}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	return { file, tempDir: ephemeral ? sessionDir : undefined };
}

const SubtaskToolParams = Type.Object({
	task: Type.String({
		description:
			"The task for the fork to work on. Include goal, scope, whether edits are allowed, and the output format you want.",
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the fork. Defaults to the session's cwd.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// A fork can't spawn further forks.
	if (process.env.PI_SUBTASK_CHILD === "1") return;

	const forks = new Map<number, Fork>();
	let nextId = 1;
	let lastCtx: ExtensionContext | undefined;
	let subtaskToolRegistered = false;
	let subtaskToolOn = true;

	// ------------------------------------------------------------ transcript

	function pushTranscriptItem(fork: Fork, item: TranscriptItem) {
		fork.transcript.push(item);
		if (fork.transcript.length > MAX_TRANSCRIPT_ITEMS) {
			fork.transcript.splice(0, fork.transcript.length - MAX_TRANSCRIPT_ITEMS);
		}
		fork.onTranscriptUpdate?.();
	}

	// ---------------------------------------------------------------- widget

	function widgetRows(): Fork[] {
		// Finished rows age out of the idle widget but stay in panelRows().
		return [...forks.values()].filter((f) => {
			if (f.id === viewPane?.fork.id) return true;
			if (!f.finishedAt) return true;
			const linger =
				f.status === "done" ? DONE_ROW_LINGER_MS : FAILED_ROW_LINGER_MS;
			return Date.now() - f.finishedAt < linger;
		});
	}

	/**
	 * Width-aware widget rows: one line per fork, no wrapping. The activity
	 * preview absorbs the trimming so usage and elapsed time always stay
	 * visible, which is why this is a Component (render receives the width)
	 * instead of a plain string[] that the TUI would wrap.
	 */
	/**
	 * Selection index for the inline panel: null = editor has focus, 0 = the
	 * main row, i >= 1 = widgetRows()[i - 1]. Driven by the editor wrapper.
	 */
	let panelSel: number | null = null;

	function widgetLines(width: number): string[] {
		// Focused: every retained fork (aged-out finished ones included, like
		// Claude Code's /tasks). Idle: only recent rows.
		const rows = panelSel === null && !viewPane ? widgetRows() : panelRows();
		if (panelSel !== null && panelSel > rows.length) {
			panelSel = rows.length;
		}
		const viewedId = viewPane?.fork.id;
		const hint = viewPane
			? `viewing @${viewPane.fork.name} — typing goes to the fork · ↓ switch · esc back to main`
			: panelSel === null
				? `subtasks (${rows.length}) — ↓ to select`
				: "enter to view · x to stop/dismiss · esc back";
		const lines = [clipLine(hint, width)];
		// Filled marker = the view you're in, hollow = the others (Claude Code).
		lines.push(
			clipLine(
				`${panelSel === 0 ? "❯" : " "} ${viewPane ? "◯" : "●"} main`,
				width,
			),
		);
		rows.forEach((f, i) => {
			const elapsed = Math.round((Date.now() - f.startedAt) / 1000);
			const viewed = f.id === viewedId;
			const stats: string[] = [];
			if (viewed && f.tps) stats.push(`${f.tps.toFixed(1)} tok/s`);
			const usage = formatUsage(f.usage);
			if (usage) stats.push(usage);
			if (viewed && f.contextWindow && f.lastTotalTokens) {
				const pct = (f.lastTotalTokens / f.contextWindow) * 100;
				const window =
					f.contextWindow >= 1_000_000
						? `${(f.contextWindow / 1_000_000).toFixed(1)}M`
						: formatTokens(f.contextWindow);
				stats.push(`${pct.toFixed(1)}%/${window}`);
			}
			const marker = panelSel === i + 1 ? "❯" : " ";
			const icon = viewed ? "⏺" : statusIcon(f.status);
			const prefix = `${marker} ${icon} [${f.id}] ${f.name} · `;
			const suffix = `${stats.length ? ` · ${stats.join(" · ")}` : ""} · ${elapsed}s`;
			const activity =
				f.status === "running" || f.status === "starting"
					? f.activity || "..."
					: f.status;
			const room = Math.max(
				8,
				width - visibleWidth(prefix) - visibleWidth(suffix),
			);
			// Final clip is the hard guard: pi's renderer throws on over-width
			// lines, so a row must never exceed the width even on tiny terminals.
			lines.push(
				clipLine(
					clipLine(prefix, width - 1) + clipLine(activity, room) + suffix,
					width,
				),
			);
		});
		return lines;
	}

	let widgetTui: TUI | undefined;
	let widgetVisible = false;

	function renderWidget() {
		if (!lastCtx?.hasUI) return;
		try {
			const visibleRows =
				panelSel !== null || viewPane ? panelRows() : widgetRows();
			if (visibleRows.length === 0) {
				if (widgetVisible) {
					lastCtx.ui.setWidget("subtasks", undefined);
					widgetVisible = false;
					widgetTui = undefined;
				}
				return;
			}
			if (!widgetVisible) {
				widgetVisible = true;
				lastCtx.ui.setWidget(
					"subtasks",
					(tui, _theme) => {
						widgetTui = tui;
						return {
							render: (width: number) => widgetLines(width),
							invalidate: () => {},
							dispose: () => {
								if (widgetTui === tui) widgetTui = undefined;
							},
						};
					},
					{ placement: "belowEditor" },
				);
			} else {
				widgetTui?.requestRender();
			}
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
		const finished = [...forks.values()]
			.filter((f) => f.finishedAt)
			.sort((a, b) => a.finishedAt! - b.finishedAt!);
		while (finished.length > MAX_RETAINED_FINISHED) {
			removeFork(finished.shift()!);
		}
	}

	// ------------------------------------------------------------- lifecycle

	function runningModelForks(): number {
		return [...forks.values()].filter(
			(f) => f.spawnedByModel && !f.completed && f.proc !== null,
		).length;
	}

	function deliverResult(fork: Fork) {
		const elapsedMs = Date.now() - fork.startedAt;
		const body =
			fork.status === "done"
				? capResult(fork.finalText || "(no output)")
				: `The fork ${fork.status === "stopped" ? "was stopped" : "failed"}.${fork.errorText ? `\n\nError:\n${capResult(fork.errorText)}` : ""}${fork.finalText ? `\n\nPartial output:\n${capResult(fork.finalText)}` : ""}`;
		const details: SubtaskResultDetails = {
			name: fork.name,
			task: fork.task,
			status: fork.status,
			sessionFile: fork.sessionFile,
			usage: fork.usage,
			elapsedMs,
			resultText: body,
		};
		try {
			// Skip delivery if the parent session was replaced since the fork
			// spawned; the result stays recoverable in the fork's session file.
			if (
				lastCtx &&
				lastCtx.sessionManager.getSessionId() !== fork.parentSessionId
			) {
				console.error(
					`subtask: parent session changed; not delivering result of "${fork.name}"`,
				);
				return;
			}
			// Same when /tree moved the conversation onto a branch that doesn't
			// descend from the fork's spawn point: the session id is unchanged,
			// but the result belongs to the other branch, not this one.
			if (lastCtx && fork.parentLeafId) {
				const branchIds = new Set(
					lastCtx.sessionManager.getBranch().map((e) => e.id),
				);
				if (!branchIds.has(fork.parentLeafId)) {
					console.error(
						`subtask: conversation moved to another branch; not delivering result of "${fork.name}"`,
					);
					lastCtx.ui.notify(
						`Subtask "${fork.name}" finished on another branch — press down on the prompt to open it`,
						"warning",
					);
					return;
				}
			}
			pi.sendMessage(
				{
					customType: "subtask-result",
					content: `A background subtask forked from this conversation has finished. This is an automated notification, not a message typed by the user.\n\n<subtask-result name="${fork.name}" status="${fork.status}">\nTask: ${fork.task}\n\n${body}\n</subtask-result>`,
					display: true,
					details,
				},
				{ deliverAs: "followUp", triggerTurn: true },
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
		pushTranscriptItem(fork, {
			type: "system",
			text: `── ${status} ──`,
			ts: Date.now(),
		});
		if (status !== "stopped") deliverResult(fork);
		// The fork stays in the map (resumable from the panel) but its widget row
		// ages out; schedule a refresh so the row disappears without new events.
		fork.finishedAt = Date.now();
		trimRetainedForks();
		if (fork.lingerTimer) clearTimeout(fork.lingerTimer);
		const linger =
			status === "done" ? DONE_ROW_LINGER_MS : FAILED_ROW_LINGER_MS;
		fork.lingerTimer = setTimeout(renderWidget, linger + 100);
		renderWidget();
	}

	/**
	 * Frame the initial task so the fork understands its role. It inherits the
	 * whole conversation, including instructions addressed to the original
	 * assistant ("don't answer X yourself", "delegate this"), and without
	 * framing it can apply those to itself and refuse its own task.
	 */
	function frameInitialTask(task: string): string {
		return [
			"You are a fork of this conversation: a background copy spawned to work on one specific task while the original conversation continues without you.",
			"Everything above is inherited context. Instructions there about how to respond, who should answer what, or delegating to subtasks applied to the original assistant, not to you.",
			"Your only objective is the task below. Work on it and end with your result; your final message is delivered back to the original conversation.",
			"",
			`Task: ${task}`,
		].join("\n");
	}

	function spawnFork(
		fork: Fork,
		cwd: string,
		prompt: string,
		displayText?: string,
	) {
		const invocation = getPiInvocation([
			"--mode",
			"rpc",
			"--session",
			fork.sessionFile,
			// Pin model/thinking explicitly: a snapshot with no messages yet is
			// treated as a fresh session and would fall back to defaults.
			...(fork.model ? ["--model", fork.model] : []),
			...(fork.thinkingLevel ? ["--thinking", fork.thinkingLevel] : []),
			...parentConfigArgs(),
		]);
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
		fork.finalText = "";
		fork.finishedAt = undefined;
		let stderr = "";
		let buffer = "";
		// A prompt consumed entirely by a child input handler or extension command
		// reports success but never runs the agent; without this watchdog the fork
		// would sit in "running" forever.
		let agentStartWatchdog: ReturnType<typeof setTimeout> | undefined;
		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		pushTranscriptItem(fork, {
			type: "user",
			text: displayText ?? prompt,
			ts: Date.now(),
		});

		const handleEvent = (event: Record<string, unknown>) => {
			switch (event.type) {
				case "response": {
					if (event.command === "prompt") {
						if (event.success) {
							fork.promptAccepted = true;
							fork.status = "running";
							agentStartWatchdog = setTimeout(() => {
								if (!fork.completed && !fork.agentStarted) {
									fork.finalText =
										fork.finalText ||
										"(the task was consumed by the child's input handling without an agent run)";
									completeFork(fork, "done");
								}
							}, 15_000);
						} else {
							fork.errorText = String(event.error ?? "prompt rejected");
							completeFork(fork, "failed");
						}
					}
					break;
				}
				case "agent_start":
					if (agentStartWatchdog) clearTimeout(agentStartWatchdog);
					fork.agentStarted = true;
					fork.status = "running";
					break;
				case "message_start": {
					const msg = event.message as Message | undefined;
					if (msg?.role === "assistant") fork.turnStartedAt = Date.now();
					break;
				}
				case "tool_execution_start": {
					const name = String(event.toolName ?? "tool");
					const args = (event.args as Record<string, unknown>) ?? {};
					fork.activity = formatActivity(name, args);
					pushTranscriptItem(fork, {
						type: "tool",
						name,
						args,
						ts: Date.now(),
					});
					break;
				}
				case "tool_execution_end": {
					const name = String(event.toolName ?? "tool");
					const result = event.result as
						| { isError?: boolean; content?: unknown }
						| undefined;
					// isError lives on the event itself; the result's own flag is a
					// fallback for older wire formats.
					const ok = !(
						(event.isError as boolean | undefined) ??
						result?.isError ??
						false
					);
					let summary = "";
					if (Array.isArray(result?.content)) {
						const text = result.content.find(
							(c): c is { type: "text"; text: string } =>
								typeof c === "object" &&
								c !== null &&
								(c as { type?: string }).type === "text",
						);
						summary = (text?.text ?? "").split("\n")[0].slice(0, 80);
					}
					pushTranscriptItem(fork, {
						type: "tool_result",
						name,
						ok,
						summary,
						ts: Date.now(),
					});
					break;
				}
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
							fork.lastTotalTokens =
								(usage as { totalTokens?: number }).totalTokens ??
								fork.lastTotalTokens;
							if (fork.turnStartedAt && usage.output) {
								const secs = (Date.now() - fork.turnStartedAt) / 1000;
								if (secs > 0.2) fork.tps = usage.output / secs;
							}
						}
						const text = lastAssistantText(msg);
						if (text) {
							fork.finalText = text;
							fork.activity = text.split("\n")[0].slice(0, 50);
							pushTranscriptItem(fork, {
								type: "assistant",
								text,
								ts: Date.now(),
							});
						}
						// A later successful message clears the error from a retried turn.
						if (msg.stopReason === "error")
							fork.errorText = msg.errorMessage ?? "LLM error";
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
					if (
						method === "select" ||
						method === "confirm" ||
						method === "input" ||
						method === "editor"
					) {
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
				if (code !== 0 && !fork.errorText)
					fork.errorText = stderr.trim() || `pi exited with code ${code}`;
				completeFork(
					fork,
					fork.status === "stopped"
						? "stopped"
						: code === 0
							? "done"
							: "failed",
				);
			}
		});
		proc.on("error", (err) => {
			if (!fork.completed) {
				fork.errorText = `failed to spawn pi: ${err.message}`;
				completeFork(fork, "failed");
			}
		});

		proc.stdin.write(
			`${JSON.stringify({ type: "prompt", message: prompt })}\n`,
		);
	}

	function sendToFork(fork: Fork, message: string) {
		if (fork.proc && !fork.completed) {
			// Running: queue as steering input on the live child.
			pushTranscriptItem(fork, { type: "user", text: message, ts: Date.now() });
			fork.proc.stdin?.write(
				`${JSON.stringify({ type: "prompt", message, streamingBehavior: "steer" })}\n`,
			);
			return;
		}
		// Finished: resume the fork's session file with a fresh process.
		// Usage stays cumulative across resumes, like elapsed time.
		if (fork.lingerTimer) clearTimeout(fork.lingerTimer);
		pushTranscriptItem(fork, {
			type: "system",
			text: "── resumed ──",
			ts: Date.now(),
		});
		spawnFork(fork, fork.cwd, message);
		renderWidget();
	}

	function startFork(
		ctx: ExtensionContext,
		task: string,
		spawnedByModel: boolean,
		cwdOverride?: string,
	): Fork | string {
		const cwd = cwdOverride ? path.resolve(ctx.cwd, cwdOverride) : ctx.cwd;
		if (cwdOverride && !fs.existsSync(cwd)) {
			return `working directory does not exist: ${cwd}`;
		}
		let snapshot: { file: string; tempDir?: string };
		try {
			snapshot = writeSnapshot(ctx, cwd);
		} catch (err) {
			return `could not snapshot conversation: ${err instanceof Error ? err.message : err}`;
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
			usage: {
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
			},
			startedAt: Date.now(),
			spawnedByModel,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: ctx.thinkingLevel,
			contextWindow: ctx.model?.contextWindow,
			lastTotalTokens: 0,
			parentSessionId: ctx.sessionManager.getSessionId(),
			parentLeafId: ctx.sessionManager.getLeafId(),
			cwd,
			transcript: [],
			promptAccepted: false,
			agentStarted: false,
			completed: false,
		};
		forks.set(fork.id, fork);
		spawnFork(fork, cwd, frameInitialTask(task), task);
		renderWidget();
		return fork;
	}

	// ------------------------------------------------------------- dock UI

	function panelRows(): Fork[] {
		const all = [...forks.values()];
		const running = all.filter((f) => !f.finishedAt);
		const finished = all
			.filter((f) => f.finishedAt)
			.sort((a, b) => b.finishedAt! - a.finishedAt!);
		return [...running, ...finished];
	}

	let mdCache = new WeakMap<
		TranscriptItem,
		{ width: number; lines: string[] }
	>();

	/**
	 * Full-width fork transcript pane, Claude Code style: it visually replaces
	 * the main conversation while pi's real editor keeps focus below it (the
	 * overlay is non-capturing). Input routing while it's open lives in
	 * SubtaskEditor; this component only displays and tails the transcript.
	 */
	class ForkPane {
		private disposed = false;
		/** Wrapped-line offset from the END of the transcript; 0 = tailing. */
		scrollBack = 0;
		private tui: TUI;
		private theme: Theme;
		fork: Fork;

		constructor(tui: TUI, theme: Theme, fork: Fork) {
			this.tui = tui;
			this.theme = theme;
			this.fork = fork;
			fork.onTranscriptUpdate = () => {
				if (!this.disposed) this.tui.requestRender();
			};
		}

		scrollBy(delta: number) {
			this.scrollBack = Math.max(0, this.scrollBack + delta);
			this.tui.requestRender();
		}

		/** Switch the pane to another fork without closing the overlay. */
		setFork(fork: Fork) {
			if (this.fork.onTranscriptUpdate)
				this.fork.onTranscriptUpdate = undefined;
			this.fork = fork;
			this.scrollBack = 0;
			fork.onTranscriptUpdate = () => {
				if (!this.disposed) this.tui.requestRender();
			};
			this.tui.requestRender();
		}

		private itemLines(item: TranscriptItem, width: number): string[] {
			const t = this.theme;
			switch (item.type) {
				case "user":
					return [
						t.fg(
							"accent",
							`› ${clipLine(item.text.replace(/\n/g, " "), width - 2)}`,
						),
					];
				case "assistant": {
					const cached = mdCache.get(item);
					if (cached && cached.width === width) return cached.lines;
					const lines = new Markdown(
						item.text.trim(),
						0,
						0,
						getMarkdownTheme(),
					).render(width);
					mdCache.set(item, { width, lines });
					return lines;
				}
				case "tool":
					return [
						t.fg(
							"muted",
							`→ ${clipLine(formatToolLine(item.name, item.args), width - 2)}`,
						),
					];
				case "tool_result": {
					const icon = item.ok ? "✔" : "✘";
					const text = clipLine(
						`${icon} ${item.summary || item.name}`,
						width - 2,
					);
					return [t.fg(item.ok ? "dim" : "error", `  ${text}`)];
				}
				case "system":
					return [t.fg("dim", clipLine(item.text, width))];
			}
		}

		render(width: number): string[] {
			const t = this.theme;
			const fork = this.fork;
			const contentWidth = Math.max(20, width - 2);

			// Flatten the transcript into wrapped lines.
			const body: string[] = [];
			for (const item of fork.transcript) {
				for (const line of this.itemLines(item, contentWidth)) body.push(line);
				if (item.type === "assistant") body.push("");
			}

			// The pane covers everything above the editor + widget + footer.
			// Manual tail windowing: overlays get no viewport from the TUI and
			// maxHeight truncates from the top, so slice the tail ourselves.
			const rows = this.tui.terminal.rows;
			// The widget renders panelRows() whenever a view is open.
			const bottomChrome = 8 + panelRows().length; // editor+footer+widget+hints
			const visibleCount = Math.max(3, rows - bottomChrome - 2);
			this.scrollBack = Math.max(
				0,
				Math.min(this.scrollBack, Math.max(0, body.length - visibleCount)),
			);
			const end = body.length - this.scrollBack;
			const visible = body.slice(Math.max(0, end - visibleCount), end);

			const lines: string[] = [];
			if (end - visibleCount > 0) {
				lines.push(
					t.fg(
						"dim",
						` ↑ ${Math.max(0, end - visibleCount)} more line(s) (pageUp)`,
					),
				);
			} else {
				lines.push("");
			}
			for (const line of visible) lines.push(` ${line}`);
			if (this.scrollBack > 0)
				lines.push(
					t.fg("dim", ` ↓ ${this.scrollBack} more line(s) (pageDown)`),
				);
			// Pad so the pane fully covers the main transcript behind it.
			while (lines.length < visibleCount + 3) lines.push("");
			return lines;
		}

		invalidate(): void {
			// Styled markdown lines cache theme colors; drop them so theme
			// changes repaint correctly.
			mdCache = new WeakMap();
		}

		dispose(): void {
			// The pane is a window onto the fork, never its owner: detach only.
			this.disposed = true;
			if (this.fork.onTranscriptUpdate)
				this.fork.onTranscriptUpdate = undefined;
		}
	}

	/**
	 * Fork view state: while set, the fork's transcript pane covers the main
	 * conversation (non-capturing overlay) and SubtaskEditor routes typed
	 * messages to the fork — Claude Code's transcript-replacement UX.
	 */
	let viewPane: ForkPane | undefined;
	let viewDone: (() => void) | undefined;

	function enterForkView(fork: Fork) {
		const ctx = lastCtx;
		if (!ctx || ctx.mode !== "tui" || !ctx.hasUI || viewPane) return;
		void (async () => {
			try {
				await ctx.ui.custom<undefined>(
					(tui, theme, _kb, done) => {
						const pane = new ForkPane(tui, theme, fork);
						viewPane = pane;
						viewDone = () => done(undefined);
						return pane;
					},
					{
						overlay: true,
						overlayOptions: {
							width: "100%",
							anchor: "top-left",
							margin: 0,
							// Focus stays in pi's real editor; the pane only displays.
							nonCapturing: true,
						},
					},
				);
			} finally {
				viewPane = undefined;
				viewDone = undefined;
				renderWidget();
			}
		})();
		renderWidget();
	}

	function exitForkView() {
		viewDone?.();
	}

	function stopOrDismissFork(fork: Fork) {
		if (fork.proc && !fork.completed) {
			fork.proc.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
			completeFork(fork, "stopped");
		} else {
			removeFork(fork);
		}
	}

	/**
	 * Editor wrapper for the inline panel, Claude Code style: pressing down on
	 * an empty prompt moves selection into the subtask rows below the editor;
	 * up/down navigate, enter opens the viewer, x stops or dismisses, escape
	 * (or typing anything) returns focus to the editor.
	 */
	class SubtaskEditor extends CustomEditor {
		handleInput(data: string): void {
			// Fork view open: input routes to the fork, Claude Code style.
			if (viewPane) {
				// Arrow navigation still works: select another row and switch
				// the view in place (main row exits to the main conversation).
				if (panelSel !== null) {
					const rows = panelRows();
					if (matchesKey(data, "up")) {
						panelSel = Math.max(0, panelSel - 1);
					} else if (matchesKey(data, "down")) {
						panelSel = Math.min(rows.length, panelSel + 1);
					} else if (matchesKey(data, "return")) {
						const target = panelSel > 0 ? rows[panelSel - 1] : undefined;
						panelSel = null;
						if (!target) exitForkView();
						else if (target.id !== viewPane.fork.id) viewPane.setFork(target);
					} else if (matchesKey(data, "escape")) {
						panelSel = null;
					} else if (matchesKey(data, "x") && panelSel > 0) {
						const fork = rows[panelSel - 1];
						if (fork) stopOrDismissFork(fork);
						const remaining = panelRows().length;
						if (panelSel > remaining)
							panelSel = remaining > 0 ? remaining : null;
					} else {
						panelSel = null;
						renderWidget();
						super.handleInput(data);
						return;
					}
					renderWidget();
					return;
				}
				if (
					matchesKey(data, "down") &&
					this.getText() === "" &&
					forks.size > 0
				) {
					// Enter navigation at the top (main), same as outside a view:
					// one down + enter always returns to the main conversation.
					panelSel = 0;
					renderWidget();
					return;
				}
				if (matchesKey(data, "escape")) {
					exitForkView();
					return;
				}
				if (matchesKey(data, "pageUp")) {
					viewPane.scrollBy(10);
					return;
				}
				if (matchesKey(data, "pageDown")) {
					viewPane.scrollBy(-10);
					return;
				}
				if (matchesKey(data, "return")) {
					const text = (this.getExpandedText?.() ?? this.getText()).trim();
					if (!text) return;
					if (text.startsWith("/")) {
						// Built-in commands still act on the main session, like
						// Claude Code's transcript view.
						super.handleInput(data);
						return;
					}
					this.setText("");
					viewPane.scrollBack = 0;
					sendToFork(viewPane.fork, text);
					return;
				}
				super.handleInput(data);
				return;
			}
			if (panelSel === null) {
				if (
					matchesKey(data, "down") &&
					this.getText() === "" &&
					forks.size > 0
				) {
					panelSel = 0;
					renderWidget();
					return;
				}
				super.handleInput(data);
				return;
			}
			const rows = panelRows();
			if (matchesKey(data, "up")) {
				panelSel = panelSel === 0 ? null : panelSel - 1;
			} else if (matchesKey(data, "down")) {
				panelSel = Math.min(rows.length, panelSel + 1);
			} else if (matchesKey(data, "escape")) {
				panelSel = null;
			} else if (matchesKey(data, "return")) {
				const fork = panelSel > 0 ? rows[panelSel - 1] : undefined;
				panelSel = null;
				renderWidget();
				if (fork) enterForkView(fork);
				return;
			} else if (matchesKey(data, "x") && panelSel > 0) {
				const fork = rows[panelSel - 1];
				if (fork) stopOrDismissFork(fork);
				const remaining = panelRows().length;
				if (panelSel > remaining) panelSel = remaining > 0 ? remaining : null;
			} else {
				// Any other key returns focus to the editor and types normally,
				// like Claude Code's panel (x on the main row included).
				panelSel = null;
				renderWidget();
				super.handleInput(data);
				return;
			}
			renderWidget();
		}

		render(width: number): string[] {
			const lines = super.render(width);
			// Label the input border with the viewed fork, like Claude Code's
			// @agent-name marker, so it's clear where typed messages go.
			if (viewPane && lines.length > 0) {
				const label = ` @${forkName(viewPane.fork.name)} `;
				const labelWidth = visibleWidth(label);
				if (visibleWidth(lines[0]) >= labelWidth + 4) {
					lines[0] =
						truncateToWidth(lines[0], width - labelWidth - 2, "") +
						label +
						"──";
				}
			}
			return lines;
		}
	}

	// -------------------------------------------------------------- commands

	pi.registerCommand("subtask", {
		description:
			"Fork the conversation into a background subagent that works on <task>",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /subtask <task>", "error");
				return;
			}
			const result = startFork(ctx, task, false);
			if (typeof result === "string") {
				ctx.ui.notify(`subtask: ${result}`, "error");
				return;
			}
			ctx.ui.notify(
				`Subtask "${result.name}" started in the background`,
				"info",
			);
		},
	});

	// ---------------------------------------------------- model-facing tool

	function registerSubtaskTool() {
		if (subtaskToolRegistered) return;
		subtaskToolRegistered = true;
		pi.registerTool({
			name: "subtask",
			label: "Subtask",
			description: [
				"Fork this conversation into a background subagent that inherits everything discussed so far",
				"(system prompt, model, full history) and works on `task` independently while you keep going.",
				"Its tool calls stay out of this conversation; only its final result comes back as a message when it finishes.",
				"Use it when a side task needs the context already established here but its intermediate work would be noise,",
				"or to explore approaches in parallel. Returns immediately with a receipt - you are not blocked.",
				"Do not poll or wait for the result; you will be notified in a later turn.",
				"A fork cannot itself spawn further forks.",
			].join(" "),
			parameters: SubtaskToolParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (runningModelForks() >= MAX_MODEL_FORKS) {
					return {
						content: [
							{
								type: "text",
								text: `Concurrent subtask limit reached (${MAX_MODEL_FORKS} running). Wait for one to finish, or the user can stop one from the subtask panel. Do not retry immediately.`,
							},
						],
						isError: true,
					};
				}
				lastCtx = ctx;
				const result = startFork(ctx, params.task, true, params.cwd);
				if (typeof result === "string") {
					return {
						content: [
							{ type: "text", text: `subtask failed to start: ${result}` },
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: [
								`Subtask "${result.name}" (id ${result.id}) started in the background.`,
								"",
								"You will be notified when it finishes — do not poll or wait, continue other work or end your turn.",
								"The user can watch or steer it from the subtask panel below the prompt.",
							].join("\n"),
						},
					],
					details: {
						forkId: result.id,
						name: result.name,
						sessionFile: result.sessionFile,
					},
				};
			},
			renderCall(args, theme) {
				const preview = args.task
					? args.task.length > 60
						? `${args.task.slice(0, 60)}...`
						: args.task
					: "...";
				return new Text(
					theme.fg("toolTitle", theme.bold("subtask ")) +
						theme.fg("accent", forkName(args.task ?? "")) +
						theme.fg("dim", ` ${preview}`),
					0,
					0,
				);
			},
		});
	}

	function setSubtaskToolEnabled(enabled: boolean, ctx: ExtensionContext) {
		if (enabled) {
			registerSubtaskTool();
			const active = pi.getActiveTools();
			if (!active.includes("subtask"))
				pi.setActiveTools([...active, "subtask"]);
			subtaskToolOn = true;
			ctx.ui.notify(
				"subtask tool enabled — the model can now spawn forks (max 4 concurrent)",
				"info",
			);
		} else {
			if (subtaskToolRegistered) {
				pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "subtask"));
			}
			subtaskToolOn = false;
			ctx.ui.notify("subtask tool disabled", "info");
		}
	}

	// The model-facing tool is on by default (Claude Code parity); /subtask-tool
	// off removes it for the session.
	registerSubtaskTool();

	pi.registerCommand("subtask-tool", {
		description:
			"Enable/disable the model-facing subtask tool: /subtask-tool on|off (on by default)",
		getArgumentCompletions: (prefix) =>
			["on", "off"]
				.filter((v) => v.startsWith(prefix.trim()))
				.map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const arg = args.trim().toLowerCase();
			if (arg === "on") setSubtaskToolEnabled(true, ctx);
			else if (arg === "off") setSubtaskToolEnabled(false, ctx);
			else
				ctx.ui.notify(
					`subtask tool is ${subtaskToolOn ? "on" : "off"} — /subtask-tool on|off`,
					"info",
				);
		},
	});

	// ------------------------------------------------------------- rendering

	pi.registerMessageRenderer<SubtaskResultDetails>(
		"subtask-result",
		(message, { expanded }, theme) => {
			const details = message.details;
			const ok = details?.status === "done";
			const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const usage = details ? formatUsage(details.usage) : "";
			const header = `${icon} ${theme.fg("toolTitle", theme.bold(`subtask ${details?.name ?? ""}`))}${usage ? theme.fg("dim", ` · ${usage}`) : ""}`;

			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			const body = typeof message.content === "string" ? message.content : "";
			const resultText =
				details?.resultText ??
				(body
					.split("<subtask-result")
					.slice(1)
					.join("")
					.split(">")
					.slice(1)
					.join(">") ||
					body);
			if (expanded) {
				if (details)
					container.addChild(
						new Text(theme.fg("dim", `task: ${details.task}`), 0, 0),
					);
				container.addChild(new Spacer(1));
				container.addChild(
					new Markdown(resultText.trim(), 0, 0, getMarkdownTheme()),
				);
				if (details) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							theme.fg("dim", `transcript: ${details.sessionFile}`),
							0,
							0,
						),
					);
				}
			} else {
				const preview = resultText.trim().split("\n").slice(0, 6).join("\n");
				container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
				container.addChild(
					new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0),
				);
			}
			return container;
		},
	);

	// Kept for sessions that contain entries appended by older versions.
	pi.registerEntryRenderer<{
		name: string;
		task: string;
		status: string;
		sessionFile: string;
		text: string;
	}>("subtask-output", (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const container = new Container();
		container.addChild(
			new Text(
				theme.fg("toolTitle", theme.bold(`subtask output: ${data.name}`)),
				0,
				0,
			),
		);
		container.addChild(
			new Text(theme.fg("dim", `${data.status} · ${data.sessionFile}`), 0, 0),
		);
		container.addChild(new Spacer(1));
		container.addChild(
			new Markdown(data.text.trim(), 0, 0, getMarkdownTheme()),
		);
		return container;
	});

	// ------------------------------------------------------------ lifecycle

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// New session, new UI: the widget must re-register itself.
		widgetVisible = false;
		widgetTui = undefined;
		panelSel = null;
		// Inline panel navigation needs an editor wrapper; respect another
		// extension's custom editor (modal-editor etc.) if one is installed.
		// Without the wrapper there is no keyboard access to forks.
		if (ctx.hasUI && !ctx.ui.getEditorComponent()) {
			ctx.ui.setEditorComponent(
				(tui, theme, kb) => new SubtaskEditor(tui, theme, kb),
			);
		}
		renderWidget();
	});

	pi.on("session_shutdown", async () => {
		exitForkView();
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
