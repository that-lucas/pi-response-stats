# pi-response-stats

A lightweight Pi extension that tracks and displays LLM response performance in the footer: tokens per second and response time, per agent run and cumulative across the session.

The footer shows the current run's TPS and duration alongside session averages:

```
⚡123/99 ⏱32s/1m 54s
```

## What it shows

- **Current run**: TPS and duration of the most recent agent run, live while running (every thinking block and tool call counts)
- **Session totals**: average TPS and total time across all runs in the current session

All values reset when you start a new session. Before the first run completes, the line shows `⚡0/0 ⏱0s/0s`.

## Format

The stats line is configurable. Set `format` in `~/.pi/agent/response-stats.json`:

```json
{ "format": "⚡{runTps}/{avgTps} ⏱{runDuration}/{totalDuration}" }
```

### Placeholders

| Placeholder | Kind | No-data / zero behavior | Example (run: 1h 2m 3s · total: 0h 1m 54s · TPS 123 · 421 tok) |
|---|---|---|---|
| `{runTps}` | int | `0` | 123 |
| `{avgTps}` | int | `0` | 99 |
| `{runTokens}` | int | `0` | 421 |
| `{totalTokens}` | int | `0` | 3842 |
| `{runDuration}` | string, pre-formatted | `0s` | 1h 2m |
| `{totalDuration}` | string, pre-formatted | `0s` | 1m 54s |
| `{runHours}` `{runMinutes}` `{runSeconds}` | int | always renders, incl. 0 | 1, 2, 3 |
| `{totalHours}` `{totalMinutes}` `{totalSeconds}` | int | always renders, incl. 0 | 0, 1, 54 |
| `{runHoursIfAny}` | string, conditional | `` (empty) | 1h |
| `{runMinutesIfAny}` | string, conditional | `` (empty) | 2m |
| `{runSecondsIfAny}` | string, conditional | `` (empty) | 3s |
| `{totalHoursIfAny}` | string, conditional | `` (empty) | `` (empty) |
| `{totalMinutesIfAny}` | string, conditional | `` (empty) | 1m |
| `{totalSecondsIfAny}` | string, conditional | `` (empty) | 54s |

### Logic

1. Substitute every `{name}` (and optional `{name:spec}` for numbers) with its value.
2. `IfAny` placeholders expand to `value + unit` when non-zero, empty string when zero.
3. Collapse consecutive spaces to one, trim ends (this removes the gaps left by vanished `IfAny` segments).
4. Unknown placeholders stay literal so typos are visible.

Number specs follow .NET style: `0` (integer), `0.0` (one decimal), `0.##` (up to two, no trailing zeros).

### Examples (run: 32s · total: 1m 54s · TPS 123/99)

| Format string | Result |
|---|---|
| `⚡{runTps}/{avgTps} ⏱{runDuration}/{totalDuration}` (default) | `⚡123/99 ⏱32s/1m 54s` |
| same, before first run | `⚡0/0 ⏱0s/0s` |
| `⏱{runHoursIfAny} {runMinutesIfAny} {runSecondsIfAny}` | `⏱ 32s` |
| `⏱{runHours}h {runMinutes}m {runSeconds}s` | `⏱0h 0m 32s` |
| `{runHoursIfAny} {runMinutesIfAny} {runSecondsIfAny} / {totalHoursIfAny} {totalMinutesIfAny} {totalSecondsIfAny}` | `32s / 1m 54s` |
| `{runTps:0.0}/{avgTps}` | `123.0/99` |
| `{runTokens} tok` | `421 tok` |

## Install

```bash
# From npm (published releases)
pi install npm:pi-response-stats

# From git (unpinned; updates with `pi update --extensions`)
pi install git:github.com/that-lucas/pi-response-stats
```

Or copy `response-stats.ts` to `~/.pi/agent/extensions/` and run `/reload`.

## Behavior

Works automatically, no commands or shortcuts. The line is always visible; values fill in as runs complete.
