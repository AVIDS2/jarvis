const BASE_URL = process.env.JARVIS_BRIDGE_URL || "http://127.0.0.1:3030";

async function jsonRequest(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `${init?.method || "GET"} ${path} failed`);
  }
  return payload;
}

let sessionId;
try {
  const created = await jsonRequest("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: "{}",
  });
  sessionId = created.session.sessionId;

  const tools = await jsonRequest(`/v1/sessions/${sessionId}/tools`);
  const musicTool = tools.tools.find((tool) => tool.name === "netease_music");
  if (!musicTool?.active) throw new Error("netease_music is not active in the Pi session");

  await jsonRequest(`/v1/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      message: "请调用网易云音乐工具执行下一首，并如实说明工具返回的结果。",
    }),
  });

  const snapshot = await jsonRequest(`/v1/sessions/${sessionId}/snapshot`);
  const toolResult = snapshot.entries.find(
    (entry) => entry.type === "message"
      && entry.message?.role === "toolResult"
      && entry.message?.toolName === "netease_music",
  )?.message;
  if (!toolResult) throw new Error("Pi did not call netease_music");
  if (toolResult.isError !== true) {
    throw new Error("NetEase CLI failure was not preserved as a Pi tool error");
  }

  console.log(JSON.stringify({
    ok: true,
    session_id: sessionId,
    tool_active: true,
    tool_error_preserved: true,
    tool_result: toolResult.content,
  }, null, 2));
} finally {
  if (sessionId) {
    await jsonRequest(`/v1/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
  }
}
