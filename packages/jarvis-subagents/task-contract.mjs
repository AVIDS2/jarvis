export const TASK_ENTRY_TYPE = "jarvis-subagent-task";

export const TASK_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function latestTaskRecords(entries) {
  const records = new Map();
  for (const entry of entries || []) {
    if (entry?.type !== "custom" || entry.customType !== TASK_ENTRY_TYPE) continue;
    const record = entry.data;
    if (!record || typeof record.taskId !== "string" || typeof record.status !== "string") continue;
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
