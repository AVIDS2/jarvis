# Jarvis Subagents

This Pi package provides asynchronous project-local subagent work without creating a second main session.

`delegate_task` persists every task state transition as a `jarvis-subagent-task` custom entry. The child Pi process runs with `--no-session`; it is a disposable worker, not a second persistent conversation. The main session receives only the final structured result through Pi's standard `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` path.

The package also emits `jarvis:task-event` for live progress and accepts `jarvis:task-cancel` events. Queued or running tasks found during `session_start` are marked `interrupted`; they are never silently re-run. `session_shutdown` terminates worker process trees and prevents an old extension instance from sending messages into a replacement session.

The worker model follows the existing product configuration: project agent `model` first, then the main session model, then the existing MiMo fallback. Luna is a development subagent choice, not a product runtime requirement.

Task lifecycle tools:

- `retry_task` only re-queues `failed` or `interrupted` tasks after an explicit
  request. There is no automatic replay after failure, timeout, or restart.
- Each task record keeps its current `attempt`, `retryReason`, retry timestamp,
  and a bounded `attemptHistory` with start/end status and reason.
- `cleanup_task_history` keeps the newest N records per selected terminal
  status. Queued and running tasks are never removed. Pi sessions are
  append-only, so cleanup writes a tombstone entry consumed by the task index;
  it does not rewrite or delete the session file.

Runtime limits are configurable without changing the package:

- `JARVIS_SUBAGENT_TIMEOUT_MS` defaults to 300000 (five minutes).
- `JARVIS_SUBAGENT_MAX_CONCURRENCY` defaults to 2.
