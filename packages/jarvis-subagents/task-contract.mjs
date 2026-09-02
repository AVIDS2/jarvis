export const TASK_ENTRY_TYPE = "jarvis-subagent-task";
export const TASK_CLEANUP_ENTRY_TYPE = "jarvis-subagent-task-cleanup";

export const TASK_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const RETRYABLE_STATUSES = new Set(["failed", "interrupted"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function latestTaskRecords(entries) {
  const records = new Map();
  const removed = new Set();
  for (const entry of entries || []) {
    if (entry?.type === "custom" && entry.customType === TASK_CLEANUP_ENTRY_TYPE) {
      const taskIds = Array.isArray(entry.data?.removedTaskIds) ? entry.data.removedTaskIds : [];
      for (const taskId of taskIds) {
        if (typeof taskId !== "string") continue;
        removed.add(taskId);
        records.delete(taskId);
      }
      continue;
    }
    if (entry?.type !== "custom" || entry.customType !== TASK_ENTRY_TYPE) continue;
    const record = entry.data;
    if (!record || typeof record.taskId !== "string" || typeof record.status !== "string") continue;
    if (removed.has(record.taskId)) continue;
    records.set(record.taskId, { ...record });
  }
  return records;
}

export function transitionRecord(record, status, patch = {}) {
  if (!record || !TASK_STATUSES.includes(status)) throw new Error(`Invalid task status: ${status}`);
  if (isTerminalStatus(record.status) && record.status !== status) return { ...record };
  return {
    ...record,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Start an explicitly requested retry. Retries are intentionally separate from
 * transitionRecord so a terminal task cannot be replayed by a late worker or
 * by session recovery.
 */
export function retryRecord(record, reason = "Manual retry requested") {
  if (!record || !RETRYABLE_STATUSES.has(record.status)) {
    return { ...record };
  }
  const normalizedReason = String(reason || "Manual retry requested").trim().slice(0, 1_000);
  return {
    ...record,
    status: "queued",
    error: undefined,
    result: undefined,
    progress: undefined,
    finishedAt: undefined,
    announced: false,
    retryReason: normalizedReason || "Manual retry requested",
    retryRequestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function recordTime(record) {
  const value = Date.parse(record?.updatedAt || record?.finishedAt || record?.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

/**
 * Select old terminal task records for logical cleanup. `keep` is applied per
 * selected terminal status, preserving the newest records in each bucket.
 * Non-terminal records are always returned in `activeTaskIds` and never enter
 * `removedTaskIds`.
 */
export function cleanupTaskRecords(records, { statuses, keep = 20 } = {}) {
  const source = records instanceof Map ? records : latestTaskRecords(records);
  const selectedStatuses = new Set(
    (Array.isArray(statuses) && statuses.length ? statuses : [...TERMINAL_STATUSES])
      .filter((status) => TERMINAL_STATUSES.has(status)),
  );
  const limit = Math.max(0, Number.isFinite(Number(keep)) ? Math.floor(Number(keep)) : 20);
  const activeTaskIds = [];
  const removedTaskIds = [];
  const keptTaskIds = [];

  for (const [taskId, record] of source.entries()) {
    if (!isTerminalStatus(record?.status)) {
      activeTaskIds.push(taskId);
      continue;
    }
    if (!selectedStatuses.has(record.status)) {
      keptTaskIds.push(taskId);
    }
  }

  for (const status of selectedStatuses) {
    const matching = [...source.entries()]
      .filter(([, record]) => record?.status === status)
      .sort(([, left], [, right]) => recordTime(right) - recordTime(left));
    for (const [index, [taskId]] of matching.entries()) {
      if (index < limit) keptTaskIds.push(taskId);
      else removedTaskIds.push(taskId);
    }
  }

  return {
    statuses: [...selectedStatuses],
    keep: limit,
    activeTaskIds,
    keptTaskIds: [...new Set(keptTaskIds)],
    removedTaskIds: [...new Set(removedTaskIds)],
  };
}

export function parsePiProgressEvent(value) {
  if (!value || typeof value !== "object") return null;
  const event = value;
  if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
    return {
      kind: "tool_start",
      toolName: event.toolName,
      toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    };
  }
  if (event.type === "tool_execution_update" && typeof event.toolName === "string") {
    return {
      kind: "tool_update",
      toolName: event.toolName,
      toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    };
  }
  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    return {
      kind: "tool_end",
      toolName: event.toolName,
      toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
      isError: event.isError === true,
    };
  }
  if (event.type === "message_start" && event.message?.role === "assistant") {
    return { kind: "assistant_start" };
  }
  return null;
}
