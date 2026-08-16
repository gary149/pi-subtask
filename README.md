# pi-subtask

Fork the current conversation into a background subagent that reports back.

`/subtask <task>` snapshots your conversation at that moment (full history, model, thinking level, system prompt) and hands it to a background `pi` process. The fork works on the task with everything you have discussed already in its head, keeps its tool calls in its own transcript, and delivers only its final result back into your conversation. Meanwhile you keep working.

Inspired by Claude Code's forked subagents (`/subtask`).

## Install

```bash
pi install git:github.com/gary149/pi-subtask
```

## Use

```
/subtask review the changes we just discussed for concurrency bugs. Do not edit files.
```

Running forks appear in a panel below the editor with live activity, token usage, and cost. When a fork finishes, its result lands in your conversation as a message and the model reacts to it.

```
/subtasks        (or Alt+T)
```

Press `↓` on an empty prompt to select a fork directly in the status rows under the editor (Claude Code style) — `↑↓` move, `x` stops/dismisses, `Esc` returns to typing; focusing the panel also reveals finished forks that aged out of the idle view, so they stay resumable. `Enter` **replaces the main view with the fork's live transcript**: its tool calls and replies stream in as it works, the prompt stays and is relabeled `@fork-name`, and anything you type goes to the fork — steering it while it runs, resuming it after it finishes (it remembers both your conversation and its own work). `PageUp`/`PageDown` scroll, `Esc` returns to the main conversation. (The panel needs pi's default editor; if another extension installs a custom editor, this extension leaves it alone and the panel is unavailable.)

The model can also delegate on its own: a `subtask` tool (enabled by default) lets it fork the conversation in the background when you ask it to, or when it judges a side investigation useful (max 4 concurrent). The tool returns immediately with a receipt and the result comes back as a notification in a later turn, so the model keeps working meanwhile. Disable it for a session with `/subtask-tool off`.

## How it works

- **Snapshot, not sync.** The fork gets the conversation exactly as it was at spawn time, written to a new pi session file. Later messages in your session do not reach it.
- **Same brain.** The snapshot carries the model and thinking level, the child runs in the same cwd with your CLI flags forwarded (tool restrictions, extra extensions, system prompt additions), so its context is identical. Its first request reuses the provider prompt cache, making a fork cheaper than re-explaining everything to a fresh agent.
- **Noise stays out.** The fork's file reads, greps, and dead ends live only in its own transcript. Your context window pays for one message: the result (capped at 50 KB).
- **Real transcript.** The fork's session file is a normal pi session. Reopen it any time with `pi --session <file>`.

## Notes

- Forks share your working tree. Fine for read-only investigation; for parallel edits, constrain each fork to non-overlapping files.
- A fork cannot spawn further forks.
- With `--no-session` parents, snapshots go to a temp dir and are cleaned up.
- Fork turns use pi's normal auto-retry. If a fork still dies (rate limit), resume it from `/subtasks`: its progress is preserved.

## License

MIT
