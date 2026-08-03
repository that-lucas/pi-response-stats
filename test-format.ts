// Standalone test of the format engine copied from response-stats.ts.
// Run: node --experimental-strip-types test-format.ts

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

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

const UNIT_BY_COMPONENT: Record<string, string> = {
  runHours: "h", runMinutes: "m", runSeconds: "s",
  totalHours: "h", totalMinutes: "m", totalSeconds: "s",
};
const IF_ANY_SUFFIX = "IfAny";
type StatsValues = Record<string, number | string>;

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

const values: StatsValues = {
  runTps: 123, avgTps: 99, runTokens: 421, totalTokens: 3842,
  runDuration: "32s", totalDuration: "1m 54s",
  runHours: 0, runMinutes: 0, runSeconds: 32,
  totalHours: 0, totalMinutes: 1, totalSeconds: 54,
};
const valuesLong: StatsValues = {
  ...values,
  runDuration: "1h 2m",
  runHours: 1, runMinutes: 2, runSeconds: 3,
};
const preRun: StatsValues = {
  runTps: 0, avgTps: 0, runTokens: 0, totalTokens: 0,
  runDuration: "0s", totalDuration: "0s",
  runHours: 0, runMinutes: 0, runSeconds: 0,
  totalHours: 0, totalMinutes: 0, totalSeconds: 0,
};

let failures = 0;
function check(actual: string, expected: string, label: string) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` != ${JSON.stringify(expected)}`}`);
}

// --- duration formatting -----------------------------------------------------
check(formatDuration(32_000), "32s", "formatDuration 32s");
check(formatDuration(114_000), "1m 54s", "formatDuration 1m 54s");
check(formatDuration(7_500_000), "2h 5m", "formatDuration 2h 5m");
check(formatDuration(0), "0s", "formatDuration 0s");

// --- number specs ------------------------------------------------------------
check(formatNumber(123, undefined), "123", "formatNumber default int");
check(formatNumber(123.4, undefined), "123", "formatNumber default rounds");
check(formatNumber(123.456, "0.0"), "123.5", "formatNumber 0.0 rounds");
check(formatNumber(123, "0.0"), "123.0", "formatNumber 0.0 pads");
check(formatNumber(123.456, "0.##"), "123.46", "formatNumber 0.##");
check(formatNumber(123, "0.##"), "123", "formatNumber 0.## no trailing");
check(formatNumber(1234, undefined), "1234", "formatNumber no grouping");
check(formatNumber(5, "bogus"), "5", "formatNumber invalid spec falls back");

// --- placeholder dictionary (valuesLong: run 1h 2m 3s) ------------------------
check(applyStatsFormat("{runTps}", valuesLong), "123", "{runTps}");
check(applyStatsFormat("{avgTps}", valuesLong), "99", "{avgTps}");
check(applyStatsFormat("{runTokens}", valuesLong), "421", "{runTokens}");
check(applyStatsFormat("{totalTokens}", valuesLong), "3842", "{totalTokens}");
check(applyStatsFormat("{runDuration}", valuesLong), "1h 2m", "{runDuration}");
check(applyStatsFormat("{totalDuration}", valuesLong), "1m 54s", "{totalDuration}");
check(applyStatsFormat("{runHours} {runMinutes} {runSeconds}", valuesLong), "1 2 3", "raw run components");
check(applyStatsFormat("{totalHours} {totalMinutes} {totalSeconds}", valuesLong), "0 1 54", "raw total components");
check(applyStatsFormat("{runHoursIfAny}", valuesLong), "1h", "{runHoursIfAny}");
check(applyStatsFormat("{runMinutesIfAny}", valuesLong), "2m", "{runMinutesIfAny}");
check(applyStatsFormat("{runSecondsIfAny}", valuesLong), "3s", "{runSecondsIfAny}");
check(applyStatsFormat("{totalHoursIfAny}", valuesLong), "", "{totalHoursIfAny} zero -> empty");
check(applyStatsFormat("{totalMinutesIfAny}", valuesLong), "1m", "{totalMinutesIfAny}");
check(applyStatsFormat("{totalSecondsIfAny}", valuesLong), "54s", "{totalSecondsIfAny}");

// --- examples from the docs ---------------------------------------------------
const DEF = "\n\u26A1\uFE0E{runTps}/{avgTps} \u23F1\uFE0E\u2009{runDuration}/{totalDuration}";
check(applyStatsFormat(DEF, values), "\u26A1\uFE0E123/99 \u23F1\uFE0E\u200932s/1m 54s", "default format");
check(applyStatsFormat(DEF, preRun), "\u26A1\uFE0E0/0 \u23F1\uFE0E\u20090s/0s", "default pre-run");
check(applyStatsFormat("\u23F1\uFE0E{runHoursIfAny} {runMinutesIfAny} {runSecondsIfAny}", values), "\u23F1\uFE0E 32s", "IfAny collapses zeros");
check(applyStatsFormat("\u23F1\uFE0E{runHours}h {runMinutes}m {runSeconds}s", values), "\u23F1\uFE0E0h 0m 32s", "raw components with units");
check(
  applyStatsFormat("{runHoursIfAny} {runMinutesIfAny} {runSecondsIfAny} / {totalHoursIfAny} {totalMinutesIfAny} {totalSecondsIfAny}", values),
  "32s / 1m 54s",
  "composed IfAny",
);
check(applyStatsFormat("{runTps:0.0}/{avgTps}", values), "123.0/99", "spec on runTps");
check(applyStatsFormat("{runTokens} tok", values), "421 tok", "tokens literal suffix");
check(applyStatsFormat("x {bogus} y", values), "x {bogus} y", "unknown stays literal");
check(applyStatsFormat("  {runTps}   {avgTps}  ", values), "123 99", "whitespace collapse+trim");

// --- newline placement decision -------------------------------------------------
function splitNewlineDecision(format: string): { newLine: boolean; body: string } {
  if (format.startsWith("\n")) return { newLine: true, body: format.slice(1) };
  return { newLine: false, body: format };
}
function renderStatsText(format: string, vals: StatsValues): { newLine: boolean; text: string } {
  const { newLine, body } = splitNewlineDecision(format);
  return { newLine, text: applyStatsFormat(body, vals).replace(/\n/g, " ") };
}

const nl = renderStatsText("\n⚡{runTps}/{avgTps}", values);
check(JSON.stringify(nl), JSON.stringify({ newLine: true, text: "⚡123/99" }), "leading \\n -> own line");
const inl = renderStatsText("⚡{runTps}/{avgTps}", values);
check(JSON.stringify(inl), JSON.stringify({ newLine: false, text: "⚡123/99" }), "no prefix -> inline");
const def = renderStatsText(DEF, values);
check(JSON.stringify(def), JSON.stringify({ newLine: true, text: "\u26A1\uFE0E123/99 \u23F1\uFE0E\u200932s/1m 54s" }), "default format -> own line");
const stray = renderStatsText("a\nb {runTps}", values);
check(JSON.stringify(stray), JSON.stringify({ newLine: false, text: "a b 123" }), "stray newline becomes space");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
