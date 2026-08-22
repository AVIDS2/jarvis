import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Type } from "typebox";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolContent = TextContent | ImageContent;
type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number;
  result?: { content?: unknown[]; isError?: boolean; [key: string]: unknown };
  error?: { code?: number; message?: string; data?: unknown };
};
type PendingRequest = {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PACKAGE_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 45_000;
const IDLE_SHUTDOWN_MS = 30_000;
const MAX_TEXT_CHARS = 18_000;

function parseArgs(value: string | undefined): string[] | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    throw new Error("JARVIS_WINDOWS_MCP_ARGS_JSON must be a JSON string array.");
  }
  throw new Error("JARVIS_WINDOWS_MCP_ARGS_JSON must be a JSON string array.");
}

function commandSpec(): { command: string; args: string[] } {
  const command = process.env.JARVIS_WINDOWS_MCP_COMMAND?.trim() || "uvx";
  const args = parseArgs(process.env.JARVIS_WINDOWS_MCP_ARGS_JSON)
    || ["--python", "3.14", "--from", "windows-mcp==0.8.5", "windows-mcp", "serve"];
  return { command, args };
}

function abortError(): Error {
  const error = new Error("Screen operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function textContent(text: string): TextContent {
  return { type: "text", text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[screen output truncated]` : text };
}

function normalizeContent(value: unknown): ToolContent[] {
  if (!Array.isArray(value)) return [textContent(JSON.stringify(value ?? {}))];
  const content: ToolContent[] = [];
  for (const block of value) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      content.push(textContent(item.text));
      continue;
    }
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return content.length ? content : [textContent("Windows-MCP returned no readable content.")];
}

function responseError(response: JsonRpcResponse): Error | null {
  if (response.error) return new Error(response.error.message || "Windows-MCP JSON-RPC request failed.");
  if (response.result?.isError) {
    const text = normalizeContent(response.result.content).filter((item) => item.type === "text").map((item) => item.text).join(" ");
    return new Error(text || "Windows-MCP reported an operation error.");
  }
  return null;
}

class WindowsMcpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderr = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolContent[]> {
    this.clearIdleTimer();
    await this.ensureStarted(signal);
    try {
      const response = await this.request("tools/call", { name, arguments: args }, signal);
      const failure = responseError(response);
      if (failure) throw failure;
      return normalizeContent(response.result?.content);
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.rejectPending(new Error("Windows-MCP client stopped."));
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolve) => {
        const terminator = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const timer = setTimeout(resolve, 4_000);
        terminator.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        terminator.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } else {
      child.kill();
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.stop();
    }, IDLE_SHUTDOWN_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    if (!this.startPromise) {
      this.startPromise = this.start(signal).finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    const { command, args } = commandSpec();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WINDOWS_MCP_WATCHDOG: process.env.WINDOWS_MCP_WATCHDOG || "off",
        ANONYMIZED_TELEMETRY: process.env.ANONYMIZED_TELEMETRY || "false",
      },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    child.once("error", (error) => this.rejectPending(error));
    child.once("exit", (code, reason) => {
      const detail = this.stderr.trim();
      this.rejectPending(new Error(`Windows-MCP exited (${code ?? reason ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      if (this.child === child) this.child = null;
    });
    try {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "jarvis-screen-control", version: PACKAGE_VERSION },
      }, signal);
      this.notify("notifications/initialized", {});
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (typeof message.id === "number") this.resolve(message.id, message);
        } catch {
          // FastMCP stdio is newline-delimited JSON. Ignore non-protocol diagnostics.
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error("Windows-MCP sidecar is not running."));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows-MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const abort = () => {
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private resolve(id: number, response: JsonRpcResponse): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const screenActionParameters = Type.Object({
  action: Type.Union([
    Type.Literal("click"), Type.Literal("type"), Type.Literal("scroll"), Type.Literal("move"),
    Type.Literal("shortcut"), Type.Literal("wait"), Type.Literal("wait_for"), Type.Literal("app"),
  ]),
  loc: Type.Optional(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
  label: Type.Optional(Type.Integer({ minimum: 0 })),
  text: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  keys: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
  clear: Type.Optional(Type.Boolean()),
  press_enter: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
  clicks: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
  wheel_times: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })),
  condition: Type.Optional(Type.String()),
  window_name: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("launch"), Type.Literal("resize"), Type.Literal("switch")])),
  name: Type.Optional(Type.String()),
  observe_after: Type.Optional(Type.Boolean()),
});

function actionCall(input: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  const action = String(input.action || "");
  const common = Object.fromEntries(Object.entries(input).filter(([key]) => ["loc", "label"].includes(key)));
  switch (action) {
    case "click": return { tool: "Click", args: { ...common, button: input.button || "left", clicks: input.clicks ?? 1 } };
    case "type": return { tool: "Type", args: { ...common, text: String(input.text || ""), clear: input.clear ?? false, press_enter: input.press_enter ?? false } };
    case "scroll": return { tool: "Scroll", args: { ...common, direction: input.direction || "down", wheel_times: input.wheel_times ?? 1 } };
    case "move": return { tool: "Move", args: { ...common } };
    case "shortcut": return { tool: "Shortcut", args: { keys: input.keys || (input.key ? [input.key] : []) } };
    case "wait": return { tool: "Wait", args: { seconds: input.seconds ?? 1 } };
    case "wait_for": return { tool: "WaitFor", args: { condition: input.condition || "text_exists", text: input.text, window_name: input.window_name, timeout: input.seconds ?? 10 } };
    case "app": return { tool: "App", args: { mode: input.mode || "launch", name: input.name } };
    default: throw new Error(`Unsupported screen action: ${action}`);
  }
}

function appendObservation(content: ToolContent[], observation: ToolContent[]): ToolContent[] {
  return [...content, textContent("\nCurrent screen after the action:"), ...observation];
}

export default function screenControl(pi: ExtensionAPI) {
  const client = new WindowsMcpStdioClient();

  pi.registerTool({
    name: "screen_snapshot",
    label: "Screen Snapshot",
    description: "Capture the current Windows desktop as an image for MiMo, with cursor position and active-window context.",
    promptSnippet: "Inspect the current Windows desktop visually before a screen task.",
    promptGuidelines: [
      "Use screen_snapshot before acting on an unfamiliar desktop or application; its image is the current screen, not a textual approximation.",
      "Use screen_snapshot only for an explicit screen/computer task. Do not poll the screen during ordinary conversation or voice turns.",
      "After a screen_action, inspect the returned post-action image before claiming the task is complete.",
    ],
    parameters: Type.Object({
      annotated: Type.Optional(Type.Boolean({ description: "Draw UI annotations when useful for coordinate grounding." })),
    }),
    async execute(_toolCallId, input, signal) {
      return { content: await client.call("Screenshot", { use_annotation: input.annotated ?? false }, signal) };
    },
  });

  pi.registerTool({
    name: "screen_state",
    label: "Screen State",
    description: "Inspect the Windows desktop with a screenshot and UI Automation state for interactive controls and their labels.",
    promptSnippet: "Inspect desktop screenshot plus Windows UI elements before a precise action.",
    promptGuidelines: [
      "Use screen_state when labels, focused windows, or interactive element coordinates matter more than a fast screenshot.",
      "Prefer UI labels from screen_state over guessing coordinates; use the returned screenshot to verify visual context.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _input, signal) {
      return { content: await client.call("Snapshot", { use_vision: true, use_annotation: true, use_ui_tree: true }, signal) };
    },
  });

  pi.registerTool({
    name: "screen_action",
    label: "Screen Action",
    description: "Perform a typed Windows desktop action through Windows-MCP and optionally return a fresh screenshot for visual verification.",
    promptSnippet: "Click, type, scroll, move, use a shortcut, wait, or manage a Windows app, then verify the screen.",
    promptGuidelines: [
      "Use screen_action only after the user has asked for a concrete computer operation and the target is grounded by screen_snapshot or screen_state.",
      "Use the smallest precise action. Do not invent coordinates when the latest screen state provides a label or coordinate.",
      "Keep observe_after enabled unless the action is a harmless intermediate movement; verify the resulting screenshot before reporting success.",
      "Do not use screen_action for shell/file tasks already covered by Pi's native tools.",
    ],
    parameters: screenActionParameters,
    async execute(_toolCallId, input, signal, onUpdate) {
      onUpdate?.({ content: [textContent(`正在执行屏幕动作：${String(input.action)}…`)] });
      const { tool, args } = actionCall(input as Record<string, unknown>);
      const content = await client.call(tool, args, signal);
      if (input.observe_after === false || tool === "Wait") return { content };
      const observation = await client.call("Screenshot", { use_annotation: false }, signal);
      return { content: appendObservation(content, observation) };
    },
  });

  pi.on("session_shutdown", async () => {
    await client.stop();
  });
}
