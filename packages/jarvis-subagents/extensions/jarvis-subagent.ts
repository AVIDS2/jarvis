import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";

const MAX_TASK_CHARS = 8_000;
const MAX_RESULT_CHARS = 12_000;
const SUBAGENT_TIMEOUT_MS = 30_000;

const parameters = Type.Object({
  agent: Type.String({ description: "Name of a project-local subagent from .pi/agents." }),
  task: Type.String({ description: "Self-contained delegated task with the necessary context and expected result." }),
});

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

function stopChildProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    const terminator = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    terminator.unref();
    return;
  }
  child.kill();
}

export default function jarvisSubagents(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description:
      "Run a trusted project-local Pi subagent only for a bounded, independent multi-step task. The subagent receives the delegated task and returns a concise result to the main conversation.",
    promptSnippet: "Use only for a bounded independent task that cannot be answered directly in the main conversation.",
    promptGuidelines: [
      "Default to the main agent. Use delegate_task only for a clearly independent, multi-step investigation or computer task that would otherwise occupy the main conversation for substantial time.",
      "Do not use delegate_task for ordinary explanations, general knowledge, opinions, recommendations, casual conversation, sleep or wake control, or simple music playback controls.",
      "Do not delegate merely to make an answer more comprehensive. If a direct answer is useful, answer directly.",
      "Once a task is delegated, keep its scope bounded and avoid adding unrelated tool work to the main session.",
      "After delegate_task returns, give the user a concise spoken conclusion instead of exposing the subagent's raw work log.",
    ],
    parameters,
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const task = String(input.task || "").trim();
      if (!task) throw new Error("delegate_task requires a task");
      if (task.length > MAX_TASK_CHARS) throw new Error(`delegate_task task exceeds ${MAX_TASK_CHARS} characters`);

      const discovered = discoverAgents(ctx.cwd, "project");
      const agent = discovered.agents.find((candidate) => candidate.name === input.agent);
      if (!agent) {
        const available = discovered.agents.map((candidate) => candidate.name).join(", ") || "none";
        throw new Error(`Unknown project subagent '${input.agent}'. Available: ${available}`);
      }

      const piCliPath = process.env.JARVIS_PI_CLI_PATH;
      if (!piCliPath) throw new Error("JARVIS_PI_CLI_PATH is not configured");

      const tempDir = await mkdtemp(join(tmpdir(), "jarvis-subagent-"));
      const promptPath = join(tempDir, "system-prompt.md");
      const systemPrompt = `${agent.systemPrompt.trim()}\n\nYou are an isolated Jarvis subagent. Complete only the delegated task. Do not converse with the user and do not expose chain-of-thought. Return a concise factual report for the main assistant.`;
      await writeFile(promptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "xiaomi/mimo-v2.5";
      const args = ["--mode", "json", "-p", "--no-session", "--model", model, "--thinking", "off"];
      if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
      args.push("--append-system-prompt", promptPath, `Task: ${task}`);

      try {
        const result = await new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [piCliPath, ...args], {
            cwd: ctx.cwd,
            env: process.env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          let stdoutBuffer = "";
          let stderr = "";
          let finalText = "";
          let aborted = false;
          let timedOut = false;

          const abort = () => {
            aborted = true;
            stopChildProcessTree(child);
          };
          signal.addEventListener("abort", abort, { once: true });
          const timeout = setTimeout(() => {
            timedOut = true;
            stopChildProcessTree(child);
          }, SUBAGENT_TIMEOUT_MS);

          child.stdout.on("data", (chunk) => {
            stdoutBuffer += String(chunk);
            let newline;
            while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
              const line = stdoutBuffer.slice(0, newline).trim();
              stdoutBuffer = stdoutBuffer.slice(newline + 1);
              if (!line) continue;
              try {
                const text = lastAssistantText(JSON.parse(line));
                if (text) finalText = text;
              } catch {
                // Pi JSON mode may emit non-JSON diagnostics; final stderr handles failures.
              }
            }
          });
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.once("error", reject);
          child.once("close", (code) => {
            signal.removeEventListener("abort", abort);
            clearTimeout(timeout);
            if (aborted) return reject(new Error("Subagent was aborted"));
            if (timedOut) return reject(new Error(`Subagent timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`));
            if (code !== 0) return reject(new Error((stderr || `Subagent exited with code ${code}`).trim()));
            if (!finalText) return reject(new Error("Subagent returned no final text"));
            resolve(truncate(finalText));
          });
        });
        return {
          content: [{ type: "text", text: result }],
          details: { agent: agent.name, source: agent.source, isolated: true },
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  });
}
