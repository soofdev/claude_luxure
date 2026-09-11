/** Browser replay of the shipped App (no CLI/API calls).
 * Start webview Vite on :5199, then run this script. PLAYWRIGHT_MODULE and
 * CHROMIUM_BIN can point to an existing local Playwright/browser install. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROOF_DIR || join(tmpdir(), "luxure-codex-activity-proof");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 840 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
  });
  await page.clock.install();
  await page.goto(process.env.LUXURE_UI_URL || "http://127.0.0.1:5199");
  await page.locator("textarea:not([aria-hidden])").waitFor();
  const harness = await readFile(new URL("../webview-ui/harness.html", import.meta.url), "utf8");
  await page.addStyleTag({ content: harness.match(/<style>([\s\S]*?)<\/style>/)[1] });
  const send = (message) => page.evaluate((data) => window.postMessage(data, "*"), message);
  const now = await page.evaluate(() => Date.now());
  const text = "The export has 14,145 records. I’m building search, expandable tool activity, and saved review notes.";
  const state = {
    mode: "agent", provider: "codex", model: "gpt-6-astra", effort: "max",
    modelOptions: [{ id: "gpt-6-astra", label: "GPT-6-Astra" }],
    activeTabId: "audit", sessionId: "audit", cliStatus: "busy", pendingDiffs: [],
    isStreaming: true, streamingText: text, runningSessionIds: ["audit"],
    messages: [
      { id: "u", role: "user", content: "Build an HTML page to audit the conversations in this export.", timestamp: now - 364_000 },
      { id: "a", role: "assistant", content: text, timestamp: now - 360_000, isStreaming: true },
    ],
    liveTimeline: [
      { type: "text", text: "I’ll build a conversation audit page with search, filters, and a readable message view." },
      { type: "activities", activities: [{ type: "tool_use", toolName: "Bash", toolInput: { command: "Inspect conversation export" }, toolUseId: "inspect", result: { content: "14,145 records" } }] },
      { type: "text", text },
    ],
    liveActivities: [],
  };
  await send({ type: "openTabs", tabIds: ["audit"], names: { audit: "Conversation audit" } });
  await send({ type: "state", state });
  await page.getByTestId("run-status").waitFor();
  // Reproduce a gap longer than the old watchdog without waiting in real time.
  await page.clock.fastForward(185_000);
  await page.waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.textContent.includes("No new updates"));
  assert.match(await page.getByTestId("run-status").innerText(), /Working[\s\S]*9m/);
  assert.equal(await page.getByText(/^Done ·/).count(), 0);
  await page.screenshot({ path: join(output, "codex-quiet-turn.png") });

  await send({ type: "activity", activity: { type: "thinking", text: "" } });
  await page.waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.textContent.includes("Thinking"));
  await send({ type: "streamToken", text: "\n\nThe page is ready for testing." });
  await page.waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.textContent.includes("Working"));

  const task = {
    type: "task", toolUseId: "codex-agent-audit", taskId: "child-audit", subagentType: "Codex",
    description: "Check accessibility of the conversation viewer", prompt: "Review the viewer’s keyboard navigation and filters.",
    status: "running", background: true, progressSummary: "Checking keyboard navigation", toolUses: 3,
    children: [{ type: "tool_use", toolName: "Bash", toolInput: { command: "npm test" }, result: { content: "Keyboard tests passed" } }],
  };
  await send({ type: "taskUpdate", task });
  await page.getByText("1 agent working", { exact: true }).waitFor();
  await page.locator("#task-codex-agent-audit button").first().click();
  await page.getByText("Review the viewer’s keyboard navigation and filters.", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "codex-live-agent.png") });

  await page.setViewportSize({ width: 420, height: 820 });
  assert.ok(await page.getByTestId("run-status").isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(output, "codex-live-agent-narrow.png") });

  // A real end hides the timer, while a background task stays visible.
  await send({ type: "streamEnd" });
  await send({ type: "state", state: {
    ...state, isStreaming: false, streamingText: "", cliStatus: "ready", liveTimeline: [], liveActivities: [],
    messages: [state.messages[0], { ...state.messages[1], isStreaming: false, timeline: [
      ...state.liveTimeline, { type: "activities", activities: [task] },
    ], turnStats: { durationMs: 545_000 } }],
  } });
  await page.getByTestId("run-status").waitFor({ state: "detached" });
  await page.getByText("1 agent working", { exact: true }).waitFor();
  await send({ type: "taskUpdate", messageId: "a", task: { ...task, status: "completed", progressSummary: "Accessibility review passed" } });
  await page.getByText("1 agent working", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ["silent turn stays visible", "live agent card", "narrow viewport", "real completion", "background completion"], screenshots: output }));
} finally {
  await browser.close();
}
