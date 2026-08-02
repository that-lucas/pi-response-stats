/**
 * Response stats footer extension.
 *
 * Shows `{current}/{avg} TPS • {latest run time}/{session total}` on its
 * own footer line, below the stats line that holds the context window usage
 * info. "current" and "latest run" span the whole agent run
 * (`agent_start` → `agent_end`): every LLM response, thinking block, and
 * tool call between the user pressing Enter and the agent delivering the
 * final answer, live while running. Always visible; `–/– TPS • –/–`
 * before the first run completes:
 *
 *   /tmp
 *   ↑2.1k ↓3.4k R45.2k W12.1k CH88.1% $0.123 42.5%/200k   model
 *   123/99 TPS • 32s/1min 54s
 *
 * - current: tokens/sec of the last completed agent run (live while running,
 *   using output tokens streamed so far).
 * - avg: session average tokens/sec over all completed agent runs
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
import { isAbsolute, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// TPS tracking state. Module-level on purpose: extension instances are
// recreated per session (session switch, /new, /resume, /reload), so this
// state naturally scopes to the current session.
// ---------------------------------------------------------------------------

let runStartedAt = 0; // epoch ms when the in-flight agent run started
let runTokens = 0; // output tokens from completed assistant messages in the run
let messageTokens = 0; // live output tokens of the in-flight assistant message
let lastTps: number | undefined; // TPS of the last completed agent run
let lastDurationMs: number | undefined; // wall time of the last completed agent run
let totalOutputTokens = 0; // session totals over completed agent runs
let totalDurationMs = 0;

let requestRender: (() => void) | undefined;

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

function formatTps(n: number): string {
  return Math.round(n).toString();
}

/** Format a duration as 32s, 1min 54s, or 2h 5min. */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

export default function (pi: ExtensionAPI) {
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
    totalOutputTokens += tokens;
    totalDurationMs += elapsedMs;
    requestRender?.();
  });

  // Keep the footer fresh when the model/thinking level changes.
  pi.on("model_select", () => requestRender?.());
  pi.on("thinking_level_select", () => requestRender?.());

  // --- replace the footer with a replica of the built-in one + TPS ----------
  pi.on("session_start", (_event, ctx) => {
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

  // --- Stats line: {current}/{avg} TPS • {latest}/{total} time, own line -------
  const latestDuration = runStartedAt !== 0 ? Date.now() - runStartedAt : lastDurationMs;
  const durationStr = `${latestDuration !== undefined ? formatDuration(latestDuration) : "–"}/${totalDurationMs > 0 ? formatDuration(totalDurationMs) : "–"}`;
  const current = liveTps() ?? lastTps;
  const avg = sessionAvgTps();
  const currentStr = current !== undefined ? formatTps(current) : "–";
  const avgStr = avg !== undefined ? formatTps(avg) : "–";
  lines.push(truncateToWidth(theme.fg("dim", `${currentStr}/${avgStr} TPS • ${durationStr}`), width, theme.fg("dim", "...")));

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
