import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_RETENTION_DAYS,
  compactEvent,
  eventMatches,
  makeEvent,
  normalizeTimestamp,
  pruneEvents,
} from "../memory-contract.mjs";

const MAX_RESULT_CHARS = 18_000;

function numberEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function memoryPath(): string {
  const configured = process.env.JARVIS_ENVIRONMENT_MEMORY_PATH?.trim() || "runtime/environment-memory/events.jsonl";
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function retentionDays(): number {
  return numberEnv("JARVIS_ENVIRONMENT_MEMORY_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 1, 3650);
}

function resultText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n[environment memory result truncated]`;
}

function readRecords(raw: string): Record<string, unknown>[] {
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

class EnvironmentMemoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async load(prune = true): Promise<{ events: Record<string, unknown>[]; pruned: boolean }> {
    const path = memoryPath();
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parsed = readRecords(raw);
    if (!prune) return { events: parsed, pruned: false };
    const events = pruneEvents(parsed, retentionDays());
    const pruned = events.length !== parsed.length;
    if (pruned) await this.replace(events);
    return { events, pruned };
  }

  private async replace(events: Record<string, unknown>[]): Promise<void> {
    const path = memoryPath();
    await mkdir(dirname(path), { recursive: true });
    const body = events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
    await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
  }

  private async append(event: Record<string, unknown>): Promise<void> {
    const path = memoryPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async record(input: Record<string, unknown>) {
    return this.serialized(async () => {
      const loaded = await this.load(true);
      const event = makeEvent(input);
      await this.append(event);
      const events = pruneEvents([event, ...loaded.events], retentionDays());
      if (events.length !== loaded.events.length + 1 || events[0]?.id !== event.id) await this.replace(events);
      return { action: "record", event: compactEvent(event), count: events.length };
    });
  }

  async query(action: string, input: Record<string, unknown>) {
    return this.serialized(async () => {
      const loaded = await this.load(true);
      const limit = Math.min(50, Math.max(1, Number(input.limit || 10)));
      let events = loaded.events;
      if (action === "search") {
        const query = String(input.query || "").trim();
        if (!query) throw new Error("query is required for environment_memory search.");
        events = events.filter((event) => eventMatches(event, query));
      }
      return { action, query: input.query || null, events: events.slice(0, limit).map(compactEvent), count: events.length };
    });
  }

  async forget(input: Record<string, unknown>) {
    return this.serialized(async () => {
      const loaded = await this.load(true);
      const id = String(input.event_id || "").trim();
      const before = input.before === undefined ? undefined : normalizeTimestamp(input.before, "before");
      if (!id && !before) throw new Error("forget requires event_id or before.");
      if (before && input.confirm !== true) throw new Error("forget by before requires confirm=true.");
      const remaining = loaded.events.filter((event) => {
        if (id && event.id === id) return false;
        if (before && Date.parse(String(event.recorded_at)) < Date.parse(before)) return false;
        return true;
      });
      const removed = loaded.events.length - remaining.length;
      if (removed) await this.replace(remaining);
      return { action: "forget", removed, remaining: remaining.length };
    });
  }

  async status() {
    return this.serialized(async () => {
      const loaded = await this.load(false);
      let bytes = 0;
      try { bytes = (await stat(memoryPath())).size; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        action: "status",
        path: memoryPath(),
        retention_days: retentionDays(),
        count: loaded.events.length,
        bytes,
        last_recorded_at: loaded.events[0]?.recorded_at || null,
        source_policy: "explicit_tool_only",
      };
    });
  }
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("record"), Type.Literal("recent"), Type.Literal("search"), Type.Literal("forget"), Type.Literal("status"),
  ]),
  summary: Type.Optional(Type.String({ description: "A concise explicit observation or environment fact to remember." })),
  app: Type.Optional(Type.String()),
  window: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
  screenshot_ref: Type.Optional(Type.String({ description: "Optional local reference; do not embed screenshot bytes." })),
  query: Type.Optional(Type.String()),
  event_id: Type.Optional(Type.String()),
  before: Type.Optional(Type.String({ description: "ISO timestamp for bulk deletion; requires confirm=true." })),
  confirm: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export default function environmentMemory(pi: ExtensionAPI) {
  const store = new EnvironmentMemoryStore();
  pi.registerTool({
    name: "environment_memory",
    label: "Environment Memory",
    description: "Explicit local memory for recent screen/app context. It records only facts supplied in this tool call; it never watches the screen, microphone, or desktop in the background.",
    promptSnippet: "Record, search, list, inspect, or forget an explicitly supplied environment fact.",
    promptGuidelines: [
      "Use this tool only when the user explicitly asks to remember, inspect, search, or forget environment context, or when a screen task explicitly supplies a useful observation.",
      "Do not call it as a background watcher and do not infer facts from an audio fragment, keyword, or hidden screen capture.",
      "Store short factual summaries, not raw transcripts, secrets, or screenshot bytes. Use screenshot_ref only for an explicit reference.",
      "Use forget with event_id for one item. Bulk forget by before requires confirm=true.",
    ],
    parameters,
    async execute(_toolCallId, input) {
      const request = input as Record<string, unknown>;
      const action = String(request.action || "");
      let result;
      if (action === "record") result = await store.record(request);
      else if (action === "recent" || action === "search") result = await store.query(action, request);
      else if (action === "forget") result = await store.forget(request);
      else if (action === "status") result = await store.status();
      else throw new Error(`Unsupported environment_memory action: ${action}`);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
  });
}
