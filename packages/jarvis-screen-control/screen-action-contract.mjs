export const SCREEN_ACTION_TYPES = Object.freeze([
  "click",
  "type",
  "scroll",
  "move",
  "shortcut",
  "wait",
  "wait_for",
  "app",
]);

// These actions can launch applications, alter data, send input, or trigger a
// shortcut. They require an explicit structured allow_destructive=true value.
export const DESTRUCTIVE_SCREEN_ACTIONS = new Set(["click", "type", "shortcut", "app"]);

export function classifyScreenAction(action) {
  const normalized = String(action || "");
  if (!SCREEN_ACTION_TYPES.includes(normalized)) return { action: normalized, known: false, destructive: false };
  return {
    action: normalized,
    known: true,
    destructive: DESTRUCTIVE_SCREEN_ACTIONS.has(normalized),
  };
}

export function evaluateScreenAction(input = {}) {
  const classification = classifyScreenAction(input.action);
  const dryRun = input.dry_run === true;
  const allowDestructive = input.allow_destructive === true;

  if (!classification.known) {
    return {
      ...classification,
      dryRun,
      allowDestructive,
      decision: "blocked",
      blocked: true,
      needsConfirmation: false,
      reason: "unsupported_action",
    };
  }
  if (dryRun) {
    return {
      ...classification,
      dryRun: true,
      allowDestructive,
      decision: "preview",
      blocked: false,
      needsConfirmation: classification.destructive && !allowDestructive,
      reason: "dry_run",
    };
  }
  if (classification.destructive && !allowDestructive) {
    return {
      ...classification,
      dryRun: false,
      allowDestructive: false,
      decision: "blocked",
      blocked: true,
      needsConfirmation: true,
      reason: "explicit_allow_destructive_required",
    };
  }
  return {
    ...classification,
    dryRun: false,
    allowDestructive,
    decision: "execute",
    blocked: false,
    needsConfirmation: false,
    reason: "structured_action_allowed",
  };
}

export function resolveVerificationMode(input = {}) {
  if (input.verify_after === "none" || input.observe_after === false) return "none";
  if (input.verify_after === "state") return "state";
  return "screenshot";
}
