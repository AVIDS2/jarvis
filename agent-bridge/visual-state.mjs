export const VISUAL_STATES = Object.freeze([
  "sleeping", "waking", "idle", "listening", "thinking", "searching", "working",
  "excited", "surprised", "suspicious", "angry", "drowsy", "happy", "curious",
  "confused", "bored", "proud", "shy", "sad", "laughing", "scared", "playful",
  "celebrate", "orbit", "radar", "progress", "spawning", "humming", "loading",
  "dictating", "writing", "sending", "receiving", "uploading", "notifying",
  "alerting", "dragging", "bouncing", "powering-down",
]);

const VISUAL_STATE_SET = new Set(VISUAL_STATES);
const SEARCH_ACTIONS = new Set(["search_song", "daily_recommendations", "play_request"]);

export function normalizeVisualState(value) {
  const state = String(value || "").trim().toLowerCase();
  return VISUAL_STATE_SET.has(state) ? state : null;
}

export function visualStateEvent(state, options = {}) {
  const normalized = normalizeVisualState(state);
  if (!normalized) return null;
  const durationMs = Number(options.durationMs ?? options.duration_ms);
  const priority = Number(options.priority);
  const effect = ["spin", "bounce", "burst"].includes(String(options.effect || ""))
    ? String(options.effect)
    : null;
  return {
    type: "visual_state",
    state: normalized,
    source: String(options.source || "agent").slice(0, 64),
    phase: String(options.phase || "active").slice(0, 32),
    duration_ms: Number.isFinite(durationMs) ? Math.max(0, Math.min(10_000, Math.round(durationMs))) : 0,
    priority: Number.isFinite(priority) ? Math.max(0, Math.min(100, Math.round(priority))) : 50,
    ...(effect ? { effect } : {}),
  };
}

export function visualStateFromToolStart(event) {
  const toolName = String(event?.toolName || "");
  const input = event?.args && typeof event.args === "object" ? event.args : {};

  if (toolName === "show_assistant_expression") {
    return visualStateEvent(input.state, {
      source: toolName,
      phase: "expression",
      durationMs: input.duration_ms ?? 1800,
      priority: 45,
      effect: input.effect,
    });
  }
  if (toolName === "delegate_task") return visualStateEvent("orbit", { source: toolName, priority: 65 });
  if (toolName === "grep" || toolName === "find") return visualStateEvent("radar", { source: toolName, priority: 60 });
  if (toolName === "read" || toolName === "ls") return visualStateEvent("searching", { source: toolName, priority: 55 });
  if (toolName === "write" || toolName === "edit") return visualStateEvent("writing", { source: toolName, priority: 60 });
  if (toolName === "bash") return visualStateEvent("progress", { source: toolName, priority: 55 });
  if (toolName === "set_tts_voice") return visualStateEvent("progress", { source: toolName, priority: 55 });
  if (toolName === "set_assistant_standby") {
    return visualStateEvent(input.mode === "sleep" ? "powering-down" : "waking", {
      source: toolName,
      priority: 90,
    });
  }
  if (toolName === "netease_music") {
    const action = String(input.action || "");
    return visualStateEvent(SEARCH_ACTIONS.has(action) ? "searching" : "loading", {
      source: toolName,
      priority: 60,
    });
  }
  return visualStateEvent("progress", { source: toolName || "tool", priority: 50 });
}

export function visualStateFromToolUpdate(event) {
  const details = event?.partialResult?.details;
  const declared = details?.visual_state ?? details?.visualState;
  if (declared && typeof declared === "object") {
    return visualStateEvent(declared.state, {
      ...declared,
      source: declared.source || event.toolName,
      phase: declared.phase || details?.stage || "update",
    });
  }
  return null;
}

export function visualStateFromToolEnd(event) {
  if (event?.isError) {
    return visualStateEvent("alerting", {
      source: event.toolName || "tool",
      phase: "error",
      durationMs: 1800,
      priority: 85,
    });
  }
  if (event?.toolName === "show_assistant_expression") return null;
  const details = event?.result?.details;
  const declared = details?.visual_state ?? details?.visualState;
  if (declared && typeof declared === "object") {
    return visualStateEvent(declared.state, {
      ...declared,
      source: declared.source || event.toolName,
      phase: declared.phase || "completed",
    });
  }
  if (event?.toolName === "delegate_task") {
    return visualStateEvent("receiving", {
      source: event.toolName,
      phase: "completed",
      durationMs: 900,
      priority: 60,
    });
  }
  return visualStateEvent("bouncing", {
    source: event?.toolName || "tool",
    phase: "completed",
    durationMs: 650,
    priority: 40,
  });
}
