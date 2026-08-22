const bridge = process.env.JARVIS_BRIDGE_URL || "http://127.0.0.1:3030";

async function request(path, options = {}) {
  const response = await fetch(`${bridge}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

let sessionId;
try {
  const created = await request("/v1/sessions", { method: "POST" });
  sessionId = created.session.sessionId;
  const tools = await request(`/v1/sessions/${sessionId}/tools`);
  const youtube = tools.tools.find((tool) => tool.name === "youtube_media");
  if (!youtube?.active) throw new Error("youtube_media is not active in the Pi session");

  await request(`/v1/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "请使用 youtube_media 搜索“周杰伦 晴天”，只返回搜索结果，不要播放。" }),
  });
  const snapshot = await request(`/v1/sessions/${sessionId}/snapshot`);
  const entries = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.entry) entries.push(node.entry);
      walk(node.children);
    }
  };
  walk(snapshot.tree);
  const toolCall = entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .flatMap((entry) => entry.message.content || [])
    .find((part) => part?.type === "toolCall" && part.name === "youtube_media");
  const toolResult = entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
    .at(-1)?.message?.content?.map((part) => part?.text || "").join("") || "";
  if (!toolCall) throw new Error("Pi did not call youtube_media");
  const parsed = JSON.parse(toolResult);
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) throw new Error("YouTube search returned no results");
  console.log(JSON.stringify({ ok: true, tool_active: true, result_count: parsed.results.length, first_title: parsed.results[0].title }));
} finally {
  if (sessionId) await fetch(`${bridge}/v1/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
}
