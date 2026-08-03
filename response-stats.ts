/**
 * Response stats footer extension.
 *
 * Shows a configurable stats line. A leading `\n` in the format renders
 * it on its own line below the stats line that holds the context window
 * usage info; without the prefix, the stats append inline to that line,
 * separated by a single hardcoded space. The default format is
 * `\n⚡{runTps}/{avgTps} ⏱{runDuration}/{totalDuration}`; override it with a
 * `format` string in `~/.pi/agent/response-stats.json` (full placeholder
 * reference in the README "Format" section). Runs span the whole agent
 * run (`agent_start` → `agent_end`): every LLM response, thinking block,
 * and tool call between the user pressing Enter and the agent delivering
 * the final answer, live while running. Always visible; `⚡0/0 ⏱0s/0s`
 * before the first run completes:
 *
 *   /tmp
 *   ↑2.1k ↓3.4k R45.2k W12.1k CH88.1% $0.123 42.5%/200k   model
 *   ⚡123/99 ⏱ 32s/1m 54s
 *
 * - runTps: tokens/sec of the current agent run (live while running).
 * - avgTps: session average tokens/sec over all completed agent runs
 *   (output tokens / wall time, thinking and tool calls included). Resets
 *   per session.
 *
 * The built-in footer is replaced via ctx.ui.setFooter(); this footer
 * replicates its layout (pwd line, stats line, extension statuses) with the
 * response stats on their own line below the stats. Known deviations: no
 * "(auto)" compaction marker and no "(sub)" cost marker (not exposed to
 * extensions), and the experimental "xp" badge is omitted.
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Pi caches extension factories across same-directory session replacements,
// so module-level tracking state is reset explicitly on each session start.
// ---------------------------------------------------------------------------

let runStartedAt = 0; // epoch ms when the in-flight agent run started
let runTokens = 0; // output tokens from completed assistant messages in the run
let messageTokens = 0; // live output tokens of the in-flight assistant message
let lastTps: number | undefined; // TPS of the last completed agent run
let lastDurationMs: number | undefined; // wall time of the last completed agent run
let lastRunTokens = 0; // output tokens of the last completed agent run
let totalOutputTokens = 0; // session totals over completed agent runs
let totalDurationMs = 0;

let requestRender: (() => void) | undefined;

function resetTrackingState(): void {
  runStartedAt = 0;
  runTokens = 0;
  messageTokens = 0;
  lastTps = undefined;
  lastDurationMs = undefined;
  lastRunTokens = 0;
  totalOutputTokens = 0;
  totalDurationMs = 0;
}

function liveTps(): number | undefined {
  if (runStartedAt === 0) return undefined;
  const tokens = runTokens + messageTokens;
  if (tokens <= 0) return undefined;
  const elapsedSec = (Date.now() - runStartedAt) / 1000;
  return elapsedSec > 0 ? tokens / elapsedSec : undefined;
}

function sessionAvgTps(): number | undefined {
  if (totalDurationMs <= 0) return undefined;
  return totalOutputTokens / (totalDurationMs / 1000);
}

/** Format a duration as 32s, 1m 54s, or 2h 5m. */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Configurable stats line format. The `format` setting lives in
// ~/.pi/agent/response-stats.json (see README "Format" section for the full
// placeholder reference).
// ---------------------------------------------------------------------------

/** .NET-style number spec: "0", "0.0", "0.##", "0.0#" -> Intl options. */
function formatNumber(value: number, spec: string | undefined): string {
  if (!spec || !/^0(\.(0+|#+|0*#+))?$/.test(spec)) {
    return String(Math.round(value));
  }
  const frac = spec.split(".")[1] ?? "";
  const minDecimals = (frac.match(/0/g) ?? []).length;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: frac.length,
    useGrouping: false,
  }).format(value);
}

/** Unit for each raw duration component, used by the IfAny placeholders. */
const UNIT_BY_COMPONENT: Record<string, string> = {
  runHours: "h",
  runMinutes: "m",
  runSeconds: "s",
  totalHours: "h",
  totalMinutes: "m",
  totalSeconds: "s",
};

const IF_ANY_SUFFIX = "IfAny";

const DEFAULT_FORMAT = "\n\u26A1\uFE0E{runTps}/{avgTps} \u23F1\uFE0E\u2009{runDuration}/{totalDuration}";

let statsFormat = DEFAULT_FORMAT;

/** Load the optional ~/.pi/agent/response-stats.json config. */
function loadStatsConfig(): void {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    const config = JSON.parse(readFileSync(join(agentDir, "response-stats.json"), "utf8")) as {
      format?: unknown;
    };
    if (typeof config.format === "string" && config.format.length > 0) {
      statsFormat = config.format;
    }
  } catch {
    // missing or unreadable config: keep the default format
  }
}

type StatsValues = Record<string, number | string>;

/** All documented placeholders, computed from the current tracking state. */
function buildStatsValues(): StatsValues {
  const latestDuration = runStartedAt !== 0 ? Date.now() - runStartedAt : lastDurationMs;
  // Session total ticks live: completed runs plus the in-flight run, so it
  // moves together with the current run and agent_end causes no jump.
  const liveTotalMs = totalDurationMs + (runStartedAt !== 0 ? Date.now() - runStartedAt : 0);
  const runSecs = Math.round((latestDuration ?? 0) / 1000);
  const totalSecs = Math.round(liveTotalMs / 1000);
  const parts = (secs: number) => ({
    hours: Math.floor(secs / 3600),
    minutes: Math.floor((secs % 3600) / 60),
    seconds: secs % 60,
  });
  const run = parts(runSecs);
  const total = parts(totalSecs);
  return {
    runTps: liveTps() ?? lastTps ?? 0,
    avgTps: sessionAvgTps() ?? 0,
    runTokens: runStartedAt !== 0 ? runTokens + messageTokens : lastRunTokens,
    totalTokens: totalOutputTokens,
    runDuration: latestDuration !== undefined ? formatDuration(latestDuration) : "0s",
    totalDuration: liveTotalMs > 0 ? formatDuration(liveTotalMs) : "0s",
    runHours: run.hours,
    runMinutes: run.minutes,
    runSeconds: run.seconds,
    totalHours: total.hours,
    totalMinutes: total.minutes,
    totalSeconds: total.seconds,
  };
}

/**
 * Substitute {name} and {name:spec} placeholders. IfAny placeholders expand
 * to `value + unit` when non-zero and to nothing when zero; after
 * substitution, whitespace runs of 2+ collapse to one space and the result
 * is trimmed. Unknown placeholders stay literal so typos are visible.
 */
function applyStatsFormat(format: string, values: StatsValues): string {
  const rendered = format.replace(/\{(\w+)(?::([^}]+))?\}/g, (match, rawName: string, spec?: string) => {
    let name = rawName;
    let unit: string | undefined;
    if (name.endsWith(IF_ANY_SUFFIX)) {
      const base = name.slice(0, -IF_ANY_SUFFIX.length);
      unit = UNIT_BY_COMPONENT[base];
      if (unit === undefined) return match;
      name = base;
    }
    const value = values[name];
    if (value === undefined) return match;
    if (typeof value === "string") return value;
    if (unit !== undefined && value === 0) return "";
    return formatNumber(value, spec) + (unit ?? "");
  });
  return rendered.replace(/\s{2,}/g, " ").trim();
}

/**
 * The stats render on their own footer line when the format starts with
 * "\n"; without the prefix they append inline to pi's stats line.
 */
function splitNewlineDecision(format: string): { newLine: boolean; body: string } {
  if (format.startsWith("\n")) return { newLine: true, body: format.slice(1) };
  return { newLine: false, body: format };
}

/** Render the configured format with current values; stray newlines become spaces. */
function renderStatsText(): { newLine: boolean; text: string } {
  const { newLine, body } = splitNewlineDecision(statsFormat);
  return { newLine, text: applyStatsFormat(body, buildStatsValues()).replace(/\n/g, " ") };
}

export default function (pi: ExtensionAPI) {
  loadStatsConfig();

  // --- measure each agent run: agent_start -> agent_end ----------------------
  pi.on("agent_start", () => {
    runStartedAt = Date.now();
    runTokens = 0;
    messageTokens = 0;
  });

  pi.on("message_update", (event) => {
    if (runStartedAt === 0 || event.message.role !== "assistant") return;
    const output = event.assistantMessageEvent.partial.usage?.output;
    if (typeof output === "number" && output > messageTokens) messageTokens = output;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || runStartedAt === 0) return;
    const message = event.message as AssistantMessage;
    runTokens += message.usage?.output ?? 0;
    messageTokens = 0;
  });

  pi.on("agent_end", () => {
    if (runStartedAt === 0) return;
    const elapsedMs = Date.now() - runStartedAt;
    const tokens = runTokens;
    runStartedAt = 0;
    runTokens = 0;
    messageTokens = 0;
    if (tokens <= 0 || elapsedMs <= 0) return;
    lastTps = tokens / (elapsedMs / 1000);
    lastDurationMs = elapsedMs;
    lastRunTokens = tokens;
    totalOutputTokens += tokens;
    totalDurationMs += elapsedMs;
    requestRender?.();
  });

  // Keep the footer fresh when the model/thinking level changes.
  pi.on("model_select", () => requestRender?.());
  pi.on("thinking_level_select", () => requestRender?.());

  // --- replace the footer with a replica of the built-in one + TPS ----------
  pi.on("session_start", (_event, ctx) => {
    resetTrackingState();
    ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();
      return {
        dispose() {
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number) {
          return renderFooter(ctx, theme, footerData, width);
        },
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Built-in footer replica. Mirrors the internal FooterComponent (see
// modes/interactive/components/footer.js in pi-coding-agent) using only data
// the extension API exposes.
// ---------------------------------------------------------------------------

/** Format token counts for compact footer display (mirrors built-in). */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function renderFooter(
  ctx: ExtensionContext,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  width: number,
): string[] {
  const { newLine, text: statsText } = renderStatsText();

  // --- cumulative usage from ALL session entries ----------------------------
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0;
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage;
      input += usage.input;
      output += usage.output;
      cacheRead += usage.cacheRead;
      cacheWrite += usage.cacheWrite;
      cost += usage.cost.total;
      const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      latestCacheHitRate =
        latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      const usage = entry.message.usage;
      input += usage.input;
      output += usage.output;
      cacheRead += usage.cacheRead;
      cacheWrite += usage.cacheWrite;
      cost += usage.cost.total;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      const usage = entry.usage;
      input += usage.input;
      output += usage.output;
      cacheRead += usage.cacheRead;
      cacheWrite += usage.cacheWrite;
      cost += usage.cost.total;
    }
  }

  // --- context window usage --------------------------------------------------
  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
  const contextPercentDisplay = contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
  let contextPercentStr: string;
  if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
  else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
  else contextPercentStr = contextPercentDisplay;

  // --- stats line -------------------------------------------------------------
  const statsParts: string[] = [];
  if (input) statsParts.push(`↑${formatTokens(input)}`);
  if (output) statsParts.push(`↓${formatTokens(output)}`);
  if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
  if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
    statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (cost) statsParts.push(`$${cost.toFixed(3)}`);
  statsParts.push(contextPercentStr);

  let statsLeft = statsParts.join(" ");
  // Inline mode: append the stats after a single hardcoded space.
  if (!newLine && statsText.length > 0) statsLeft += ` ${statsText}`;

  // --- model name, right-aligned ----------------------------------------------
  const modelName = ctx.model?.id || "no-model";
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const minPadding = 2;
  let rightSideWithoutProvider = modelName;
  if (ctx.model?.reasoning) {
    const thinkingLevel = ctx.thinkingLevel || "off";
    rightSideWithoutProvider =
      thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
  }

  let rightSide = rightSideWithoutProvider;
  if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
    rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
    if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
      rightSide = rightSideWithoutProvider;
    }
  }

  const rightSideWidth = visibleWidth(rightSide);
  const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
  let statsLine: string;
  if (totalNeeded <= width) {
    const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
    statsLine = statsLeft + padding + rightSide;
  } else {
    const availableForRight = width - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const truncatedRightWidth = visibleWidth(truncatedRight);
      const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
      statsLine = statsLeft + padding + truncatedRight;
    } else {
      statsLine = statsLeft;
    }
  }

  // Apply dim to each part separately (statsLeft may contain colored context %)
  const dimStatsLeft = theme.fg("dim", statsLeft);
  const remainder = statsLine.slice(statsLeft.length);
  const dimRemainder = theme.fg("dim", remainder);

  // --- pwd line (with git branch and session name) + extension statuses line ----
  let pwd = formatCwdForFooter(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
  const branch = footerData.getGitBranch();
  if (branch) pwd = `${pwd} (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) pwd = `${pwd} • ${sessionName}`;

  const lines = [
    truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
    dimStatsLeft + dimRemainder,
  ];

  // --- Stats line (configurable format), own line unless format is inline -----
  if (newLine) {
    lines.push(truncateToWidth(theme.fg("dim", statsText), width, theme.fg("dim", "...")));
  }

  const extensionStatuses = footerData.getExtensionStatuses();
  if (extensionStatuses.size > 0) {
    const sortedStatuses = Array.from(extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeStatusText(text));
    lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
  }

  return lines;
}

/** Replace the home directory with ~ in a path (mirrors built-in). */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Replace newlines/tabs/CRs with space, then collapse spaces (mirrors built-in). */
function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}
