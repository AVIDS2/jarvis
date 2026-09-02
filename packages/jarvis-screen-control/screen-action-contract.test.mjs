import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyScreenAction,
  evaluateScreenAction,
  resolveVerificationMode,
} from "./screen-action-contract.mjs";

test("observe actions are structurally classified without text matching", () => {
  assert.deepEqual(classifyScreenAction("wait"), { action: "wait", known: true, destructive: false });
  assert.deepEqual(classifyScreenAction("not-a-real-action"), { action: "not-a-real-action", known: false, destructive: false });
});

test("destructive actions are blocked unless explicitly allowed", () => {
  const blocked = evaluateScreenAction({ action: "type", text: "hello" });
  assert.equal(blocked.decision, "blocked");
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.needsConfirmation, true);

  const allowed = evaluateScreenAction({ action: "type", text: "hello", allow_destructive: true });
  assert.equal(allowed.decision, "execute");
  assert.equal(allowed.blocked, false);
});

test("dry run never executes and returns a preview decision", () => {
  const preview = evaluateScreenAction({ action: "app", name: "notepad", dry_run: true });
  assert.equal(preview.decision, "preview");
  assert.equal(preview.blocked, false);
  assert.equal(preview.needsConfirmation, true);
});

test("verification mode is explicit and defaults to a screenshot", () => {
  assert.equal(resolveVerificationMode({}), "screenshot");
  assert.equal(resolveVerificationMode({ verify_after: "state" }), "state");
  assert.equal(resolveVerificationMode({ observe_after: false }), "none");
});
