# response-stats

Pi extension showing response stats in the footer: `{current}/{avg} TPS • {latest run}/{session total}`.

## Install

Copy `response-stats.ts` to `~/.pi/agent/extensions/`, then run `/reload` in pi.

## What it shows

One line below pi's stats, spanning each agent run (Enter → final answer):

```
123/99 TPS • 32s/1m 54s
```

| Part | Meaning |
|------|---------|
| `123` | Current run's TPS (live) |
| `99` | Session average TPS |
| `32s` | Latest run duration (live) |
| `1m 54s` | Total session time |

Before the first run completes it shows `–/– –/–`.
