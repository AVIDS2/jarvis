import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const bridge = process.env.JARVIS_BRIDGE_URL || "http://127.0.0.1:3030";
const voice = process.env.JARVIS_VOICE_HTTP_URL || "http://127.0.0.1:8111";

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${payload?.error?.message || ""}`);
  return payload;
}

const bridgeHealth = await request(`${bridge}/health`);
const voiceHealth = await request(`${voice}/health`);
assert.equal(bridgeHealth.ok, true);
assert.equal(voiceHealth.status, "ok");
assert.equal(bridgeHealth.model, "mimo-v2.5");
assert.equal(voiceHealth.asr_warmed, true);
assert.equal(voiceHealth.tts_warmed, true);

const extensionCatalog = await request(`${bridge}/v1/extensions`);
const extensionIds = new Set((extensionCatalog.extensions || []).map((extension) => extension.id));
for (const id of ["jarvis_subagents", "jarvis_screen_control", "jarvis_environment_memory", "jarvis_desktop_tools"]) {
  assert.equal(extensionIds.has(id), true, `missing extension: ${id}`);
}

const requiredTools = new Set((await request(`${bridge}/v1/sessions/jarvis-default/tools`)).tools.map((tool) => tool.name));
for (const name of ["retry_task", "cleanup_task_history", "screen_snapshot", "screen_state", "screen_action", "environment_memory", "desktop_tools"]) {
  assert.equal(requiredTools.has(name), true, `missing tool: ${name}`);
}

const created = await request(`${bridge}/v1/sessions`, { method: "POST" });
const id = created.session.sessionId;
try {
  const renamed = await request(`${bridge}/v1/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "foundation-smoke" }),
  });
  assert.equal(renamed.session.sessionName, "foundation-smoke");
  const rebased = await request(`${bridge}/v1/sessions/${encodeURIComponent(id)}/rebase`, { method: "POST" });
  assert.equal(rebased.ok, true);
  const tasks = await request(`${bridge}/v1/sessions/${encodeURIComponent(id)}/tasks`);
  assert.deepEqual(tasks.tasks, []);
} finally {
  await request(`${bridge}/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

let supervisor = "not-run";
try {
  const raw = execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    "scripts/jarvis-supervisor.ps1", "-Mode", "status", "-Json",
  ], { encoding: "utf8" });
  supervisor = JSON.parse(raw).ok ? "healthy" : "degraded";
  assert.equal(supervisor, "healthy");
} catch (error) {
  throw new Error(`supervisor status failed: ${error.message}`);
}

console.log(JSON.stringify({
  ok: true,
  bridge_model: bridgeHealth.model,
  asr_warmed: voiceHealth.asr_warmed,
  tts_warmed: voiceHealth.tts_warmed,
  extensions: [...extensionIds],
  session_crud_rebase: true,
  supervisor,
}, null, 2));
