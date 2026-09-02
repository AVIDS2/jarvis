import { randomUUID } from "node:crypto";

export const MAX_TEXT_CHARS = 12_000;
export const MAX_TITLE_CHARS = 300;
export const MAX_NOTES_CHARS = 2_000;
export const MAX_ARGS = 12;
export const MAX_ARG_CHARS = 500;

export function text(value, name, max = MAX_TEXT_CHARS) {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${name} exceeds ${max} characters.`);
  return result;
}

export function validateUrl(value) {
  const raw = text(value, "url", 2_000);
  let url;
  try { url = new URL(raw); } catch { throw new Error("url must be a valid URL."); }
  if (!(["http:", "https:"].includes(url.protocol))) {
    throw new Error("Only http and https URLs may be opened.");
  }
  return url.toString();
}

export function validateTarget(value, name = "target") {
  const target = text(value, name, 500);
  if (!target) throw new Error(`${name} is required.`);
  if (/[\u0000-\u001f\u007f|;&<>]/.test(target)) throw new Error(`${name} contains unsupported control or shell characters.`);
  return target;
}

export function normalizeArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) throw new Error(`args must contain at most ${MAX_ARGS} strings.`);
  return value.map((item) => {
    const value = text(item, "argument", MAX_ARG_CHARS);
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("arguments cannot contain control characters.");
    return value;
  });
}

export function normalizeDueAt(value) {
  const dueAt = text(value, "due_at", 80);
  const timestamp = Date.parse(dueAt);
  if (!Number.isFinite(timestamp)) throw new Error("due_at must be a valid ISO timestamp.");
  return new Date(timestamp).toISOString();
}

export function makeReminder(input, now = new Date()) {
  const title = text(input.title, "title", MAX_TITLE_CHARS);
  if (!title) throw new Error("title is required.");
  const dueAt = normalizeDueAt(input.due_at);
  const notes = input.notes === undefined ? undefined : text(input.notes, "notes", MAX_NOTES_CHARS);
  return {
    id: randomUUID(),
    title,
    due_at: dueAt,
    ...(notes ? { notes } : {}),
    created_at: now.toISOString(),
    completed_at: null,
  };
}

export function compactReminder(reminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    due_at: reminder.due_at,
    ...(reminder.notes ? { notes: reminder.notes } : {}),
    created_at: reminder.created_at,
    completed_at: reminder.completed_at || null,
  };
}
