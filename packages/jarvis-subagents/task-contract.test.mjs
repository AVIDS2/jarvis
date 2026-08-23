import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalStatus,
  latestTaskRecords,
  parsePiProgressEvent,
  TASK_ENTRY_TYPE,
  transitionRecord,
} from "./task-contract.mjs";

const base = {
  taskId: "task-1",
  agent: "researcher",
  task: "inspect",
  status: "queued",
  attempt: 0,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

test("task entries are the latest durable fact per task", () => {
  const records = latestTaskRecords([
    { type: "custom", customType: TASK_ENTRY_TYPE, data: base },
    { type: "custom", customType: TASK_ENTRY_TYPE, data: { ...base, status: "running" } },
    { type: "custom", customType: "other", data: { taskId: "task-2", status: "completed" } },
  ]);
  assert.equal(records.get("task-1").status, "running");
  assert.equal(records.has("task-2"), false);
});

test("terminal status cannot be overwritten by a late worker event", () => {
  const completed = transitionRecord({ ...base, status: "completed" }, "failed", { error: "late" });
  assert.equal(completed.status, "completed");
  assert.equal(isTerminalStatus(completed.status), true);
});

test("cancelled is a terminal transition", () => {
  const cancelled = transitionRecord(base, "cancelled", { error: "requested" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(isTerminalStatus(cancelled.status), true);
});

test("Pi JSON tool events become structured progress without text guessing", () => {
  assert.deepEqual(parsePiProgressEvent({ type: "tool_execution_start", toolName: "read", toolCallId: "c1" }), {
    kind: "tool_start",
    toolName: "read",
    toolCallId: "c1",
  });
  assert.equal(parsePiProgressEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }), null);
  assert.equal(parsePiProgressEvent({ type: "tool_execution_start", text: "fake" }), null);
});

test("tool progress never persists raw partial results", () => {
  const progress = parsePiProgressEvent({
    type: "tool_execution_update",
    toolName: "screen_snapshot",
    toolCallId: "c2",
    partialResult: { content: [{ type: "image", data: "base64-payload" }] },
  });
  assert.deepEqual(progress, {
    kind: "tool_update",
    toolName: "screen_snapshot",
    toolCallId: "c2",
  });
});
