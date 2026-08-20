# pi-subtask

**Subtasks are forks of your conversation that work in the background and report back to the main agent.**

A subtask starts out knowing everything you've discussed, works on its own while you keep going, and sends back just its final result.

> Inspired by Claude Code's forked subagents.

## Install

```bash
pi install git:github.com/gary149/pi-subtask
```

## Quick start

```
/subtask find every place in this repo that still assumes the old auth flow we just replaced
```

That's it. The subtask appears in a panel under your prompt, and its result arrives as a message when it's done.

You can also just ask: *"spawn a subtask to check the auth flow"*. The model has a `subtask` tool and will delegate on its own.

<img width="954" height="720" alt="llama-cpp-3subtasks-zoom-720p-opt" src="https://github.com/user-attachments/assets/3145c534-7f76-4443-bf70-9626e455f3c3" />

## The panel

Press `↓` on an empty prompt to jump into the subtask rows under the editor.

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between rows |
| `Enter` | Open the subtask's live transcript (or return to `main`) |
| `x` | Stop a running subtask, dismiss a finished one |
| `Esc` | Back to typing |

Finished subtasks stay listed here, so you can always reopen or resume one.

## The subtask view

`Enter` on a row replaces the main view with that subtask's live transcript: tool calls and replies stream in as they happen.

| Key | Action |
| --- | --- |
| *type + `Enter`* | Send a message. Steers the subtask while it runs, resumes it once finished |
| `PageUp` `PageDown` | Scroll |
| `↓` | Switch to another subtask |
| `Esc` | Back to the main conversation |

Your prompt stays where it is. The panel identifies the active `@subtask-name` so you know where your words are going.

## Commands

| Command | |
| --- | --- |
| `/subtask <task>` | Fork the conversation and work on `<task>` |
| `/subtask-tool off` | Stop the model from spawning subtasks itself (on by default, max 8 at once) |

## How it works

**Snapshot, not sync.** A subtask gets your conversation exactly as it was at spawn time. Later messages don't reach it.

**Same brain.** Same model, thinking level, tools, and CLI flags. Its first request reuses your prompt cache, so forking is cheaper than briefing a fresh agent.

**Noise stays out.** Its greps, file reads, and dead ends live in its own transcript. Your context pays for one message: the result.

**Real sessions.** A subtask's transcript is an ordinary pi session file. Reopen it any time with `pi --session <file>`.

## Good to know

- Subtasks share your working tree. Great for investigation; for parallel edits, give each one its own files.
- A subtask can't spawn more subtasks.
- Rate-limited subtask? Resume it from the panel, its progress is preserved.
- The panel needs pi's default editor. If another extension installs a custom one, pi-subtask steps aside.

## Not to be confused with

| | |
| --- | --- |
| **Subtask** | A copy of *this* conversation, sent off to work in the background and report back |
| **Subagent** | A fresh specialist briefed from scratch, knowing nothing about your conversation |
| **`/fork`** (pi built-in) | A copy of the session that *you* switch into, rather than one that works for you |

## License

MIT
