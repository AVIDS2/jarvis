import { randomUUID } from "node:crypto";

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_SUMMARY_CHARS = 4_000;
export const MAX_FIELD_CHARS = 300;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 64;
export const MAX_EVENTS = 2_000;

export function trimText(value, name, max = MAX_FIELD_CHARS) {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${name} exceeds ${max} characters.`);
  return result;
}

export function normalizeTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS || value.some((item) => typeof item !== "string")) {
    throw new Error(`tags must be an array of at most ${MAX_TAGS} strings.`);
  }
  const tags = value.map((item) => trimText(item, "tag", MAX_TAG_CHARS)).filter(Boolean);
  return [...new Set(tags)];
}

export function normalizeTimestamp(value, name = "timestamp") {
  const timestamp = value === undefined ? new Date().toISOString() : String(value).trim();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO timestamp.`);
  return new Date(parsed).toISOString();
}

export function makeEvent(input, now = new Date()) {
  const summary = trimText(input.summary, "summary", MAX_SUMMARY_CHARS);
  if (!summary) throw new Error("summary is required.");
  const app = input.app === undefined ? undefined : trimText(input.app, "app");
  const window = input.window === undefined ? undefined : trimText(input.window, "window");
  const screenshotRef = input.screenshot_ref === undefined
    ? undefined
    : trimText(input.screenshot_ref, "screenshot_ref", 1_000);
  return {
    id: randomUUID(),
    recorded_at: now.toISOString(),
    source: "explicit_tool",
    ...(app ? { app } : {}),
    ...(window ? { window } : {}),
    summary,
    tags: normalizeTags(input.tags),
    ...(screenshotRef ? { screenshot_ref: screenshotRef } : {}),
  };
}

export function isExpired(event, retentionDays, now = Date.now()) {
  const timestamp = Date.parse(event?.recorded_at || "");
  if (!Number.isFinite(timestamp)) return true;
  return now - timestamp > retentionDays * 24 * 60 * 60 * 1_000;
}

export function pruneEvents(events, retentionDays, now = Date.now()) {
  const valid = events.filter((event) => event && typeof event === "object" && !isExpired(event, retentionDays, now));
  return valid
    .sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))
    .slice(0, MAX_EVENTS);
}

export function eventMatches(event, query) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [event.app, event.window, event.summary, ...(event.tags || []), event.screenshot_ref]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(needle);
}

export function compactEvent(event) {
  return {
    id: event.id,
    recorded_at: event.recorded_at,
    ...(event.app ? { app: event.app } : {}),
    ...(event.window ? { window: event.window } : {}),
    summary: event.summary,
    tags: event.tags || [],
    ...(event.screenshot_ref ? { screenshot_ref: event.screenshot_ref } : {}),
  };
}
