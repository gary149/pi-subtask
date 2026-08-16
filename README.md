# pi-subtask

Fork the current conversation into a background subagent that reports back.

`/subtask <task>` snapshots your conversation at that moment (full history, model, thinking level, system prompt) and hands it to a background `pi` process. The fork works on the task with everything you have discussed already in its head, keeps its tool calls in its own transcript, and delivers only its final result back into your conversation. Meanwhile you keep working.

Inspired by Claude Code's forked subagents (`/subtask`).

## Install

```bash
pi install npm:pi-subtask
# or straight from git
pi install git:github.com/gary149/pi-subtask
```

## Use

```
/subtask review the changes we just discussed for concurrency bugs. Do not edit files.
```

Running forks appear in a panel below the editor with live activity, token usage, and cost. When a fork finishes, its result lands in your conversation as a message and the model reacts to it.

```
/subtasks
```

Manage forks: steer a running fork, stop it, resume a finished one with a follow-up (it remembers both your conversation and its own work), show its output, or dismiss it.

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
