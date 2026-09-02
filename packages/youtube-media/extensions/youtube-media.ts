import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ytdlp = process.env.JARVIS_YTDLP_PATH?.trim() || (process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const mpv = process.env.JARVIS_MPV_PATH?.trim() || (process.platform === "win32" ? "mpv.exe" : "mpv");
const mpvPipe = process.platform === "win32"
  ? "\\\\.\\pipe\\jarvis-youtube-mpv"
  : join(tmpdir(), "jarvis-youtube-mpv.sock");
const maxHeight = Number(process.env.JARVIS_YOUTUBE_MAX_HEIGHT || 720);
const cookiesBrowser = process.env.JARVIS_YOUTUBE_COOKIES_FROM_BROWSER?.trim() || "";

type VideoRecord = {
  videoId: string;
  url: string;
  title: string;
  channel?: string;
  duration?: number;
  viewCount?: number;
  thumbnail?: string;
};

type Player = {
  process: ChildProcessWithoutNullStreams;
  current: VideoRecord | null;
  stderr: string;
};

let player: Player | null = null;
let requestId = 0;

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("metadata"),
    Type.Literal("transcript"),
    Type.Literal("play"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("stop"),
    Type.Literal("seek"),
    Type.Literal("volume"),
    Type.Literal("state"),
  ]),
  query: Type.Optional(Type.String({ description: "YouTube search text, such as a video title, creator, or topic." })),
  url: Type.Optional(Type.String({ description: "A YouTube video URL." })),
  videoId: Type.Optional(Type.String({ description: "A YouTube video ID returned by a current search." })),
  language: Type.Optional(Type.String({ description: "Subtitle languages, for example zh.*,en.*,ja.*." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  seconds: Type.Optional(Type.Number({ minimum: -86400, maximum: 86400 })),
  volume: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});

function commandEnvironment(): NodeJS.ProcessEnv {
  const directories = [ytdlp, mpv]
    .filter((value) => value.includes("\\") || value.includes("/"))
    .map((value) => dirname(value));
  const currentPath = process.env.PATH || "";
  return { ...process.env, PATH: [...new Set([...directories, currentPath])].filter(Boolean).join(delimiter) };
}

async function runYtDlp(args: string[], signal?: AbortSignal) {
  const authArgs = cookiesBrowser ? ["--cookies-from-browser", cookiesBrowser] : [];
  return execFileAsync(ytdlp, ["--ignore-config", "--no-warnings", ...authArgs, ...args], {
    cwd: packageRoot,
    env: commandEnvironment(),
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    signal,
  });
}

async function resolvePlaybackUrl(url: string, signal?: AbortSignal): Promise<string> {
  const output = await runYtDlp([
    "--get-url",
    "--format", `best[height<=${maxHeight}]/best`,
    "--no-playlist",
    url,
  ], signal);
  const streamUrl = output.stdout.trim().split(/\r?\n/).find((line) => /^https?:\/\//.test(line));
  if (!streamUrl) {
    const detail = [output.stderr, output.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    throw new Error(detail || "YouTube did not return a playable stream. Public playback may require an explicit browser-cookie configuration.");
  }
  return streamUrl;
}

function parseJson(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error("YouTube returned an invalid metadata response.");
  }
}

function videoRecord(value: Record<string, unknown>): VideoRecord | null {
  const videoId = String(value.id || "").trim();
  const url = String(value.webpage_url || value.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ""));
  const title = String(value.title || "").trim();
  if (!videoId || !url || !title) return null;
  const thumbnails = Array.isArray(value.thumbnails) ? value.thumbnails : [];
  const lastThumbnail = thumbnails.at(-1) as Record<string, unknown> | undefined;
  return {
    videoId,
    url,
    title,
    channel: String(value.channel || value.uploader || "").trim() || undefined,
    duration: typeof value.duration === "number" ? value.duration : undefined,
    viewCount: typeof value.view_count === "number" ? value.view_count : undefined,
    thumbnail: typeof lastThumbnail?.url === "string" ? lastThumbnail.url : undefined,
  };
}

function compactVideo(video: VideoRecord) {
  return {
    videoId: video.videoId,
    url: video.url,
    title: video.title,
    channel: video.channel || null,
    durationSeconds: video.duration ?? null,
    viewCount: video.viewCount ?? null,
    thumbnail: video.thumbnail || null,
  };
}

async function searchVideos(query: string, limit: number, signal?: AbortSignal): Promise<VideoRecord[]> {
  const output = await runYtDlp([
    "--flat-playlist",
    "--dump-single-json",
    "--skip-download",
    "--ignore-errors",
    `ytsearch${limit}:${query}`,
  ], signal);
  const payload = parseJson(output.stdout);
  const entries = Array.isArray(payload.entries) ? payload.entries : [payload];
  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map(videoRecord)
    .filter((entry): entry is VideoRecord => Boolean(entry));
}

function videoUrl(input: Record<string, unknown>): string {
  const url = String(input.url || "").trim();
  if (url) return url;
  const id = String(input.videoId || "").trim();
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  throw new Error("url or videoId is required for this YouTube action.");
}

function stripVtt(raw: string): string {
  const seen = new Set<string>();
  const lines = raw
    .replace(/^WEBVTT[^\n]*\n?/i, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim())
    .filter((line) => line && !line.startsWith("NOTE") && !line.includes(" --> ") && !/^\d+$/.test(line));
  return lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  }).join(" ").slice(0, 12_000);
}

async function transcript(url: string, language: string, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-youtube-"));
  try {
    await runYtDlp([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-format", "vtt",
      "--sub-langs", language,
      "--no-playlist",
      "--paths", directory,
      "--output", "%(id)s.%(ext)s",
      url,
    ], signal).catch(() => undefined);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".vtt"));
    if (!files.length) throw new Error("This video does not expose a usable subtitle or transcript.");
    const parts = await Promise.all(files.slice(0, 3).map(async (file) => stripVtt(await readFile(join(directory, file), "utf8"))));
    const text = parts.find(Boolean) || "";
    if (!text) throw new Error("The YouTube transcript was empty.");
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pipeRequest(command: unknown[], timeoutMs = 5000): Promise<Record<string, unknown>> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const socket = createConnection(mpvPipe);
    let buffer = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      reject(new Error("mpv IPC timed out."));
    }, timeoutMs);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value || {});
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ command, request_id: id })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split(/\r?\n/).slice(0, -1)) {
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          if (payload.request_id === id) finish(undefined, payload);
        } catch {
          // Ignore partial or event lines until the matching response arrives.
        }
      }
      buffer = buffer.split(/\r?\n/).at(-1) || "";
    });
    socket.on("error", (error) => finish(error));
  });
}

async function ensurePlayer(): Promise<Player> {
  if (player && player.process.exitCode === null) return player;
  const child = spawn(mpv, [
    "--idle=yes",
    "--force-window=no",
    "--terminal=no",
    "--input-ipc-server=" + mpvPipe,
  ], {
    cwd: packageRoot,
    env: commandEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  player = { process: child, current: null, stderr: "" };
  child.stderr.on("data", (chunk) => {
    if (!player || player.process !== child) return;
    player.stderr = `${player.stderr}${String(chunk)}`.slice(-4000);
  });
  child.once("exit", () => {
    if (player?.process === child) player = null;
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return player;
}

async function waitForPlayback(timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (!player || player.process.exitCode !== null) {
      throw new Error(player?.stderr.trim() || "mpv exited before loading the YouTube stream.");
    }
    try {
      const response = await pipeRequest(["get_property", "path"], 1200);
      if (typeof response.data === "string" && response.data) return;
      lastError = String(response.error || "mpv has not loaded the stream yet.");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  const detail = player?.stderr.trim();
  throw new Error(detail || lastError || "mpv did not confirm that the YouTube stream loaded.");
}

async function mpvCommand(command: unknown[]): Promise<Record<string, unknown>> {
  await ensurePlayer();
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await pipeRequest(command);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("mpv IPC is unavailable.");
}

function stateLabel(value: unknown): string {
  if (!player || player.process.exitCode !== null) return "stopped";
  return value ? "playing" : "stopped";
}

export default function youtubeMedia(pi: ExtensionAPI) {
  pi.registerTool({
    name: "youtube_media",
    label: "YouTube Media",
    description: "Search public YouTube videos, inspect metadata or subtitles, and play/control a selected video in the local mpv player. This is separate from NetEase Music. Playback alone does not mean the agent has visually understood the video.",
    promptSnippet: "Search, play, control, or read the transcript of a YouTube video through an external local media extension.",
    promptGuidelines: [
      "Use youtube_media for YouTube video requests, not netease_music.",
      "For an unknown video, search first and use a current result's videoId or URL for playback.",
      "Use transcript when the user asks what a video says or wants a summary. Do not claim visual understanding from playback alone.",
      "This tool streams a selected URL in mpv and does not download media by default.",
      "Report actual yt-dlp/mpv errors. Do not substitute an unrelated result when the requested video cannot be resolved.",
    ],
    parameters,
    async execute(_toolCallId, input, signal, onUpdate) {
      const request = input as Record<string, unknown>;
      const action = String(request.action || "");
      const limit = Number(request.limit || 5);
      const update = (stage: string, spokenProgress?: string) => onUpdate?.({
        content: [{ type: "text", text: stage }],
        details: {
          action,
          stage,
          visual_state: { state: stage === "searching" ? "searching" : stage === "playing" ? "celebrate" : "loading", source: "youtube_media", phase: stage },
          ...(spokenProgress ? { spoken_progress: spokenProgress } : {}),
        },
      });
      update(action === "search" || action === "metadata" || action === "transcript" ? "searching" : "started");

      if (action === "search") {
        const query = String(request.query || "").trim();
        if (!query) throw new Error("query is required for YouTube search.");
        const results = await searchVideos(query, limit, signal);
        return { content: [{ type: "text", text: JSON.stringify({ query, results: results.map(compactVideo) }) }], details: { action, count: results.length } };
      }

      if (action === "metadata") {
        const url = videoUrl(request);
        const payload = parseJson((await runYtDlp(["--dump-single-json", "--skip-download", "--no-playlist", url], signal)).stdout);
        const video = videoRecord(payload);
        if (!video) throw new Error("YouTube did not return usable video metadata.");
        return { content: [{ type: "text", text: JSON.stringify(compactVideo(video)) }], details: { action, video: compactVideo(video) } };
      }

      if (action === "transcript") {
        const text = await transcript(videoUrl(request), String(request.language || "zh.*,en.*,ja.*"), signal);
        return { content: [{ type: "text", text }], details: { action, transcript_chars: text.length } };
      }

      if (action === "play") {
        let video: VideoRecord | null = null;
        if (request.query) video = (await searchVideos(String(request.query), 1, signal))[0] || null;
        const url = video?.url || videoUrl(request);
        const streamUrl = await resolvePlaybackUrl(url, signal);
        await mpvCommand(["loadfile", streamUrl, "replace"]);
        await waitForPlayback();
        if (player) player.current = video || { videoId: String(request.videoId || ""), url, title: url };
        update("playing", video ? `${video.title}，已经在 mpv 里打开了。` : "视频已经在 mpv 里打开了。");
        return { content: [{ type: "text", text: video ? `已播放：${video.title}` : `已播放：${url}` }], details: { action, video: video ? compactVideo(video) : { url } } };
      }

      if (action === "pause") await mpvCommand(["set_property", "pause", true]);
      else if (action === "resume") await mpvCommand(["set_property", "pause", false]);
      else if (action === "stop") {
        await mpvCommand(["stop"]);
        if (player) player.current = null;
      } else if (action === "seek") {
        if (request.seconds === undefined) throw new Error("seconds is required for seek.");
        await mpvCommand(["seek", Number(request.seconds), "relative"]);
      } else if (action === "volume") {
        if (request.volume === undefined) throw new Error("volume is required for volume.");
        await mpvCommand(["set_property", "volume", Number(request.volume)]);
      } else if (action === "state") {
        if (!player || player.process.exitCode !== null) return { content: [{ type: "text", text: JSON.stringify({ status: "stopped" }) }], details: { action, status: "stopped" } };
        const [pause, title, path] = await Promise.all([
          mpvCommand(["get_property", "pause"]),
          mpvCommand(["get_property", "media-title"]),
          mpvCommand(["get_property", "path"]),
        ]);
        const status = pause.data === true ? "paused" : stateLabel(path.data);
        return { content: [{ type: "text", text: JSON.stringify({ status, title: title.data || player.current?.title || null, path: path.data || player.current?.url || null }) }], details: { action, status } };
      } else {
        throw new Error(`unsupported YouTube action: ${action}`);
      }
      return { content: [{ type: "text", text: `YouTube playback command completed: ${action}.` }], details: { action } };
    },
  });
}
