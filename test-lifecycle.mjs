import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const cwd = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(cwd, "response-stats.ts");
const piEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piDist = dirname(piEntryPath);
const { clearExtensionCache, createExtensionRuntime, loadExtensionsCached } = await import(
  pathToFileURL(join(piDist, "core", "extensions", "loader.js")).href
);
const { createEventBus } = await import(pathToFileURL(join(piDist, "core", "event-bus.js")).href);

const STATE_TYPE = "response-stats-state";

function stateEntry({
  version = 1,
  totalOutputTokens,
  totalDurationMs,
  lastRunTokens,
  lastTps,
  lastDurationMs,
}) {
  return {
    type: "custom",
    customType: STATE_TYPE,
    data: { version, totalOutputTokens, totalDurationMs, lastRunTokens, lastTps, lastDurationMs },
  };
}

function completedState(tokens, durationMs) {
  return stateEntry({
    totalOutputTokens: tokens,
    totalDurationMs: durationMs,
    lastRunTokens: tokens,
    lastTps: tokens / (durationMs / 1000),
    lastDurationMs: durationMs,
  });
}

function latestState(branch) {
  return branch.findLast((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)?.data;
}

async function loadInstance(reason, state) {
  const runtime = createExtensionRuntime();
  runtime.appendEntry = (customType, data) => {
    const entry = { type: "custom", customType, data };
    state.branch.push(entry);
    if (state.allEntries !== state.branch) state.allEntries.push(entry);
  };

  const result = await loadExtensionsCached([extensionPath], cwd, createEventBus(), runtime);
  assert.deepEqual(result.errors, []);
  const extension = result.extensions[0];
  const ctx = {
    cwd,
    model: { id: "test", contextWindow: 1_000_000 },
    thinkingLevel: "off",
    getContextUsage: () => ({ contextWindow: 1_000_000, percent: 0 }),
    sessionManager: {
      getBranch: () => state.branch,
      getEntries: () => state.allEntries,
      getSessionName: () => undefined,
    },
    ui: { setFooter: () => {} },
  };

  await emit(extension, "session_start", { type: "session_start", reason }, ctx);
  return { extension, ctx };
}

async function emit(extension, eventName, event, ctx) {
  for (const handler of extension.handlers.get(eventName) ?? []) {
    await handler(event, ctx);
  }
}

async function completeRun(instance, tokens) {
  await emit(instance.extension, "agent_start", { type: "agent_start" }, instance.ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await emit(instance.extension, "message_end", {
    type: "message_end",
    message: { role: "assistant", usage: { output: tokens } },
  }, instance.ctx);
  await emit(instance.extension, "agent_end", { type: "agent_end", messages: [] }, instance.ctx);
}

test.beforeEach(() => clearExtensionCache());

test("a new session without a snapshot starts from zero", async () => {
  const state = { branch: [], allEntries: [] };
  const instance = await loadInstance("new", state);
  await completeRun(instance, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 50);
});

test("resume restores that session's active-branch snapshot", async () => {
  const old = completedState(100, 1_000);
  const state = { branch: [old], allEntries: [old] };
  const resumed = await loadInstance("resume", state);
  await completeRun(resumed, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 150);
});

test("resume followed by reload preserves the same totals", async () => {
  const old = completedState(100, 1_000);
  const state = { branch: [old], allEntries: [old] };
  await loadInstance("resume", state);
  clearExtensionCache();
  const reloaded = await loadInstance("reload", state);
  await completeRun(reloaded, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 150);
});

test("startup restores an existing session and resets a fresh one", async () => {
  const existing = completedState(100, 1_000);
  const existingState = { branch: [existing], allEntries: [existing] };
  const resumedAtStartup = await loadInstance("startup", existingState);
  await completeRun(resumedAtStartup, 50);
  assert.equal(latestState(existingState.branch).totalOutputTokens, 150);

  clearExtensionCache();
  const freshState = { branch: [], allEntries: [] };
  const freshStartup = await loadInstance("startup", freshState);
  await completeRun(freshStartup, 50);
  assert.equal(latestState(freshState.branch).totalOutputTokens, 50);
});

test("fork restores the inherited active-branch snapshot", async () => {
  const inherited = completedState(100, 1_000);
  const state = { branch: [inherited], allEntries: [inherited] };
  const forked = await loadInstance("fork", state);
  await completeRun(forked, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 150);
});

test("reload ignores newer snapshots from abandoned branches", async () => {
  const active = completedState(100, 1_000);
  const abandoned = completedState(200, 2_000);
  const state = { branch: [active], allEntries: [active, abandoned] };
  const reloaded = await loadInstance("reload", state);
  await completeRun(reloaded, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 150);
});

test("tree navigation restores the selected branch before the next run", async () => {
  const branchA = [completedState(100, 1_000)];
  const branchB = [completedState(200, 2_000)];
  const state = { branch: branchB, allEntries: [...branchA, ...branchB] };
  const instance = await loadInstance("reload", state);

  state.branch = branchA;
  await emit(instance.extension, "session_tree", {
    type: "session_tree",
    oldLeafId: "branch-b",
    newLeafId: "branch-a",
  }, instance.ctx);
  await completeRun(instance, 50);
  assert.equal(latestState(branchA).totalOutputTokens, 150);
});

test("an invalid newest snapshot resets instead of falling back to stale state", async () => {
  const valid = completedState(100, 1_000);
  const invalid = stateEntry({
    totalOutputTokens: 200,
    totalDurationMs: 2_000,
    lastRunTokens: 200,
    lastTps: "invalid",
    lastDurationMs: 2_000,
  });
  const state = { branch: [valid, invalid], allEntries: [valid, invalid] };
  const reloaded = await loadInstance("reload", state);
  await completeRun(reloaded, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 50);
});

test("an unsupported newest snapshot does not roll back to an older schema", async () => {
  const valid = completedState(100, 1_000);
  const unsupported = stateEntry({
    version: 2,
    totalOutputTokens: 200,
    totalDurationMs: 2_000,
    lastRunTokens: 200,
    lastTps: 100,
    lastDurationMs: 2_000,
  });
  const state = { branch: [valid, unsupported], allEntries: [valid, unsupported] };
  const reloaded = await loadInstance("reload", state);
  await completeRun(reloaded, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 50);
});

test("non-object state data does not fall back to an older snapshot", async () => {
  const valid = completedState(100, 1_000);
  const invalid = { type: "custom", customType: STATE_TYPE, data: "invalid" };
  const state = { branch: [valid, invalid], allEntries: [valid, invalid] };
  const reloaded = await loadInstance("reload", state);
  await completeRun(reloaded, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 50);
});

test("internally inconsistent state is rejected atomically", async () => {
  const valid = completedState(100, 1_000);
  const invalid = stateEntry({
    totalOutputTokens: 100,
    totalDurationMs: 1_000,
    lastRunTokens: 0,
  });
  const state = { branch: [valid, invalid], allEntries: [valid, invalid] };
  const reloaded = await loadInstance("reload", state);
  await completeRun(reloaded, 50);
  assert.equal(latestState(state.branch).totalOutputTokens, 50);
});
