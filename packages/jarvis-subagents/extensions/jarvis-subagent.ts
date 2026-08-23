import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import {
  isTerminalStatus,
  latestTaskRecords,
  parsePiProgressEvent,
  TASK_ENTRY_TYPE,
  transitionRecord,
} from "../task-contract.mjs";

const MAX_TASK_CHARS = 8_000;
const MAX_RESULT_CHARS = 12_000;
const SUBAGENT_TIMEOUT_MS = Math.max(30_000, Number(process.env.JARVIS_SUBAGENT_TIMEOUT_MS || 300_000));
const MAX_CONCURRENT_TASKS = Math.max(1, Number(process.env.JARVIS_SUBAGENT_MAX_CONCURRENCY || 2));

const parameters = Type.Object({
  agent: Type.String({ description: "Name of a project-local subagent from .pi/agents." }),
  task: Type.String({ description: "Self-contained delegated task with the necessary context and expected result." }),
});

const cancelParameters = Type.Object({
  taskId: Type.String({ description: "Task ID returned by delegate_task." }),
});

type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

interface TaskRecord {
  taskId: string;
  agent: string;
  task: string;
  status: TaskStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  progress?: unknown;
  announced?: boolean;
  sessionFile?: string;
}

interface TaskRuntime {
  record: TaskRecord;
  controller: AbortController;
  child?: ReturnType<typeof spawn>;
  tempDir?: string;
  settled: boolean;
}

interface WorkerConfig {
  cwd: string;
  model: string;
}

function lastAssistantText(value: unknown): string {
  const event = value as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
  if (event.type !== "message_end" || event.message?.role !== "assistant") return "";
  return (event.message.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function truncate(value: string): string {
  if (value.length <= MAX_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_RESULT_CHARS)}\n\n[子代理结果已截断]`;
}

function stopChildProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (process.platform !== "win32" || !child.pid) {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const terminator = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    terminator.once("close", () => resolve());
    terminator.once("error", () => resolve());
  });
}

function now(): string {
  return new Date().toISOString();
}

function modelFor(agent: AgentConfig, ctx: ExtensionContext): string {
  return agent.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "xiaomi/mimo-v2.5");
}

export default function jarvisSubagents(pi: ExtensionAPI) {
  const tasks = new Map<string, TaskRuntime>();
  let active = true;
  let generation = randomUUID();
  let sessionFile: string | undefined;

  const emitTaskEvent = (event: Record<string, unknown>) => {
    pi.events.emit("jarvis:task-event", event);
  };

  const appendTask = (record: TaskRecord, event: Record<string, unknown>) => {
    pi.appendEntry(TASK_ENTRY_TYPE, record);
    emitTaskEvent({ ...event, task: record });
  };

  const updateTask = (taskId: string, status: TaskStatus, patch: Record<string, unknown> = {}, event = "state") => {
    const runtime = tasks.get(taskId);
    if (!runtime) return;
    const next = transitionRecord(runtime.record, status, patch) as TaskRecord;
    if (next.status === runtime.record.status && isTerminalStatus(runtime.record.status) && status !== runtime.record.status) return;
    runtime.record = next;
    appendTask(next, { event, taskId });
  };

  const announce = (runtime: TaskRuntime) => {
    if (!active || runtime.record.announced || !isTerminalStatus(runtime.record.status)) return;
    const record = runtime.record;
    pi.sendMessage(
      {
        customType: "jarvis-subagent-result",
        content: `后台子代理任务 ${record.taskId} ${record.status === "completed" ? "已完成" : "已结束"}。\n\n${record.result || record.error || "没有可用结果。"}`,
        display: false,
        details: {
          taskId: record.taskId,
          agent: record.agent,
          status: record.status,
          result: record.result,
          error: record.error,
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    updateTask(record.taskId, record.status, { announced: true }, "announced");
  };

  const cancelTask = async (taskId: string, reason = "Cancelled by request") => {
    const runtime = tasks.get(taskId);
    if (!runtime || isTerminalStatus(runtime.record.status)) return false;
    runtime.settled = true;
    runtime.controller.abort();
    updateTask(taskId, "cancelled", { error: reason, finishedAt: now() }, "cancelled");
    if (runtime.child) await stopChildProcessTree(runtime.child);
    return true;
  };

  const runTask = async (runtime: TaskRuntime, agent: AgentConfig, task: string, worker: WorkerConfig) => {
    const { taskId } = runtime.record;
    let stdoutBuffer = "";
    let stderr = "";
    let finalText = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminateReason: "cancelled" | "timeout" | undefined;
    const taskGeneration = generation;

    try {
      runtime.tempDir = await mkdtemp(join(tmpdir(), "jarvis-subagent-"));
      if (!active || generation !== taskGeneration || runtime.settled) return;
      const promptPath = join(runtime.tempDir, "system-prompt.md");
      const systemPrompt = `${agent.systemPrompt.trim()}\n\nYou are an isolated Jarvis subagent. Complete only the delegated task. Do not converse with the user and do not expose chain-of-thought. Return a concise factual report for the main assistant.`;
      await writeFile(promptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });
      if (!active || generation !== taskGeneration || runtime.settled) return;

      const piCliPath = process.env.JARVIS_PI_CLI_PATH;
      if (!piCliPath) throw new Error("JARVIS_PI_CLI_PATH is not configured");
      const args = ["--mode", "json", "-p", "--no-session", "--model", worker.model, "--thinking", "off"];
      if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
      args.push("--append-system-prompt", promptPath, `Task: ${task}`);

      updateTask(taskId, "running", { startedAt: now(), attempt: runtime.record.attempt + 1 }, "started");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [piCliPath, ...args], {
          cwd: worker.cwd,
          env: process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        runtime.child = child;
        const abort = () => {
          terminateReason = "cancelled";
          void stopChildProcessTree(child);
        };
        runtime.controller.signal.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => {
          terminateReason = "timeout";
          void stopChildProcessTree(child);
        }, SUBAGENT_TIMEOUT_MS);

        child.stdout.on("data", (chunk) => {
          stdoutBuffer += String(chunk);
          let newline;
          while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              const text = lastAssistantText(parsed);
              if (text) finalText = text;
              const progress = parsePiProgressEvent(parsed);
              if (progress && active && generation === taskGeneration && !runtime.settled) {
                runtime.record = transitionRecord(runtime.record, runtime.record.status, { progress }) as TaskRecord;
                appendTask(runtime.record, { event: "progress", taskId, progress });
              }
            } catch {
              // JSON mode may emit a non-JSON diagnostic line; stderr is retained for failures.
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (code) => {
          runtime.controller.signal.removeEventListener("abort", abort);
          if (timeout) clearTimeout(timeout);
          runtime.child = undefined;
          if (terminateReason === "cancelled") return resolve();
          if (terminateReason === "timeout") return reject(new Error(`Subagent timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`));
          if (code !== 0) return reject(new Error((stderr || `Subagent exited with code ${code}`).trim()));
          if (!finalText) return reject(new Error("Subagent returned no final text"));
          resolve();
        });
      });

      if (!active || generation !== taskGeneration || runtime.settled) return;
      if (terminateReason === "cancelled") return;
      updateTask(taskId, "completed", { result: truncate(finalText), finishedAt: now() }, "completed");
      announce(runtime);
    } catch (error) {
      if (!active || generation !== taskGeneration || runtime.settled) return;
      const message = error instanceof Error ? error.message : String(error);
      updateTask(taskId, terminateReason === "cancelled" ? "cancelled" : "failed", {
        error: message,
        finishedAt: now(),
      }, terminateReason === "cancelled" ? "cancelled" : "failed");
      announce(runtime);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (runtime.tempDir) await rm(runtime.tempDir, { recursive: true, force: true });
      runtime.tempDir = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    active = true;
    generation = randomUUID();
    sessionFile = ctx.sessionManager.getSessionFile();
    tasks.clear();
    const recovered = latestTaskRecords(ctx.sessionManager.getEntries());
    for (const record of recovered.values()) {
      tasks.set(record.taskId, { record: record as TaskRecord, controller: new AbortController(), settled: isTerminalStatus(record.status) });
    }
    for (const runtime of tasks.values()) {
      if (runtime.record.status === "queued" || runtime.record.status === "running") {
        updateTask(runtime.record.taskId, "interrupted", { error: "Task was stale when the session started", finishedAt: now() }, "stale_recovery");
      }
      if (runtime.record.status !== "queued" && runtime.record.status !== "running" && !runtime.record.announced) {
        announce(runtime);
      }
    }
  });

  pi.events.on("jarvis:task-cancel", (event) => {
    const value = event as { taskId?: string; reason?: string } | string;
    const taskId = typeof value === "string" ? value : value?.taskId;
    if (taskId) void cancelTask(taskId, typeof value === "string" ? "Cancelled by event" : value.reason || "Cancelled by event");
  });

  pi.on("session_shutdown", async () => {
    active = false;
    generation = randomUUID();
    const pending = [...tasks.values()].filter(({ record }) => !isTerminalStatus(record.status));
    for (const runtime of pending) {
      runtime.settled = true;
      runtime.controller.abort();
      updateTask(runtime.record.taskId, "interrupted", { error: "Session shut down", finishedAt: now() }, "shutdown");
      if (runtime.child) await stopChildProcessTree(runtime.child);
    }
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description:
      "Queue a trusted project-local Pi subagent for a bounded independent multi-step task. Returns immediately; the result is delivered to this same conversation when the worker finishes.",
    promptSnippet: "Queue only a bounded independent multi-step task; continue the main conversation while it runs.",
    promptGuidelines: [
      "Default to the main agent. Use delegate_task only for a clearly independent, multi-step investigation or computer task.",
      "delegate_task returns immediately. Briefly acknowledge the queued task and continue serving the user; do not wait for the worker.",
      "Do not use delegate_task for ordinary explanations, general knowledge, opinions, recommendations, casual conversation, sleep or wake control, or simple music playback controls.",
      "When the background result arrives, summarize it naturally for the user without exposing raw worker logs.",
    ],
    parameters,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const task = String(input.task || "").trim();
      if (!task) throw new Error("delegate_task requires a task");
      if (task.length > MAX_TASK_CHARS) throw new Error(`delegate_task task exceeds ${MAX_TASK_CHARS} characters`);

      const discovered = discoverAgents(ctx.cwd, "project");
      const agent = discovered.agents.find((candidate) => candidate.name === input.agent);
      if (!agent) {
        const available = discovered.agents.map((candidate) => candidate.name).join(", ") || "none";
        throw new Error(`Unknown project subagent '${input.agent}'. Available: ${available}`);
      }

      const activeCount = [...tasks.values()].filter(({ record }) => !isTerminalStatus(record.status)).length;
      if (activeCount >= MAX_CONCURRENT_TASKS) {
        throw new Error(`Background task limit reached (${MAX_CONCURRENT_TASKS})`);
      }

      const taskId = randomUUID();
      const record: TaskRecord = {
        taskId,
        agent: agent.name,
        task,
        status: "queued",
        attempt: 0,
        createdAt: now(),
        updatedAt: now(),
        sessionFile,
      };
      const runtime: TaskRuntime = { record, controller: new AbortController(), settled: false };
      tasks.set(taskId, runtime);
      appendTask(record, { event: "queued", taskId });
      void runTask(runtime, agent, task, { cwd: ctx.cwd, model: modelFor(agent, ctx) });

      return {
        content: [{ type: "text", text: `后台任务已提交，任务 ID：${taskId}。我会继续和你保持对话，完成后自动把结果带回来。` }],
        details: { taskId, agent: agent.name, status: "queued", asynchronous: true },
      };
    },
  });

  pi.registerTool({
    name: "cancel_task",
    label: "Cancel Task",
    description: "Cancel a queued or running background subagent task by its task ID.",
    parameters: cancelParameters,
    async execute(_toolCallId, input) {
      const cancelled = await cancelTask(String(input.taskId || ""));
      return {
        content: [{ type: "text", text: cancelled ? `已取消后台任务 ${input.taskId}。` : `任务 ${input.taskId} 不存在或已经结束。` }],
        details: { taskId: input.taskId, cancelled },
      };
    },
  });
}
