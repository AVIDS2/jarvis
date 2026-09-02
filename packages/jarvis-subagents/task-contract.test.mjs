import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupTaskRecords,
  isTerminalStatus,
  latestTaskRecords,
  parsePiProgressEvent,
  retryRecord,
  TASK_CLEANUP_ENTRY_TYPE,
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
  const lateCancel = transitionRecord({ ...base, status: "completed" }, "cancelled", { error: "late" });
  assert.equal(lateCancel.status, "completed");
});

test("retry explicitly re-queues only failed or interrupted records and keeps the reason", () => {
  const failed = retryRecord({ ...base, status: "failed", attempt: 2, error: "timeout", announced: true }, "network recovered");
  assert.equal(failed.status, "queued");
  assert.equal(failed.attempt, 2);
  assert.equal(failed.retryReason, "network recovered");
  assert.equal(failed.error, undefined);
  assert.equal(failed.announced, false);

  const completed = retryRecord({ ...base, status: "completed" }, "should not run");
  assert.equal(completed.status, "completed");
  assert.equal(completed.retryReason, undefined);
});

test("cleanup keeps newest terminal records per status and never removes active tasks", () => {
  const records = new Map([
    ["running", { ...base, taskId: "running", status: "running", updatedAt: "2026-08-23T00:10:00.000Z" }],
    ["failed-old", { ...base, taskId: "failed-old", status: "failed", updatedAt: "2026-08-23T00:01:00.000Z" }],
    ["failed-new", { ...base, taskId: "failed-new", status: "failed", updatedAt: "2026-08-23T00:02:00.000Z" }],
    ["cancelled-old", { ...base, taskId: "cancelled-old", status: "cancelled", updatedAt: "2026-08-23T00:01:00.000Z" }],
    ["cancelled-new", { ...base, taskId: "cancelled-new", status: "cancelled", updatedAt: "2026-08-23T00:02:00.000Z" }],
  ]);
  const result = cleanupTaskRecords(records, { statuses: ["failed", "cancelled"], keep: 1 });
  assert.deepEqual(result.removedTaskIds.sort(), ["cancelled-old", "failed-old"]);
  assert.deepEqual(result.activeTaskIds, ["running"]);
  assert.equal(result.keptTaskIds.includes("failed-new"), true);
  assert.equal(result.keptTaskIds.includes("running"), false);
});

test("cleanup tombstones survive recovery and suppress later task history", () => {
  const entries = [
    { type: "custom", customType: TASK_ENTRY_TYPE, data: { ...base, status: "failed" } },
    { type: "custom", customType: TASK_CLEANUP_ENTRY_TYPE, data: { removedTaskIds: ["task-1"] } },
  ];
  assert.equal(latestTaskRecords(entries).has("task-1"), false);
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
