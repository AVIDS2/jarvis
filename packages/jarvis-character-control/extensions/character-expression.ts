import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXPRESSIONS = [
  "excited", "surprised", "suspicious", "angry", "drowsy", "happy", "curious",
  "confused", "bored", "proud", "shy", "sad", "laughing", "scared", "playful", "celebrate",
] as const;

const parameters = Type.Object({
  state: Type.Union(EXPRESSIONS.map((state) => Type.Literal(state))),
  duration_ms: Type.Optional(Type.Integer({ minimum: 600, maximum: 6000 })),
  effect: Type.Optional(Type.Union([Type.Literal("spin"), Type.Literal("bounce"), Type.Literal("burst")])),
});

export default function characterControl(pi: ExtensionAPI) {
  pi.registerTool({
    name: "show_assistant_expression",
    label: "Show Assistant Expression",
    description: "Show one native character reaction when it materially improves the current interaction.",
    promptSnippet: "Optionally show a brief native character expression without changing the spoken response.",
    promptGuidelines: [
      "Use show_assistant_expression sparingly and only when a clear conversational emotion makes the reaction useful.",
      "Never call it on every turn, never use it as a substitute for a spoken response, and never delay necessary work for it.",
      "Choose the expression semantically from the current interaction. Do not claim an emotion or reaction in text merely because the visual tool was used.",
      "The tool is immediate and visual-only. Continue the normal spoken response after calling it.",
    ],
    parameters,
    async execute(_toolCallId, input) {
      const state = String((input as { state?: string }).state || "");
      const durationMs = Number((input as { duration_ms?: number }).duration_ms || 1800);
      const effect = (input as { effect?: "spin" | "bounce" | "burst" }).effect;
      return {
        content: [{ type: "text", text: `Character expression shown: ${state}.` }],
        details: {
          visual_state: {
            state,
            source: "show_assistant_expression",
            phase: "expression",
            duration_ms: durationMs,
            priority: 45,
            ...(effect ? { effect } : {}),
          },
        },
      };
    },
  });
}
