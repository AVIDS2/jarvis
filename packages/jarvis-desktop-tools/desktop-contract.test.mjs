import assert from "node:assert/strict";
import test from "node:test";
import {
  compactReminder,
  makeReminder,
  normalizeArgs,
  validateTarget,
  validateUrl,
} from "./desktop-contract.mjs";

test("URLs are limited to browser-safe HTTP schemes", () => {
  assert.equal(validateUrl("https://example.com").startsWith("https://"), true);
  assert.throws(() => validateUrl("file:///Windows/system.ini"), /Only http and https/);
  assert.throws(() => validateUrl("javascript:alert(1)"), /Only http and https/);
});

test("desktop targets reject shell/control characters", () => {
  assert.equal(validateTarget("notepad.exe"), "notepad.exe");
  assert.throws(() => validateTarget("notepad.exe; whoami"), /unsupported/);
  assert.deepEqual(normalizeArgs(["--new-window", "https://example.com"]), ["--new-window", "https://example.com"]);
});

test("reminders have stable local fields and completion state", () => {
  const reminder = makeReminder({ title: "Check the build", due_at: "2026-08-25T09:00:00+08:00", notes: "local" }, new Date("2026-08-25T00:00:00.000Z"));
  assert.equal(reminder.completed_at, null);
  assert.equal(compactReminder(reminder).title, "Check the build");
  assert.throws(() => makeReminder({ title: "missing due" }), /due_at/);
});
