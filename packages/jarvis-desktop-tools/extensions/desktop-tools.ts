import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MAX_ARGS,
  MAX_TEXT_CHARS,
  compactReminder,
  makeReminder,
  normalizeArgs,
  text,
  validateTarget,
  validateUrl,
} from "../desktop-contract.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 8_000;

function configuredPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function remindersPath(): string {
  return configuredPath("JARVIS_REMINDERS_PATH", "runtime/desktop-tools/reminders.json");
}

function commandTimeoutMs(): number {
  const value = Number(process.env.JARVIS_DESKTOP_COMMAND_TIMEOUT_MS || 10_000);
  return Number.isFinite(value) ? Math.min(30_000, Math.max(1_000, value)) : 10_000;
}

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS ? value : `${value.slice(0, MAX_OUTPUT_CHARS)}\n[desktop output truncated]`;
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function runPowerShell(script: string, signal?: AbortSignal) {
  if (process.platform !== "win32") throw new Error("desktop_tools currently supports Windows only.");
  const shell = process.env.JARVIS_POWERSHELL_PATH?.trim() || "powershell.exe";
  try {
    const result = await execFileAsync(shell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encodedPowerShell(`$ErrorActionPreference = 'Stop'\n${script}`),
    ], {
      windowsHide: true,
      timeout: commandTimeoutMs(),
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      signal,
    });
    return { stdout: truncate(String(result.stdout || "").trim()), stderr: truncate(String(result.stderr || "").trim()) };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
    const detail = [value.stderr, value.stdout, value.message].filter(Boolean).map(String).join(" ").replace(/\s+/g, " ").trim();
    throw new Error(detail || "PowerShell desktop action failed.");
  }
}

async function clipboardRead(signal?: AbortSignal) {
  const result = await runPowerShell("$value = Get-Clipboard -Raw; if ($null -eq $value) { $value = '' }; [Console]::Out.Write($value)", signal);
  return { action: "clipboard_read", text: result.stdout.slice(0, MAX_TEXT_CHARS) };
}

async function clipboardWrite(value: unknown, signal?: AbortSignal) {
  const content = text(value, "text", MAX_TEXT_CHARS);
  await runPowerShell(`Set-Clipboard -Value ${psLiteral(content)}; [Console]::Out.Write('clipboard_updated')`, signal);
  return { action: "clipboard_write", chars: content.length };
}

async function openUrl(value: unknown, signal?: AbortSignal) {
  const url = validateUrl(value);
  await runPowerShell(`Start-Process -FilePath ${psLiteral(url)}; [Console]::Out.Write('url_opened')`, signal);
  return { action: "open_url", url };
}

async function openApp(targetValue: unknown, argsValue: unknown, signal?: AbortSignal) {
  const target = validateTarget(targetValue, "target");
  const args = normalizeArgs(argsValue);
  const argumentList = `@(${args.map(psLiteral).join(",")})`;
  await runPowerShell(`Start-Process -FilePath ${psLiteral(target)} -ArgumentList ${argumentList}; [Console]::Out.Write('app_opened')`, signal);
  return { action: "open_app", target, args };
}

async function revealFile(value: unknown, signal?: AbortSignal) {
  const requested = validateTarget(value, "path");
  const target = isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
  let information;
  try { information = await stat(target); } catch { throw new Error(`Path does not exist: ${target}`); }
  const argument = information.isDirectory() ? target : `/select,${target}`;
  await runPowerShell(`Start-Process -FilePath 'explorer.exe' -ArgumentList ${psLiteral(argument)}; [Console]::Out.Write('file_revealed')`, signal);
  return { action: "file_reveal", path: target, directory: information.isDirectory() };
}

async function readReminders(): Promise<Record<string, unknown>[]> {
  const path = remindersPath();
  try {
    const raw = await readFile(path, "utf8");
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("Reminder store must be a JSON array.");
    return value.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeReminders(reminders: Record<string, unknown>[]): Promise<void> {
  const path = remindersPath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(reminders, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      await writeFile(path, `${JSON.stringify(reminders, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

class ReminderStore {
  private queue: Promise<unknown> = Promise.resolve();

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  add(input: Record<string, unknown>) {
    return this.serialized(async () => {
      const reminder = makeReminder(input);
      const reminders = await readReminders();
      reminders.push(reminder);
      await writeReminders(reminders);
      return { action: "reminder_add", reminder: compactReminder(reminder) };
    });
  }

  list(input: Record<string, unknown>) {
    return this.serialized(async () => {
      const includeCompleted = input.include_completed === true;
      const limit = Math.min(50, Math.max(1, Number(input.limit || 20)));
      const reminders = (await readReminders())
        .filter((reminder) => includeCompleted || !reminder.completed_at)
        .sort((left, right) => Date.parse(String(left.due_at)) - Date.parse(String(right.due_at)));
      return { action: "reminder_list", reminders: reminders.slice(0, limit).map(compactReminder), count: reminders.length };
    });
  }

  complete(input: Record<string, unknown>) {
    return this.serialized(async () => {
      const id = text(input.reminder_id, "reminder_id", 100);
      const reminders = await readReminders();
      const reminder = reminders.find((item) => item.id === id);
      if (!reminder) throw new Error(`Reminder not found: ${id}`);
      reminder.completed_at = new Date().toISOString();
      await writeReminders(reminders);
      return { action: "reminder_complete", reminder: compactReminder(reminder) };
    });
  }
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("clipboard_read"), Type.Literal("clipboard_write"), Type.Literal("open_url"),
    Type.Literal("open_app"), Type.Literal("file_reveal"), Type.Literal("reminder_add"),
    Type.Literal("reminder_list"), Type.Literal("reminder_complete"),
  ]),
  text: Type.Optional(Type.String({ description: "Clipboard text for clipboard_write." })),
  url: Type.Optional(Type.String()),
  target: Type.Optional(Type.String({ description: "Executable name or path for open_app." })),
  args: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_ARGS })),
  path: Type.Optional(Type.String({ description: "Existing file or directory path for file_reveal." })),
  title: Type.Optional(Type.String()),
  due_at: Type.Optional(Type.String({ description: "ISO timestamp for a reminder." })),
  notes: Type.Optional(Type.String()),
  reminder_id: Type.Optional(Type.String()),
  include_completed: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export default function desktopTools(pi: ExtensionAPI) {
  const reminders = new ReminderStore();
  pi.registerTool({
    name: "desktop_tools",
    label: "Desktop Tools",
    description: "Perform bounded Windows desktop actions: clipboard read/write, open a URL or app, reveal a file, and manage local reminders. This tool does not execute arbitrary shell commands.",
    promptSnippet: "Use a structured desktop action for clipboard, app/file opening, or reminders.",
    promptGuidelines: [
      "Use only the action that directly matches the user's explicit request; do not infer a desktop action from a keyword or noisy ASR fragment.",
      "open_app launches only the supplied executable name/path through Start-Process; it is not an arbitrary shell.",
      "file_reveal requires an existing local path and opens Explorer; it does not read or modify file contents.",
      "Reminder data is local JSON and is not a scheduler: list or complete it explicitly; do not claim a notification was delivered.",
      "Report actual PowerShell, path, clipboard, or reminder errors without silently substituting another action.",
    ],
    parameters,
    async execute(_toolCallId, input, signal) {
      const request = input as Record<string, unknown>;
      const action = String(request.action || "");
      let result;
      if (action === "clipboard_read") result = await clipboardRead(signal);
      else if (action === "clipboard_write") result = await clipboardWrite(request.text, signal);
      else if (action === "open_url") result = await openUrl(request.url, signal);
      else if (action === "open_app") result = await openApp(request.target, request.args, signal);
      else if (action === "file_reveal") result = await revealFile(request.path, signal);
      else if (action === "reminder_add") result = await reminders.add(request);
      else if (action === "reminder_list") result = await reminders.list(request);
      else if (action === "reminder_complete") result = await reminders.complete(request);
      else throw new Error(`Unsupported desktop_tools action: ${action}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
