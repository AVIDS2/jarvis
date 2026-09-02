import { spawn } from "node:child_process";

const command = process.env.JARVIS_WINDOWS_MCP_COMMAND || "uvx";
const args = process.env.JARVIS_WINDOWS_MCP_ARGS_JSON
  ? JSON.parse(process.env.JARVIS_WINDOWS_MCP_ARGS_JSON)
  : ["--python", "3.14", "--from", "windows-mcp==0.8.5", "windows-mcp", "serve"];

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: { ...process.env, WINDOWS_MCP_WATCHDOG: "off", ANONYMIZED_TELEMETRY: "false" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buffer = "";
let nextId = 1;
const pending = new Map();
let stderr = "";

function rejectAll(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (typeof message.id === "number") {
          const current = pending.get(message.id);
          if (current) {
            pending.delete(message.id);
            clearTimeout(current.timer);
            if (message.error) current.reject(new Error(message.error.message || "MCP error"));
            else current.resolve(message.result || {});
          }
        }
      } catch {
        // Ignore non-protocol diagnostics on stdout.
      }
    }
    newline = buffer.indexOf("\n");
  }
});
child.once("error", rejectAll);
child.once("exit", (code) => rejectAll(new Error(`Windows-MCP exited ${code}: ${stderr.trim()}`)));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 45_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "jarvis-windows-mcp-smoke", version: "0.1.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const tools = await request("tools/list", {});
  const names = (tools.tools || []).map((tool) => tool.name).filter(Boolean);
  const screenshot = await request("tools/call", {
    name: "Screenshot",
    arguments: { use_annotation: false },
  });
  const blocks = Array.isArray(screenshot.content) ? screenshot.content : [];
  const image = blocks.find((block) => block?.type === "image");
  console.log(JSON.stringify({
    ok: true,
    tool_count: names.length,
    has_screenshot_tool: names.includes("Screenshot"),
    has_click_tool: names.includes("Click"),
    has_type_tool: names.includes("Type"),
    returned_image: Boolean(image?.data && image?.mimeType),
    image_mime: image?.mimeType || null,
    image_bytes: image?.data ? Buffer.byteLength(image.data, "base64") : 0,
  }, null, 2));
} finally {
  rejectAll(new Error("Smoke test finished."));
  if (child.pid) {
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const terminator = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const timer = setTimeout(resolve, 4_000);
        terminator.once("close", () => { clearTimeout(timer); resolve(); });
        terminator.once("error", () => { clearTimeout(timer); resolve(); });
      });
    } else {
      child.kill();
    }
  }
}
