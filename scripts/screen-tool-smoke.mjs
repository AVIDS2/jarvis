const base = process.env.JARVIS_BRIDGE_URL || "http://127.0.0.1:3030";
let sessionId = "";

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  const created = await request("/v1/sessions", { method: "POST" });
  sessionId = created.session.sessionId;
  await request(`/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ message: "请调用 screen_snapshot 查看当前 Windows 桌面，告诉我当前活动窗口的标题。只做观察，不要执行任何操作。" }),
  });
  const snapshot = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  const toolResults = snapshot.entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
    .map((entry) => entry.message)
    .filter((message) => message.toolName === "screen_snapshot");
  const content = toolResults.flatMap((message) => Array.isArray(message.content) ? message.content : []);
  const image = content.find((block) => block?.type === "image");
  const text = content.filter((block) => block?.type === "text").map((block) => block.text || "").join(" ");
  await request(`/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ message: "请调用 screen_action，执行 action=wait、seconds=0.1，不要点击或输入，然后确认动作完成。" }),
  });
  const actionSnapshot = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  const actionResults = actionSnapshot.entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
    .map((entry) => entry.message)
    .filter((message) => message.toolName === "screen_action");
  const actionContent = actionResults.flatMap((message) => Array.isArray(message.content) ? message.content : []);
  const actionImage = actionContent.find((block) => block?.type === "image");
  console.log(JSON.stringify({
    ok: true,
    session_id: sessionId,
    tool_result_count: toolResults.length,
    returned_image: Boolean(image?.data && image?.mimeType),
    image_mime: image?.mimeType || null,
    image_bytes: image?.data ? Buffer.byteLength(image.data, "base64") : 0,
    text_preview: text.slice(0, 240),
    action_result_count: actionResults.length,
    action_returned_image: Boolean(actionImage?.data && actionImage?.mimeType),
  }, null, 2));
} finally {
  if (sessionId) {
    await request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
  }
}
