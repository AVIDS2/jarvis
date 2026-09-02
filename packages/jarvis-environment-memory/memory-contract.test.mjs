import assert from "node:assert/strict";
import test from "node:test";
import {
  compactEvent,
  eventMatches,
  isExpired,
  makeEvent,
  normalizeTags,
  pruneEvents,
} from "./memory-contract.mjs";

test("memory records are explicitly sourced and normalized", () => {
  const event = makeEvent({
    summary: "Browser is on the Pi project page",
    app: "Edge",
    window: "Pi project",
    tags: ["browser", "browser"],
  }, new Date("2026-08-25T00:00:00.000Z"));
  assert.equal(event.source, "explicit_tool");
  assert.deepEqual(event.tags, ["browser"]);
  assert.equal(compactEvent(event).summary, "Browser is on the Pi project page");
});

test("memory search is structured field matching, not keyword-triggered execution", () => {
  const event = { app: "Edge", window: "Docs", summary: "Pi extensions", tags: ["research"] };
  assert.equal(eventMatches(event, "extensions"), true);
  assert.equal(eventMatches(event, "audio"), false);
});

test("retention removes stale and malformed timestamps", () => {
  const now = Date.parse("2026-08-25T00:00:00.000Z");
  const events = [
    { id: "fresh", recorded_at: "2026-08-24T00:00:00.000Z" },
    { id: "old", recorded_at: "2026-07-01T00:00:00.000Z" },
    { id: "bad", recorded_at: "not-a-date" },
  ];
  assert.equal(isExpired(events[0], 30, now), false);
  assert.deepEqual(pruneEvents(events, 30, now).map((event) => event.id), ["fresh"]);
});

test("tag limits are enforced", () => {
  assert.deepEqual(normalizeTags(["a", "a", " b "]), ["a", "b"]);
  assert.throws(() => normalizeTags(Array.from({ length: 13 }, (_, index) => String(index))), /at most 12/);
});
