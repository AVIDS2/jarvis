import { execFile } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntrypoint = resolve(
  packageRoot,
  "node_modules",
  "@music163",
  "ncm-cli",
  "dist",
  "index.js",
);
const DYNAMIC_COMMAND_CACHE_MS = 5 * 60 * 1000;
let dynamicCommandCache: { checkedAt: number; names: Set<string> } | null = null;

function commandEnvironment(): NodeJS.ProcessEnv {
  const playerPath = process.env.JARVIS_MPV_PATH?.trim();
  if (!playerPath) return process.env;
  const currentPath = process.env.PATH || "";
  return {
    ...process.env,
    PATH: `${dirname(playerPath)}${delimiter}${currentPath}`,
  };
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("search_song"),
    Type.Literal("play_request"),
    Type.Literal("play_song"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("next"),
    Type.Literal("previous"),
    Type.Literal("volume"),
    Type.Literal("state"),
    Type.Literal("daily_recommendations")
  ]),
  keyword: Type.Optional(Type.String({ description: "Song, artist, or playlist search text." })),
  title: Type.Optional(Type.String({ description: "Exact song title when resolving a named playback request." })),
  artist: Type.Optional(Type.String({ description: "Exact artist name when the user requested a specific artist." })),
  encryptedId: Type.Optional(Type.String({ description: "Encrypted song or playlist ID returned by search." })),
  originalId: Type.Optional(Type.String({ description: "Original song or playlist ID returned by search." })),
  visible: Type.Optional(Type.Boolean({ description: "The visible field from the current search result. Only true results are playable." })),
  playFlag: Type.Optional(Type.Boolean({ description: "The playFlag field from the current search result. Only true results are playable." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  volume: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 }))
});

function argsFor(input: Record<string, unknown>): string[] {
  const action = String(input.action || "");
  switch (action) {
    case "search_song":
      if (!input.keyword) throw new Error("keyword is required for search_song");
      return ["search", "song", "--keyword", String(input.keyword), "--limit", String(input.limit || 5)];
    case "play_song":
      if (!input.encryptedId || !input.originalId) {
        throw new Error("encryptedId and originalId are required for play_song");
      }
      if (input.visible !== true || input.playFlag !== true) {
        throw new Error("play_song requires visible:true and playFlag:true from a current search result. The requested track may be unavailable for playback.");
      }
      return ["play", "--song", "--encrypted-id", String(input.encryptedId), "--original-id", String(input.originalId)];
    case "pause":
      return ["pause"];
    case "resume":
      return ["resume"];
    case "next":
      return ["next"];
    case "previous":
      return ["prev"];
    case "volume":
      if (input.volume === undefined) throw new Error("volume is required for volume");
      return ["volume", String(input.volume)];
    case "state":
      return ["state"];
    case "daily_recommendations":
      return ["recommend", "daily", "--limit", String(input.limit || 10)];
    default:
      throw new Error(`unsupported NetEase Music action: ${action}`);
  }
}

function requestSummary(input: Record<string, unknown>): string {
  const title = String(input.title || "").trim();
  const artist = String(input.artist || "").trim();
  const keyword = String(input.keyword || "").trim();
  return ["NetEase Music request", title || keyword, artist].filter(Boolean).join(": ");
}

function dynamicArgs(input: Record<string, unknown>, args: string[]): string[] {
  return [...args, "--userInput", requestSummary(input)];
}

type SearchRecord = {
  id?: string;
  originalId?: string | number;
  name?: string;
  visible?: boolean;
  playFlag?: boolean;
  fullArtists?: Array<{ name?: string }>;
};

type ToolUpdate = ((result: {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}) => void) | undefined;

function songLabel(song: SearchRecord): string {
  const artists = song.fullArtists?.map((item) => item.name).filter(Boolean).join("、");
  return [song.name, artists].filter(Boolean).join(" - ");
}

function compactSearchRecord(record: SearchRecord) {
  return {
    encryptedId: record.id,
    originalId: record.originalId,
    title: record.name,
    artists: record.fullArtists?.map((item) => item.name).filter(Boolean) || [],
    visible: record.visible === true,
    playFlag: record.playFlag === true,
  };
}

function searchRecords(stdout: string): { success?: boolean; records: SearchRecord[]; recordCount: number } {
  const payload = parseJsonOutput<{
    success?: boolean;
    data?: { records?: SearchRecord[]; recordCount?: number };
  }>(stdout, "NetEase Music search");
  return {
    success: payload.success,
    records: payload.data?.records || [],
    recordCount: payload.data?.recordCount ?? payload.data?.records?.length ?? 0,
  };
}

function compactSearchOutput(stdout: string, limit: number): string {
  const result = searchRecords(stdout);
  const records = result.records.slice(0, limit).map(compactSearchRecord);
  return JSON.stringify({
    success: result.success !== false,
    data: { recordCount: result.recordCount, returned: records.length, records },
  });
}

function compactRecommendationOutput(stdout: string, limit: number): string {
  const payload = parseJsonOutput<{
    code?: number;
    subCode?: number;
    message?: string;
    data?: SearchRecord[];
  }>(stdout, "NetEase Music recommendations");
  const records = (Array.isArray(payload.data) ? payload.data : []).slice(0, limit).map(compactSearchRecord);
  return JSON.stringify({
    code: payload.code,
    subCode: payload.subCode,
    message: payload.message,
    data: records,
  });
}

function progress(onUpdate: ToolUpdate, action: unknown, stage: string, spokenProgress?: string): void {
  const searchActions = new Set(["search_song", "daily_recommendations", "play_request"]);
  const visualState = stage === "playing"
    ? { state: "celebrate", duration_ms: 1200, priority: 45 }
    : stage === "resolved"
      ? { state: "sending", duration_ms: 900, priority: 60 }
      : { state: searchActions.has(String(action || "")) ? "searching" : "loading", priority: 60 };
  onUpdate?.({
    content: [{ type: "text", text: stage }],
    details: {
      action,
      stage,
      visual_state: { ...visualState, source: "netease_music", phase: stage },
      ...(spokenProgress ? { spoken_progress: spokenProgress } : {}),
    },
  });
}

async function resolvePlayableSong(input: Record<string, unknown>, signal?: AbortSignal) {
  const keyword = String(input.title || input.keyword || "").trim();
  if (!keyword) throw new Error("keyword or title is required for play_request");

  await ensureDynamicCommand("search");
  const result = await runCli(dynamicArgs(input, ["search", "song", "--keyword", keyword, "--limit", "100"]), signal);
  const records = searchRecords(result.stdout).records;

  const title = String(input.title || "").trim();
  const artist = String(input.artist || "").trim();
  const song = records.find((record) => {
    if (record.visible !== true || record.playFlag !== true || !record.id || !record.originalId) return false;
    if (title && record.name !== title) return false;
    if (artist && !record.fullArtists?.some((item) => item.name === artist)) return false;
    return true;
  });
  if (!song) {
    throw new Error("No playable official result matched this request. The requested recording may be unavailable for playback.");
  }

  return {
    args: ["play", "--song", "--encrypted-id", song.id, "--original-id", String(song.originalId)],
    song,
  };
}

async function runCli(args: string[], signal?: AbortSignal) {
  return execFileAsync(process.execPath, [cliEntrypoint, ...args], {
    cwd: packageRoot,
    env: commandEnvironment(),
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    signal,
  });
}

function parseJsonOutput<T>(stdout: string, context: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error(`${context} returned an invalid response.`);
  }
}

function assertCliSucceeded(output: string, context: string): void {
  const normalized = output.trim();
  if (!normalized.startsWith("{")) return;
  let payload: { success?: boolean; message?: string };
  try {
    payload = JSON.parse(normalized) as { success?: boolean; message?: string };
  } catch {
    return;
  }
  if (payload.success === false) {
    throw new Error(payload.message?.trim() || `${context} failed.`);
  }
}

async function ensureLoggedIn() {
  const result = await runCli(["login", "--check", "--output", "json"]);
  const status = parseJsonOutput<{ success?: boolean; message?: string }>(result.stdout, "NetEase Music login check");
  if (status.success) return;

  const login = await runCli(["login", "--background", "--output", "json"]);
  const guidance = [login.stdout, login.stderr].filter(Boolean).join("\n").trim();
  dynamicCommandCache = null;
  throw new Error(
    `NetEase Music login expired. The official CLI started a new login flow. ${guidance || status.message || "Complete the login and retry."}`,
  );
}

async function ensureDynamicCommand(command: string) {
  const now = Date.now();
  if (dynamicCommandCache && now - dynamicCommandCache.checkedAt < DYNAMIC_COMMAND_CACHE_MS) {
    if (dynamicCommandCache.names.has(command)) return;
    throw new Error(`The official NetEase Music command manifest does not include '${command}'.`);
  }

  await ensureLoggedIn();
  const result = await runCli(["commands"]);
  const names = new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => /^([a-z][a-z0-9-]*)\s/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  dynamicCommandCache = { checkedAt: now, names };
  if (!names.has(command)) {
    throw new Error(`The official NetEase Music command manifest does not include '${command}'.`);
  }
}

async function verifyPlayback(signal?: AbortSignal) {
  const delays = [500, 500, 750, 1_000, 1_500];
  let output = "";
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const result = await runCli(["state"], signal);
    output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    try {
      const parsed = JSON.parse(output) as { success?: boolean; state?: { status?: string } };
      if (parsed.success && parsed.state?.status === "playing") return output;
    } catch {
      // A later attempt may still return the official JSON state.
    }
  }
  throw new Error(`NetEase Music did not enter playback. ${output || "No player state returned."}`);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "netease_music",
    label: "NetEase Music",
    description:
      "Control NetEase Cloud Music through the official ncm-cli. Search before playing an unknown song; use the returned encryptedId and originalId for play_song. This tool requires the user's official CLI login and never bypasses membership or copyright restrictions.",
    promptSnippet: "Search and control playback through the official NetEase Cloud Music CLI.",
    promptGuidelines: [
      "Use netease_music for every NetEase Cloud Music search, playback, playback-control, or recommendation request.",
      "For a named song playback request, use netease_music with action play_request. Include keyword, plus exact title and artist when the user supplied them. Never reuse music IDs from prior messages.",
      "play_request resolves a current official search result and rejects unavailable recordings. Only use play_song with IDs and visible:true/playFlag:true from the current turn. If the exact requested record is unavailable, say so without substituting a cover or claiming playback.",
      "Do not claim that NetEase Cloud Music is unavailable, not logged in, or lacks a command without calling netease_music first.",
      "Do not use bash, a browser, or another music service as a substitute when netease_music is available.",
    ],
    parameters,
    async execute(_toolCallId, input, signal, onUpdate) {
      const request = input as Record<string, unknown>;
      try {
        progress(onUpdate, request.action, "started");
        if (request.action === "search_song") await ensureDynamicCommand("search");
        if (request.action === "daily_recommendations") await ensureDynamicCommand("recommend");
        const resolved = request.action === "play_request" ? await resolvePlayableSong(request, signal) : undefined;
        if (resolved?.song) {
          progress(onUpdate, request.action, "resolved", `找到了${songLabel(resolved.song)}，现在开始播放。`);
        }
        const rawArgs = resolved?.args || argsFor(request);
        const args = request.action === "search_song" || request.action === "daily_recommendations"
          ? dynamicArgs(request, rawArgs)
          : rawArgs;
        const result = await runCli(args, signal);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        assertCliSucceeded(output, `NetEase Music ${String(request.action || "command")}`);
        const verifiedState = request.action === "play_song" || request.action === "play_request" ? await verifyPlayback(signal) : "";
        if (resolved?.song) {
          progress(onUpdate, request.action, "playing", `${songLabel(resolved.song)}已经开始播放了。`);
        }
        const text = request.action === "search_song"
          ? compactSearchOutput(result.stdout, Number(request.limit || 5))
          : request.action === "daily_recommendations"
            ? compactRecommendationOutput(result.stdout, Number(request.limit || 10))
            : [output, verifiedState].filter(Boolean).join("\n") || "NetEase Music command completed.";
        return {
          content: [{ type: "text", text }],
          details: { action: request.action, args, song: resolved?.song },
        };
      } catch (error) {
        const detail = error as { message?: string; stdout?: string; stderr?: string };
        const output = [detail.stdout, detail.stderr, detail.message].filter(Boolean).join("\n").trim();
        throw new Error(output || "NetEase Music command failed.");
      }
    }
  });
}
