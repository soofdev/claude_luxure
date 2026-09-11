/** Offline protocol replay through the real bridge and provider handlers.
 * Run: node --test scripts/test-codex-activity.mjs */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "luxure-activity-test-"));
after(() => rm(dir, { recursive: true, force: true }));
await build({
  stdin: {
    contents: 'export { CodexBridge } from "./src/cli/codex-bridge"; export { ChatViewProvider } from "./src/webview/ChatViewProvider";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "ts",
  },
  outfile: join(dir, "test.cjs"), bundle: true, platform: "node", format: "cjs",
  external: ["node-llama-cpp"],
  plugins: [{
    name: "offline-host",
    setup(b) {
      b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
      b.onResolve({ filter: /(?:^|\/)logger$/ }, () => ({ path: "logger", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
        contents: path === "logger" ? "export function log() {} export function clearLog() {}" : "module.exports = {};",
      }));
    },
  }],
});
const { CodexBridge, ChatViewProvider } = createRequire(import.meta.url)(join(dir, "test.cjs"));

function harness(t) {
  const bridge = new CodexBridge({ cwd: tmpdir(), sessionId: "parent" });
  bridge.proc = { stdin: { destroyed: false }, killed: false, exitCode: null };
  bridge._status = "busy";
  bridge._turnId = "parent-turn";
  const runtime = {
    bridge, sessionId: "parent", cliStatus: "busy", streamingMessageId: "answer",
    currentStreamText: "Building the page.", currentActivities: [], currentTimeline: [],
    messages: [
      { id: "user", role: "user", content: "Build the page", timestamp: Date.now() - 360_000 },
      { id: "answer", role: "assistant", content: "Building the page.", isStreaming: true, timestamp: Date.now() - 360_000 },
    ],
    markerEmoji: "🧪", checkpoints: [],
  };
  const sent = [];
  const provider = Object.create(ChatViewProvider.prototype);
  Object.assign(provider, {
    isActiveKey: () => true,
    postMessage: (message) => sent.push(structuredClone(message)),
    sendState() {}, sendOpenTabs() {}, refreshMcpStatus() {}, persistRuntime() {},
    pollUsageForActive: async () => {},
    paneActive: ["parent", null], focusedPane: 0,
    context: { workspaceState: { update() {} } },
    diffManager: { getPendingDiffs: () => [] },
    outputChannel: { appendLine() {} },
  });
  provider.attachBridgeHandlers("parent", runtime, bridge);
  t.after(() => provider.clearStreamWatchdog(runtime));
  const emit = (method, params = {}) => bridge.parseLine(JSON.stringify({ method, params: { threadId: "parent", ...params } }));
  const item = (value, phase = "completed", threadId = "parent") => emit(`item/${phase}`, { threadId, item: value });
  const task = (threadId = "child") => provider.findTaskActivity(runtime, undefined, threadId)?.task;
  return { bridge, runtime, provider, sent, emit, item, task };
}

function spawn(h, type = "collabAgentToolCall") {
  h.item({ type, id: "spawn-1", tool: "spawnAgent", status: "completed",
    receiverThreadIds: ["child"], prompt: "Audit the page accessibility",
    agentsStates: { child: { status: "running", message: null } } });
}

test("three minutes of silence never marks a live Codex turn or its agents Done", (t) => {
  const h = harness(t);
  spawn(h);
  h.provider.fireStreamWatchdog("parent", h.runtime);
  assert.equal(h.runtime.streamingMessageId, "answer");
  assert.equal(h.runtime.messages[1].isStreaming, true);
  assert.equal(h.task().status, "running");
  assert.equal(h.sent.some((m) => m.type === "streamEnd"), false);
  assert.ok(h.runtime.watchdogTimer);
});

test("spawn and wait calls preserve one running agent card until its actual completion", (t) => {
  const h = harness(t);
  spawn(h);
  assert.equal(h.task().status, "running");
  assert.equal(h.task().background, true);
  h.item({ type: "collabAgentToolCall", id: "wait-1", tool: "wait", status: "completed",
    receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } });
  assert.equal(h.runtime.currentActivities.filter((a) => a.type === "task").length, 1);
  assert.equal(h.task().status, "running");
  h.item({ type: "subAgentActivity", id: "done-1", agentThreadId: "child", agentPath: "/root/audit", kind: "completed" });
  assert.equal(h.task().status, "completed");
  // A delayed snapshot must not restart an already completed agent.
  spawn(h);
  assert.equal(h.task().status, "completed");
});

test("sub-agent lifecycle items track the child lifetime, not their own item completion", (t) => {
  const h = harness(t);
  h.item({ type: "subAgentActivity", id: "start", agentThreadId: "child", agentPath: "/root/audit", kind: "started" });
  assert.equal(h.task().status, "running");
  h.item({ type: "subAgentActivity", id: "interrupt", agentThreadId: "child", kind: "interrupted" });
  assert.equal(h.task().status, "failed");
  h.item({ type: "subAgentActivity", id: "resume", agentThreadId: "child", kind: "started" });
  assert.equal(h.task().status, "running");
});

test("child tools nest under their agent and child replies/completions never end the parent", (t) => {
  const h = harness(t);
  spawn(h);
  h.emit("thread/started", { threadId: "child", thread: { id: "child" } });
  h.emit("turn/started", { threadId: "child", turn: { id: "child-turn" } });
  h.emit("item/agentMessage/delta", { threadId: "child", itemId: "child-answer", delta: "Child-only prose" });
  const command = { type: "commandExecution", id: "child-command", command: "npm test" };
  h.item(command, "started", "child");
  h.item({ ...command, exitCode: 0, aggregatedOutput: "Tests passed" }, "completed", "child");
  assert.equal(h.task().children[0].toolInput.command, "npm test");
  assert.equal(h.task().children[0].result.content, "Tests passed");
  assert.equal(h.task().toolUses, 1);
  h.emit("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "completed" } });
  assert.equal(h.task().status, "completed");
  assert.equal(h.bridge.sessionId, "parent");
  assert.equal(h.bridge.status, "busy");
  assert.equal(h.runtime.currentStreamText, "Building the page.");
  assert.equal(h.runtime.streamingMessageId, "answer");
});

test("unrelated threads and stale turn completions cannot change the active parent", (t) => {
  const h = harness(t);
  h.emit("thread/started", { threadId: "other", thread: { id: "other" } });
  h.emit("thread/status/changed", { threadId: "other", status: { type: "idle" } });
  h.emit("turn/completed", { threadId: "other", turn: { id: "other-turn", status: "completed" } });
  h.emit("turn/completed", { turn: { id: "stale-parent-turn", status: "completed" } });
  assert.equal(h.bridge.sessionId, "parent");
  assert.equal(h.bridge.status, "busy");
  assert.equal(h.runtime.streamingMessageId, "answer");
});

test("fast child commands without a start still show once with their output", (t) => {
  const h = harness(t);
  spawn(h);
  const command = { type: "commandExecution", id: "fast", command: "pwd", exitCode: 0, aggregatedOutput: "/workspace" };
  h.item(command, "completed", "child");
  assert.equal(h.task().children.length, 1);
  assert.equal(h.task().children[0].result.content, "/workspace");
  assert.equal(h.task().toolUses, 1);
});

test("an explicit follow-up can restart a completed agent", (t) => {
  const h = harness(t);
  spawn(h);
  h.item({ type: "subAgentActivity", id: "done", agentThreadId: "child", kind: "completed" });
  h.item({ type: "collabAgentToolCall", id: "followup", tool: "followupTask", status: "completed",
    receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } });
  assert.equal(h.task().status, "running");
});

test("an agent finishing after its parent updates the saved card without starting a fake turn", (t) => {
  const h = harness(t);
  spawn(h);
  h.emit("turn/completed", { turn: { id: "parent-turn", status: "completed" } });
  assert.equal(h.runtime.streamingMessageId, null);
  assert.equal(h.runtime.messages[1].isStreaming, false);
  assert.equal(h.task().status, "running");
  h.item({ type: "collabAgentToolCall", id: "wait-done", tool: "wait", status: "completed",
    receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "Audit passed" } } });
  assert.equal(h.task().status, "completed");
  assert.equal(h.task().progressSummary, "Audit passed");
  assert.equal(h.runtime.streamingMessageId, null);
  assert.ok(h.sent.some((m) => m.type === "taskUpdate" && m.messageId === "answer" && m.task.status === "completed"));
});

test("reasoning with no text still shows thinking and plan updates reach the timeline", (t) => {
  const h = harness(t);
  h.item({ type: "reasoning", id: "reason", summary: [], content: [] }, "started");
  assert.equal(h.runtime.currentActivities[0].type, "thinking");
  h.emit("turn/plan/updated", { turnId: "parent-turn", plan: [{ step: "Check the logs", status: "inProgress" }] });
  assert.deepEqual(h.runtime.currentActivities.at(-1).toolInput.todos, [{ content: "Check the logs", status: "in_progress" }]);
});

test("older collabToolCall schemas also keep launched agents running", (t) => {
  const h = harness(t);
  h.item({ type: "collabToolCall", id: "legacy-spawn", tool: "spawnAgent", status: "completed",
    newThreadId: "child", agentStatus: "running", prompt: "Check layout" });
  assert.equal(h.task().status, "running");
});

test("failed spawns surface a failed card", (t) => {
  const h = harness(t);
  h.item({ type: "collabAgentToolCall", id: "bad-spawn", tool: "spawnAgent", status: "failed", receiverThreadIds: [] });
  const failed = h.provider.findTaskActivity(h.runtime, "bad-spawn").task;
  assert.equal(failed.status, "failed");
});

test("a dead process still settles its stream and running agents", (t) => {
  const h = harness(t);
  spawn(h);
  h.bridge.proc = null;
  h.bridge.emit("status", "stopped");
  assert.equal(h.runtime.streamingMessageId, null);
  assert.equal(h.task().status, "failed");
});
