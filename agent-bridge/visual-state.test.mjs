import assert from "node:assert/strict";
import test from "node:test";

import {
  VISUAL_STATES,
  normalizeVisualState,
  visualStateEvent,
  visualStateFromToolEnd,
  visualStateFromToolStart,
  visualStateFromToolUpdate,
} from "./visual-state.mjs";

test("the character protocol exposes every native state exactly once", () => {
  assert.equal(VISUAL_STATES.length, 39);
  assert.equal(new Set(VISUAL_STATES).size, 39);
  assert.equal(normalizeVisualState("powering-down"), "powering-down");
  assert.equal(normalizeVisualState("unknown"), null);
});

test("tool identities map to deterministic visual states", () => {
  assert.equal(visualStateFromToolStart({ toolName: "delegate_task", args: {} }).state, "orbit");
  assert.equal(visualStateFromToolStart({ toolName: "grep", args: {} }).state, "radar");
  assert.equal(visualStateFromToolStart({ toolName: "edit", args: {} }).state, "writing");
  assert.equal(visualStateFromToolStart({ toolName: "netease_music", args: { action: "play_request" } }).state, "searching");
  assert.equal(visualStateFromToolStart({ toolName: "youtube_media", args: { action: "search" } }).state, "searching");
  assert.equal(visualStateFromToolStart({ toolName: "youtube_media", args: { action: "play" } }).state, "loading");
});

test("structured updates override generic tool states", () => {
  const event = visualStateFromToolUpdate({
    toolName: "netease_music",
    partialResult: { details: { stage: "playing", visual_state: { state: "celebrate", duration_ms: 1200 } } },
  });
  assert.equal(event.state, "celebrate");
  assert.equal(event.duration_ms, 1200);
  assert.equal(visualStateFromToolEnd({ toolName: "bash", isError: true }).state, "alerting");
});

test("expression state and one-shot effect are projected without inference", () => {
  assert.deepEqual(
    visualStateFromToolStart({
      toolName: "show_assistant_expression",
      args: { state: "happy", duration_ms: 2200, effect: "burst" },
    }),
    {
      type: "visual_state",
      state: "happy",
      source: "show_assistant_expression",
      phase: "expression",
      duration_ms: 2200,
      priority: 45,
      effect: "burst",
    },
  );
});

test("unknown effects are dropped without rejecting a valid state", () => {
  assert.deepEqual(visualStateEvent("idle", { effect: "explode" }), {
    type: "visual_state",
    state: "idle",
    source: "agent",
    phase: "active",
    duration_ms: 0,
    priority: 50,
  });
});
