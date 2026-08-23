import assert from "node:assert/strict";

const BRIDGE = process.env.JARVIS_BRIDGE_URL || "http://127.0.0.1:3030";
const VOICE_WS = process.env.JARVIS_VOICE_WS_URL || "ws://127.0.0.1:8111/ws/realtime";
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

async function json(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.detail || `HTTP ${response.status}`);
  return payload;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const created = await json(`${BRIDGE}/v1/sessions`, { method: "POST" });
const sessionId = created.session.sessionId;
const events = [];
const socket = new WebSocket(VOICE_WS);

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("voice websocket did not open")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error("voice websocket failed")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    try {
      events.push(JSON.parse(String(event.data)));
    } catch {
      // The realtime protocol uses JSON envelopes for text and base64 PCM.
    }
  });
  socket.send(JSON.stringify({ type: "session.start", client: "async-task-smoke", session_id: sessionId }));
  await waitFor(() => events.find((event) => event.type === "session.ready"), 10_000, "session.ready");

  const promptStarted = performance.now();
  await json(`${BRIDGE}/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: "async-task-smoke",
      message: "请调用 delegate_task，把这个独立任务交给 researcher：使用 bash 等待 8 秒，然后只报告‘异步主动播报验收完成’。提交后立刻简短回复，不要等待后台结果。",
    }),
  });
  const promptElapsedMs = Math.round(performance.now() - promptStarted);
  const afterPrompt = await json(`${BRIDGE}/v1/sessions/${encodeURIComponent(sessionId)}/tasks`);
  const activeAtPromptReturn = afterPrompt.tasks.find((task) => !TERMINAL.has(task.status));
  assert.ok(activeAtPromptReturn, "delegate_task blocked until its worker finished");

  const terminalTask = await waitFor(async () => {
    const payload = await json(`${BRIDGE}/v1/sessions/${encodeURIComponent(sessionId)}/tasks`);
    return payload.tasks.find((task) => TERMINAL.has(task.status)) || null;
  }, 60_000, "background task terminal state");
  assert.equal(terminalTask.status, "completed", terminalTask.error || "background task failed");

  const spokenCompletion = await waitFor(() => events.find((event) => (
    event.type === "assistant.completed"
    && event.source === "background_task"
    && event.task_id === terminalTask.taskId
  )), 30_000, "background proactive assistant completion");
  const audioChunks = events.filter((event) => (
    event.type === "assistant.audio.chunk"
    && event.assistant_request_id === spokenCompletion.request_id
  ));
  assert.ok(audioChunks.length > 0, "background follow-up produced no streamed TTS audio");

  console.log(JSON.stringify({
    ok: true,
    session_id: sessionId,
    prompt_elapsed_ms: promptElapsedMs,
    task_id: terminalTask.taskId,
    task_status: terminalTask.status,
    proactive_text: spokenCompletion.text,
    tts_audio_chunks: audioChunks.length,
  }, null, 2));
} finally {
  socket.close();
  await json(`${BRIDGE}/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
}
