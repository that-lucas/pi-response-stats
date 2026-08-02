# AGENTS.md

## What this is

Single-file pi extension (`response-stats.ts`) that renders a stats line in pi's footer: TPS and response time per agent run (agent_start → agent_end) plus session averages. Zero runtime dependencies; loaded by pi via jiti.

## Key facts

- **Installed copy**: `~/.pi/agent/extensions/response-stats.ts` must stay in sync with the repo copy (`cp` both ways). `/reload` picks up changes.
- **Config**: optional `~/.pi/agent/response-stats.json` with `{ "format": "..." }`. Default: `⚡{runTps}/{avgTps} ⏱{runDuration}/{totalDuration}`.
- **Format engine**: named placeholders (`{runTps}`, `{avgTps}`, `{runDuration}`, `{totalDuration}`, raw components, `IfAny` conditional family), .NET-style number specs (`0`, `0.0`, `0.##`), whitespace collapse + trim after substitution, unknown placeholders stay literal. Full reference in README "Format" section — keep it in sync.
- **Icons**: `⚡` (U+26A1) and `⏱` (U+23F1) MUST be followed by U+FE0E (VS15) or they render as emoji. Thin space U+2009 between `⏱` and the duration. These invisible chars are load-bearing; editors may strip them from the JSON config.
- **No-data semantics**: `0` / `0s` (no dashes). Durations use `m`.

## Testing

- `/tmp/test-format.ts` asserts the format engine against every documented case: `node --experimental-strip-types /tmp/test-format.ts`.
- It contains **copies** of the pure functions, not imports (the extension can't be imported standalone; pi-tui only resolves inside pi's loader). Drift risk after edits — re-copy the functions when changing them, or prefer the refactor: extract the engine to a dependency-free module the test can import.
- Always smoke test the real extension: `pi -e <path> -p "..."`.

## Release

Bump `version` in `package.json`, commit, push, then `npm publish --otp <code>` (2FA required). No AI attribution in commits/PRs.
