import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// bridge.mjs starts an HTTP server on import, so these are source-level
// contracts. They protect the realtime turn's latency and ordering decisions
// and the failure paths that must not reach the spoken turn.
const root = resolve(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(resolve(root, "bridge.mjs"), "utf8");

test("speech-first acknowledgement keeps its explicit latency budget", () => {
  assert.match(source, /const TOOL_ACK_TIMEOUT_MS = 4_000;/);
  assert.match(source, /const TOOL_ACK_AUDIO_LEAD_MS = 900;/);
  // The budget is load-bearing, not incidental: both constants are consumed by
  // the blocking tool_call hook, which is what makes the spoken acknowledgement
  // reach TTS before the tool starts.
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), TOOL_ACK_TIMEOUT_MS\)/);
  assert.match(source, /setTimeout\(resolve, TOOL_ACK_AUDIO_LEAD_MS\)/);
  assert.match(source, /maxTokens: 48/);
});

test("tool acknowledgements are generated, never taken from a fixed template", () => {
  assert.doesNotMatch(source, /acknowledgement\s*=\s*["'`]/);
  assert.match(source, /const acknowledgement = await generateToolAcknowledgement\(/);
  // A failed acknowledgement must still let the tool run.
  assert.match(source, /if \(!acknowledgement \|\| entry\.live !== live \|\| !live\.sendProgress\)/);
});

test("visual work states cannot be published before the spoken acknowledgement", () => {
  assert.match(source, /const queueOrSendVisualState = \(visualEvent, toolName\) => \{/);
  assert.match(source, /live\.visualQueue\.push\(visualEvent\)/);
});

test("long-term memory failures never surface as model failures", () => {
  const saveMemory = source.slice(
    source.indexOf("function saveMemory("),
    source.indexOf("function sse(res, payload)"),
  );
  assert.match(saveMemory, /try \{/);
  assert.match(saveMemory, /catch \(error\) \{/);
  assert.match(saveMemory, /Could not save long-term memory/);
  // Recall must stay inside the realtime budget as well.
  assert.match(source, /const timeout = new Promise\(\(resolve\) => setTimeout\(\(\) => resolve\(null\), MEMORY_RECALL_TIMEOUT_MS\)\)/);
  assert.match(source, /Promise\.race\(\[/);
});

test("long-term writes are bounded, serialized and off the turn path", () => {
  // Mem0's add() is an async enqueue, so only the round trip is ours to bound.
  assert.match(source, /const MEMORY_SAVE_TIMEOUT_MS = Number\(process\.env\.JARVIS_MEMORY_SAVE_TIMEOUT_MS \|\| 10_000\)/);
  assert.match(source, /const MEMORY_SAVE_MAX_PENDING = Number\(process\.env\.JARVIS_MEMORY_SAVE_MAX_PENDING \|\| 8\)/);

  const saveMemory = source.slice(
    source.indexOf("function saveMemory("),
    source.indexOf("function sse(res, payload)"),
  );
  // The SDK calls native fetch with no timeout and no abort signal (its axios
  // instance with `timeout: 6e4` is never used), so the race is what bounds a
  // half-open connection.
  assert.match(saveMemory, /await Promise\.race\(\[/);
  assert.match(saveMemory, /new Promise\(\(_, reject\) => \{/);
  assert.match(saveMemory, /memorySaveState\.pending >= MEMORY_SAVE_MAX_PENDING/);
  // Serialized through a single chain so a fast conversation cannot fan out.
  assert.match(saveMemory, /let memorySaveChain = Promise\.resolve\(\)|memorySaveChain\.then\(/);
  assert.match(saveMemory, /memorySaveChain = task;/);
  // A pending write must never hold the process open at shutdown.
  assert.match(saveMemory, /timer\.unref\?\.\(\)/);
  // Every terminal path releases the slot.
  assert.match(saveMemory, /finally \{/);
  assert.match(saveMemory, /memorySaveState\.pending -= 1;/);

  // The turn must settle on the wire before storage is touched.
  const completion = source.slice(source.indexOf("await entry.session.prompt(userText)"));
  const doneIndex = completion.indexOf('res.write("data: [DONE]\\n\\n")');
  const saveIndex = completion.indexOf("void saveMemory(");
  assert.ok(doneIndex > -1 && saveIndex > -1, "both the terminal frame and the save must exist");
  assert.ok(
    doneIndex < saveIndex,
    "saveMemory must be queued only after the turn is settled on the wire",
  );
  assert.match(completion, /void saveMemory\(userText, assistantText/);
});

test("memory write health is observable without reading a turn", () => {
  assert.match(source, /memorySave: memory \? \{ \.\.\.memorySaveState \} : null/);
  assert.match(source, /const memorySaveState = \{ pending: 0, dropped: 0, lastError: null, lastSavedAt: null \}/);
});

test("an interrupted turn settles as a stop, not as an LLM error", () => {
  assert.match(source, /assistantAborted = event\.message\.stopReason === "aborted"/);
  assert.match(source, /else if \(!disconnected && assistantAborted && live\.abortRequested\) \{/);
  // A genuinely empty turn stays an explicit error.
  assert.match(source, /"empty_response"/);
});
