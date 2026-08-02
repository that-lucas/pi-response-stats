# pi-response-stats

A lightweight Pi extension that tracks and displays LLM response performance in the footer: tokens per second and response time, per agent run and cumulative across the session.

The footer shows the current run's TPS and duration alongside session averages, separated by a `•` delimiter:

```
123/99 TPS • 32s/1min 54s
```

## What it shows

- **Current run** — TPS and duration of the most recent agent run, live while running (every thinking block and tool call counts)
- **Session totals** — average TPS and total time across all runs in the current session

All values reset when you start a new session. Before the first run completes, the line shows `–/– TPS • –/–`.

## Install

```bash
pi install npm:pi-response-stats
```

Or copy `response-stats.ts` to `~/.pi/agent/extensions/` and run `/reload`.

## Behavior

Works automatically — no commands or shortcuts. The line is always visible; values fill in as runs complete.
