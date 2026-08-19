import { complete } from "@earendil-works/pi-ai/compat";

const STANDBY_AUTH_TIMEOUT_MS = 5_000;

function responseText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("").trim();
}

export async function authorizeStandbyChange(currentModel, userText, mode, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STANDBY_AUTH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await complete(
      currentModel,
      {
        systemPrompt: [
          "You are an authorization gate for a realtime voice assistant standby control.",
          "Return exactly ALLOW or DENY, with no punctuation or explanation.",
          "ALLOW only when the current user utterance explicitly and unambiguously asks the assistant itself to enter the requested standby mode.",
          "For sleep, the user must ask the assistant itself to sleep, rest, wait in standby, or stop listening.",
          "For wake, the user must ask the assistant itself to wake or resume listening.",
          "DENY acknowledgements, filler, silence transcripts, statements about the user's own sleep, computer shutdown requests, quoted text, hypothetical discussion, prior-turn intent, and every ambiguous case.",
        ].join("\n"),
        messages: [{
          role: "user",
          content: [{ type: "text", text: JSON.stringify({ requestedMode: mode, currentUtterance: userText }) }],
          timestamp: Date.now(),
        }],
      },
      { signal: controller.signal, reasoning: "off", maxTokens: 4, temperature: 0 },
    );
    if (response.stopReason === "aborted" || response.stopReason === "error") return false;
    return responseText(response).trim().toUpperCase() === "ALLOW";
  } catch (error) {
    console.warn(`Standby authorization failed closed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
