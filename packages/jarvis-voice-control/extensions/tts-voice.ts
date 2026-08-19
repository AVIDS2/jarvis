import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VOICES = ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"] as const;

const parameters = Type.Object({
  voice: Type.Union(VOICES.map((voice) => Type.Literal(voice))),
});

const standbyParameters = Type.Object({
  mode: Type.Union([Type.Literal("sleep"), Type.Literal("wake")]),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "set_tts_voice",
    label: "Set TTS Voice",
    description: "Change the configured assistant's cloud TTS voice for subsequent spoken replies.",
    promptSnippet: "Switch the assistant voice using the local TTS control service.",
    promptGuidelines: [
      "Use set_tts_voice only when the user explicitly asks to change the assistant's voice, voice style, or named TTS voice.",
      "Choose one of the listed voices. Do not claim a voice changed unless set_tts_voice succeeds.",
      "After success, acknowledge the selected voice briefly and continue the conversation naturally.",
    ],
    parameters,
    async execute(_toolCallId, input) {
      const voice = String((input as { voice?: string }).voice || "").trim();
      const response = await fetch("http://127.0.0.1:8111/control/tts/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice }),
        signal: AbortSignal.timeout(5_000),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        voice?: string;
        label?: string;
        detail?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.detail || `TTS voice service returned HTTP ${response.status}.`);
      }
      return {
        content: [{ type: "text", text: `TTS voice changed to ${payload.label || payload.voice || voice}.` }],
        details: { voice: payload.voice || voice, label: payload.label || null },
      };
    },
  });

  pi.registerTool({
    name: "set_assistant_standby",
    label: "Set Assistant Standby",
    description: "Put the configured assistant into standby or wake it through the local realtime voice runtime.",
    promptSnippet: "Control the assistant's standby state using the native realtime voice service.",
    promptGuidelines: [
      "Use set_assistant_standby only when the user explicitly asks the assistant itself to sleep, enter standby, wake up, or resume listening.",
      "Sleep affects only the assistant's voice runtime. It never shuts down Windows, the tray application, or any other process.",
      "Do not claim the state changed unless set_assistant_standby succeeds. After success, respond briefly and naturally.",
    ],
    parameters: standbyParameters,
    async execute(_toolCallId, input) {
      const mode = (input as { mode?: "sleep" | "wake" }).mode;
      if (mode !== "sleep" && mode !== "wake") throw new Error("standby mode must be sleep or wake");
      const response = await fetch(`http://127.0.0.1:8111/control/${mode}`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        sleeping?: boolean;
        wake_word_phrase?: string | null;
        detail?: string;
      };
      if (!response.ok || !payload.ok || typeof payload.sleeping !== "boolean") {
        throw new Error(payload.detail || `Voice standby service returned HTTP ${response.status}.`);
      }
      return {
        content: [{ type: "text", text: payload.sleeping ? "Assistant standby is enabled." : "Assistant standby is disabled." }],
        details: { sleeping: payload.sleeping, wakeWordPhrase: payload.wake_word_phrase || null },
      };
    },
  });
}
