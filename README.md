# pi-subtask

Fork your pi conversation into a background subagent that reports back.

The fork inherits everything you've discussed, works on its own while you keep going, and delivers just its final result into your conversation.

> Inspired by Claude Code's forked subagents.

## Install

```bash
pi install git:github.com/gary149/pi-subtask
```

## Quick start

```
/subtask review the changes we just discussed for concurrency bugs. Do not edit files.
```

That's it. The fork appears in a panel under your prompt, and its result arrives as a message when it's done.

You can also just ask: *"spawn a subtask to check the auth flow"* — the model has a `subtask` tool and will fork on its own.

## The panel

Press `↓` on an empty prompt to jump into the fork rows under the editor.

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between rows |
| `Enter` | Open the fork's live transcript (or return to `main`) |
| `x` | Stop a running fork, dismiss a finished one |
| `Esc` | Back to typing |

Finished forks stay listed here, so you can always reopen or resume one.

## The fork view

`Enter` on a fork replaces the main view with its live transcript: tool calls and replies stream in as they happen.

| Key | Action |
| --- | --- |
| *type + `Enter`* | Send to the fork — steers it while running, resumes it when finished |
| `PageUp` `PageDown` | Scroll |
| `↓` | Switch to another fork |
| `Esc` | Back to the main conversation |

Your prompt stays where it is, relabeled `@fork-name` so you know where your words are going.

## Commands

| Command | |
| --- | --- |
| `/subtask <task>` | Fork the conversation and work on `<task>` |
| `/subtask-tool off` | Stop the model from spawning forks itself (on by default, max 8 at once) |

## How it works

**Snapshot, not sync** — the fork gets your conversation exactly as it was at spawn time. Later messages don't reach it.

**Same brain** — same model, thinking level, tools, and CLI flags. Its first request reuses your prompt cache, so forking is cheaper than briefing a fresh agent.

**Noise stays out** — the fork's greps, file reads, and dead ends live in its own transcript. Your context pays for one message: the result.

**Real sessions** — a fork's transcript is an ordinary pi session file. Reopen it any time with `pi --session <file>`.

## Good to know

- Forks share your working tree. Great for investigation; for parallel edits, give each fork its own files.
- A fork can't spawn more forks.
- Rate-limited fork? Resume it from the panel — its progress is preserved.
- The panel needs pi's default editor. If another extension installs a custom one, pi-subtask steps aside.

## License

MIT
