import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { authorizeStandbyChange } from "./standby-authorization.mjs";
import {
  visualStateFromToolEnd,
  visualStateFromToolStart,
  visualStateFromToolUpdate,
} from "./visual-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const envFile = resolve(ROOT, ".env");

function loadEnvFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

loadEnvFile(envFile);

const PORT = Number(process.env.JARVIS_PORT || 3030);
const MODEL_ID = process.env.JARVIS_MODEL || "mimo-v2.5";
const ASSISTANT_NAME = (process.env.JARVIS_ASSISTANT_NAME || "实时语音助手").trim() || "实时语音助手";
const MEMORY_RECALL_TIMEOUT_MS = Number(process.env.JARVIS_MEMORY_RECALL_TIMEOUT_MS || 120);
const VOICE_TRANSCRIPT_CUSTOM_TYPE = "realtime-voice-transcript";
const SESSION_REBASE_SUMMARY = [
  "This is a deliberate conversation handoff under the current workspace AGENTS.md rules.",
  "Discard all historical persona, user-name, and form-of-address assumptions.",
  "Address the user as 你 by default. Do not use any fixed name or pet name unless the user explicitly asks in the current conversation.",
  `The assistant is ${ASSISTANT_NAME}, the user's private real-time computer voice assistant.`,
  "Keep future conversation continuity from this point forward; the prior session is retained only as an archive.",
].join(" ");
const XIAOMI_API_KEY = (process.env.XIAOMI_API_KEY || "").trim();
const MEM0_API_KEY = (process.env.MEM0_API_KEY || "").trim();
const DATA_ROOT = resolve(ROOT, "runtime");
const SESSION_ROOT = resolve(DATA_ROOT, "pi-sessions");
const SESSION_INDEX_PATH = resolve(DATA_ROOT, "pi-session-index.json");
const USER_SESSIONS_PATH = resolve(DATA_ROOT, "user-sessions.json");
const PI_CLI_PATH = resolve(ROOT, "..", "pi", "packages", "coding-agent", "dist", "cli.js");
const NETEASE_ROOT = resolve(ROOT, "packages", "netease-music");
const NETEASE_CLI = resolve(NETEASE_ROOT, "node_modules", "@music163", "ncm-cli", "dist", "index.js");
const NETEASE_CONFIG_ROOT = resolve(
  process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"),
  "ncm-cli",
);
const NETEASE_CREDENTIALS = resolve(NETEASE_CONFIG_ROOT, "credentials.enc.json");
const NETEASE_CONFIG = resolve(NETEASE_CONFIG_ROOT, "config.json");
mkdirSync(SESSION_ROOT, { recursive: true });
if (existsSync(PI_CLI_PATH) && !process.env.JARVIS_PI_CLI_PATH) process.env.JARVIS_PI_CLI_PATH = PI_CLI_PATH;

if (!XIAOMI_API_KEY) throw new Error("XIAOMI_API_KEY is required");
const baseModel = getModel("xiaomi", MODEL_ID);
if (!baseModel) throw new Error(`Pi model is unavailable: xiaomi/${MODEL_ID}`);
const model = {
  ...baseModel,
  samplingParams: { ...baseModel.samplingParams, temperature: 1 },
};

let MemoryClient;
if (MEM0_API_KEY) {
  ({ MemoryClient } = await import("mem0ai"));
}
const memory = MEM0_API_KEY ? new MemoryClient({ apiKey: MEM0_API_KEY }) : null;
const sessions = new Map();
const activeRequests = new Map();
const compactingSessions = new Map();
const rebasingSessions = new Set();
const BUILTIN_TOOL_NAMES = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

function loadSessionIndex() {
  try {
    const parsed = JSON.parse(readFileSync(SESSION_INDEX_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string" && basename(value) === value),
    );
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Ignoring invalid Pi session index.");
    return {};
  }
}

const sessionIndex = loadSessionIndex();

function loadUserSessionIds() {
  try {
    const parsed = JSON.parse(readFileSync(USER_SESSIONS_PATH, "utf8"));
    const ids = Array.isArray(parsed?.sessionIds) ? parsed.sessionIds : [];
    return new Set([
      "jarvis-default",
      ...ids.filter((id) => typeof id === "string" && /^jarvis-[A-Za-z0-9._-]+$/.test(id)),
    ]);
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Ignoring invalid user session list.");
    return new Set(["jarvis-default"]);
  }
}

const userSessionIds = loadUserSessionIds();

function saveUserSessionIds() {
  writeFileSync(USER_SESSIONS_PATH, `${JSON.stringify({ sessionIds: [...userSessionIds] }, null, 2)}\n`, "utf8");
}

function defaultSessionName(id) {
  return id === "jarvis-default" ? ASSISTANT_NAME : "新会话";
}

function saveSessionIndex() {
  writeFileSync(SESSION_INDEX_PATH, `${JSON.stringify(sessionIndex, null, 2)}\n`, "utf8");
}

function openOrCreateSessionManager(id) {
  const savedFileName = sessionIndex[id];
  if (savedFileName && basename(savedFileName) === savedFileName) {
    const savedPath = resolve(SESSION_ROOT, savedFileName);
    if (existsSync(savedPath)) {
      try {
        const restored = SessionManager.open(savedPath, SESSION_ROOT, ROOT);
        if (restored.getSessionId() === id) return restored;
      } catch (error) {
        console.warn(`Could not restore Pi session ${id}; starting a new session.`);
      }
    }
  }

  const created = SessionManager.create(ROOT, SESSION_ROOT, { id });
  const sessionFile = created.getSessionFile();
  if (!sessionFile) throw new Error("Pi did not create a session file");
  sessionIndex[id] = basename(sessionFile);
  saveSessionIndex();
  return created;
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sessionId(value) {
  const id = String(value || "default");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    throw new Error("invalid session_id");
  }
  return id;
}

const NETEASE_ACTION_ARGS = Object.freeze({
  pause: ["pause"],
  resume: ["resume"],
  next: ["next"],
  previous: ["prev"],
  stop: ["stop"],
  state: ["state"],
});

async function runNeteaseCli(args, timeout = 5000) {
  return execFileAsync(process.execPath, [NETEASE_CLI, ...args], {
    cwd: NETEASE_ROOT,
    env: process.env,
    windowsHide: true,
    timeout,
    maxBuffer: 256 * 1024,
  });
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function launchNeteaseLogin() {
  if (!existsSync(NETEASE_CLI)) throw new Error("ncm-cli 未安装");
  if (process.platform !== "win32") throw new Error("当前仅实现 Windows 终端登录启动");

  const command = [
    `$Host.UI.RawUI.WindowTitle = ${powershellLiteral("Jarvis · 网易云官方登录")}`,
    `Set-Location -LiteralPath ${powershellLiteral(NETEASE_ROOT)}`,
    `& ${powershellLiteral(process.execPath)} ${powershellLiteral(NETEASE_CLI)} login`,
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoExit", "-NoLogo", "-Command", command], {
    cwd: NETEASE_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { started: true };
}

function parseCliJson(stdout) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
}

function musicStateSummary(state) {
  const status = String(state?.status || "").toLowerCase();
  const labels = { playing: "播放中", paused: "已暂停", stopped: "已停止" };
  const label = labels[status] || (status ? status : "状态未知");
  const queueLength = Number.isFinite(Number(state?.queueLength)) ? `，队列 ${state.queueLength} 首` : "";
  return `网易云：${label}${queueLength}`;
}

function commandNames(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => /^([a-z][a-z0-9-]*)\s/.exec(line)?.[1])
    .filter(Boolean);
}

async function neteaseExtensionStatus() {
  const configured = existsSync(NETEASE_CONFIG) && existsSync(NETEASE_CREDENTIALS);
  if (!existsSync(NETEASE_CLI)) {
    return {
      id: "netease_music",
      label: "网易云音乐",
      package: "@music163/ncm-cli",
      status: "unavailable",
      description: "未找到本地 ncm-cli，播放控制不会伪装成可用。",
      auth: { configured, authenticated: false, message: "ncm-cli 未安装" },
      player: { summary: "播放器不可用" },
      availableActions: [],
    };
  }

  let authenticated = false;
  let authMessage = configured ? "登录态未验证" : "尚未完成一次 CLI 配置和登录";
  try {
    const result = await runNeteaseCli(["login", "--check", "--output", "json"]);
    const payload = parseCliJson(result.stdout);
    authenticated = payload?.success === true;
    authMessage = String(payload?.message || (authenticated ? "登录态有效" : authMessage));
  } catch {
    authMessage = "登录检查失败，未自动发起登录";
  }

  let player = { summary: "播放器状态未读取" };
  try {
    const result = await runNeteaseCli(["state", "--output", "json"]);
    const payload = parseCliJson(result.stdout);
    if (payload?.state) player = { ...payload.state, summary: musicStateSummary(payload.state) };
  } catch {
    player = { summary: "播放器状态不可用" };
  }

  let availableActions = [];
  try {
    const result = await runNeteaseCli(["commands"]);
    const names = new Set(commandNames(result.stdout));
    availableActions = ["search", "recommend", "pause", "resume", "next", "prev", "stop", "state", "volume", "play"]
      .filter((name) => names.has(name));
  } catch {
    // The capability panel remains useful with auth/player state alone.
  }

  return {
    id: "netease_music",
    label: "网易云音乐",
    package: "@music163/ncm-cli",
    status: authenticated ? "ready" : configured ? "auth_required" : "needs_setup",
    description: availableActions.includes("search")
      ? "Pi 外部扩展，通过 ncm-cli 控制本机播放器和搜索。"
      : "Pi 外部扩展，可控制本机播放器；当前安装的 ncm-cli 未暴露 search 命令，点歌能力暂不可用。",
    auth: { configured, authenticated, message: authMessage },
    player,
    availableActions,
  };
}

async function extensionCatalog() {
  const definitions = [
    ["jarvis_voice_control", "语音与待机", "云端 TTS、音色配置和唤醒词待机控制。", ["set_tts_voice", "set_assistant_standby"], true],
    ["jarvis_character_control", "角色状态", "把 Agent 的表达状态同步给原生交互形象。", ["show_assistant_expression"], true],
    ["jarvis_subagents", "后台子代理", "按 Pi 扩展生命周期派发可追踪的后台任务。", ["delegate_task"], true],
    ["jarvis_long_memory", "长期记忆", "在 Pi 会话外接入长期记忆召回，不改变短期上下文。", [], Boolean(MEM0_API_KEY)],
  ].map(([id, label, description, tools, enabled]) => ({
    id,
    label,
    package: id,
    tools,
    status: enabled ? "已加载" : "未配置",
    description: enabled ? description : `${description} 当前未配置 Mem0 API Key，不会伪装成已启用。`,
  }));
  return {
    generatedAt: new Date().toISOString(),
    extensions: [...definitions, await neteaseExtensionStatus()],
  };
}

async function controlNeteaseMusic(action, payload = {}) {
  const args = action === "volume"
    ? ["volume", String(Math.max(0, Math.min(100, Number(payload.level))))]
    : NETEASE_ACTION_ARGS[action];
  if (action === "volume" && !Number.isFinite(Number(payload.level))) {
    throw new Error("volume must be a number between 0 and 100");
  }
  if (!args) throw new Error("unsupported music control action");
  const result = await runNeteaseCli(args);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const resultPayload = parseCliJson(result.stdout);
  let state = resultPayload?.state || null;
  if (!state && action !== "state") {
    try {
      const stateResult = await runNeteaseCli(["state", "--output", "json"]);
      state = parseCliJson(stateResult.stdout)?.state || null;
    } catch {
      // The command already succeeded; the panel can still show its result.
    }
  }
  return {
    action,
    state: state || null,
    summary: state ? musicStateSummary(state) : `网易云命令已执行：${action}`,
    output: output.slice(0, 2000),
  };
}

async function getSession(id) {
  let entry = sessions.get(id);
  if (entry) return entry;
  const sessionManager = openOrCreateSessionManager(id);
  entry = await createSessionEntry(sessionManager);
  sessions.set(id, entry);
  return entry;
}

async function createSessionEntry(sessionManager) {
  let entry;
  entry = {
    sessionManager,
    memoryContext: "",
    currentTurnPrompt: "",
    live: null,
    eventListeners: new Set(),
    unsubscribeEvents: null,
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: ROOT,
    agentDir: resolve(DATA_ROOT, "pi-agent"),
    extensionFactories: [
      {
        name: "jarvis-long-memory",
        factory: (pi) => {
          pi.on("before_agent_start", async (event) => {
            entry.currentTurnPrompt = event.prompt;
            return {
              systemPrompt: [
                event.systemPrompt,
                `Runtime identity: your configured display name is ${ASSISTANT_NAME}. When asked who you are, introduce yourself using that exact name.`,
                entry.memoryContext,
              ].filter(Boolean).join("\n\n"),
            };
          });
          pi.on("tool_call", async (event, ctx) => {
            if (event.toolName === "show_assistant_expression") return;
            if (event.toolName === "set_assistant_standby") {
              const mode = String(event.input?.mode || "");
              const authorized = (mode === "sleep" || mode === "wake")
                && await authorizeStandbyChange(ctx.model || model, entry.currentTurnPrompt, mode, ctx.signal);
              if (!authorized) {
                return {
                  block: true,
                  reason: "Standby state changes require an explicit, unambiguous request in the current user utterance.",
                };
              }
            }
            const live = entry.live;
            if (!live || live.assistantTextStarted || live.acknowledgementSent || !live.sendProgress) {
              live?.flushVisualQueue?.();
              return;
            }
            const acknowledgement = await generateToolAcknowledgement(ctx.model || model, live.userText);
            if (!acknowledgement || entry.live !== live || !live.sendProgress) {
              live.flushVisualQueue?.();
              return;
            }
            live.acknowledgementSent = true;
            live.sendProgress(acknowledgement, "tool_acknowledgement");
            // Let the streamed acknowledgement reach the TTS worker before the
            // real tool starts. It is short enough not to make work feel gated.
            await new Promise((resolve) => setTimeout(resolve, TOOL_ACK_AUDIO_LEAD_MS));
            live.flushVisualQueue?.();
          });
        },
      },
    ],
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd: ROOT,
    agentDir: resolve(DATA_ROOT, "pi-agent"),
    sessionManager,
    resourceLoader,
    model,
    thinkingLevel: "off",
  });
  entry.session = created.session;
  // The standalone agent runtime starts fully capable even when no Web client
  // is connected. A UI preset may narrow built-ins later, but never extensions.
  entry.session.setActiveToolsByName(entry.session.getAllTools().map((tool) => tool.name));
  entry.unsubscribeEvents = created.session.subscribe((event) => publishSessionEvent(entry, event));
  return entry;
}

async function rebaseSession(id) {
  if (activeRequests.has(id) || compactingSessions.has(id) || rebasingSessions.has(id)) {
    throw new Error("session is busy");
  }

  rebasingSessions.add(id);
  try {
    const previousFile = sessionIndex[id] || null;
    const activeEntry = sessions.get(id);
    if (activeEntry) {
      await activeEntry.session.abort();
      await activeEntry.session.dispose();
      activeEntry.unsubscribeEvents?.();
      sessions.delete(id);
    }

    // Pi sessions are append-only. Creating a new root is the supported way to
    // discard a polluted historical summary while preserving the client session id.
    const replacement = SessionManager.create(ROOT, SESSION_ROOT, { id });
    replacement.branchWithSummary(null, SESSION_REBASE_SUMMARY, { source: "identity-rebase" }, true);
    const replacementFile = replacement.getSessionFile();
    if (!replacementFile) throw new Error("Pi did not create a replacement session file");
    sessionIndex[id] = basename(replacementFile);
    saveSessionIndex();
    // Pi delays writing a new session file until its first real assistant
    // response. Keep this manager live so the handoff summary is part of that
    // first turn and becomes persisted by Pi without manually editing JSONL.
    sessions.set(id, await createSessionEntry(replacement));
    return { previousFile, replacementFile: basename(replacementFile) };
  } finally {
    rebasingSessions.delete(id);
  }
}

function textFromMessage(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("").trim();
}

const TOOL_ACK_TIMEOUT_MS = 4_000;
const TOOL_ACK_AUDIO_LEAD_MS = 900;
const TOOL_ACK_SYSTEM_PROMPT = [
  `你是${ASSISTANT_NAME}的实时语音对话层。用户刚提出一个需要执行的请求。`,
  "只输出一句自然、简短、适合立刻朗读的回应，表示你已接住这件事并马上开始。",
  "语气跟随上下文，避免套话，不要复述、引用或总结用户原话，不要提及工具、系统、模型、处理中。",
  "不要 Markdown、emoji、引号或解释。若无法自然回应，输出空文本。",
].join("\n");

async function generateToolAcknowledgement(currentModel, userText) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_ACK_TIMEOUT_MS);
  try {
    const stream = streamSimple(
      currentModel,
      {
        systemPrompt: TOOL_ACK_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userText }],
            timestamp: Date.now(),
          },
        ],
      },
      { signal: controller.signal, reasoning: "off", maxTokens: 48 },
    );
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.delta;
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized.length > 96) {
          controller.abort();
          return "";
        }
        if (/[。！？!?]$/.test(normalized)) {
          controller.abort();
          return normalized;
        }
      }
      if (event.type === "error") {
        console.warn(`Tool acknowledgement was not generated: ${event.error.errorMessage || event.reason}`);
        return "";
      }
    }
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length > 0 && normalized.length <= 96 ? normalized : "";
  } catch (error) {
    console.warn(`Tool acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function spokenToolUpdate(partialResult) {
  const details = partialResult && typeof partialResult === "object" ? partialResult.details : null;
  const candidate = details?.spoken_progress ?? details?.spokenProgress;
  if (typeof candidate !== "string") return "";
  const text = candidate.replace(/\s+/g, " ").trim();
  return text.length <= 160 ? text : "";
}

async function recall(userText, userId) {
  if (!memory) return "";
  // Long-term recall is useful, but it must never hold up a realtime voice turn.
  // Pi's persisted session remains the authoritative short-term conversation context.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), MEMORY_RECALL_TIMEOUT_MS));
  const result = await Promise.race([
    memory.search(userText, { filters: { user_id: userId }, top_k: 5 }),
    timeout,
  ]);
  if (!result) return "";
  const items = Array.isArray(result) ? result : result?.results || [];
  const lines = items
    .map((item) => String(item?.memory || item?.text || "").trim())
    .filter(Boolean);
  return lines.length ? `\n\n长期记忆（仅在相关时使用）：\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

async function saveMemory(userText, assistantText, userId, sessionIdValue) {
  if (!memory) return;
  await memory.add(
    [
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    ],
    { user_id: userId, metadata: { source: "jarvis", session_id: sessionIdValue } },
  );
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Pi's JSON/RPC modes project streaming events this way: message deltas are
// linear-size, while every other AgentSession event stays structurally native.
function toPiJsonEvent(event) {
  if (event.type !== "message_update") return event;
  if (event.message?.role !== "assistant") return null;
  const update = event.assistantMessageEvent;
  if (!update || typeof update !== "object") return null;
  const { partial: _partial, ...assistantMessageEvent } = update;
  return {
    type: "message_update",
    usage: event.message.usage,
    assistantMessageEvent,
  };
}

function contextUsageEvent(entry) {
  const usage = entry.session.getContextUsage();
  return {
    type: "context.usage",
    tokens: usage?.tokens ?? null,
    contextWindow: usage?.contextWindow ?? null,
    percent: usage?.percent ?? null,
  };
}

function sessionSnapshot(entry) {
  const sessionManager = entry.sessionManager;
  const entries = sessionManager.getEntries();
  const header = sessionManager.getHeader();
  const firstUser = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
  return {
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile() || "",
    sessionName: sessionManager.getSessionName() || defaultSessionName(sessionManager.getSessionId()),
    header,
    entries,
    leafId: sessionManager.getLeafId(),
    tree: sessionManager.getTree(),
    firstMessage: textFromMessage(firstUser?.message) || "(no messages)",
    totalActiveMs: 0,
  };
}

function sessionListItem(entry) {
  const snapshot = sessionSnapshot(entry);
  return {
    sessionId: snapshot.sessionId,
    sessionFile: snapshot.sessionFile,
    sessionName: snapshot.sessionName,
    header: snapshot.header,
    firstMessage: snapshot.firstMessage,
    messageCount: snapshot.entries.length,
  };
}

async function listUserSessions() {
  const entries = await Promise.all(
    [...userSessionIds].map(async (id) => sessionListItem(await getSession(id))),
  );
  return entries.sort((left, right) => {
    if (left.sessionId === "jarvis-default") return -1;
    if (right.sessionId === "jarvis-default") return 1;
    const leftTimestamp = Date.parse(left.header?.timestamp || "") || 0;
    const rightTimestamp = Date.parse(right.header?.timestamp || "") || 0;
    return rightTimestamp - leftTimestamp;
  });
}

async function createUserSession() {
  const id = `jarvis-${randomUUID()}`;
  userSessionIds.add(id);
  saveUserSessionIds();
  return sessionListItem(await getSession(id));
}

async function renameUserSession(id, name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new Error("name is required");
  const entry = await getSession(id);
  entry.sessionManager.appendSessionInfo(trimmed.slice(0, 120));
  return sessionListItem(entry);
}

function sessionTools(entry) {
  const active = new Set(entry.session.getActiveToolNames());
  return entry.session.getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    active: active.has(tool.name),
  }));
}

function setSessionTools(entry, requestedNames) {
  const requested = Array.isArray(requestedNames)
    ? requestedNames.filter((name) => typeof name === "string")
    : [];
  // Pi Web presets control only Pi's built-in filesystem/shell tools. Project
  // extensions belong to the agent runtime and must not disappear with the UI.
  const extensionNames = entry.session
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => !BUILTIN_TOOL_NAMES.has(name));
  entry.session.setActiveToolsByName([...new Set([...requested, ...extensionNames])]);
  return sessionTools(entry);
}

async function promptSession(id, userText, userId = "local_user") {
  const entry = await getSession(id);
  const pendingCompaction = compactingSessions.get(id);
  if (pendingCompaction) await pendingCompaction.catch(() => undefined);
  entry.memoryContext = await recall(userText, userId);
  activeRequests.set(id, entry.session);
  try {
    await entry.session.prompt(userText);
  } finally {
    entry.memoryContext = "";
    if (activeRequests.get(id) === entry.session) activeRequests.delete(id);
  }
}

function persistVoiceTranscript(entry, content, source) {
  const text = String(content || "").trim();
  if (!text) return;
  void entry.session.sendCustomMessage({
    customType: VOICE_TRANSCRIPT_CUSTOM_TYPE,
    content: [{ type: "text", text }],
    display: true,
    details: { source },
  }, { triggerTurn: false }).catch((error) => {
    console.warn(`Could not persist voice transcript: ${String(error?.message || error)}`);
  });
}

function publishSessionEvent(entry, event) {
  const payload = toPiJsonEvent(event);
  if (payload) {
    for (const listener of entry.eventListeners) listener(payload);
  }
  if (event.type === "agent_end" || event.type === "compaction_end") {
    const usage = contextUsageEvent(entry);
    for (const listener of entry.eventListeners) listener(usage);
  }
}

async function handleSessionEvents(req, res, id) {
  const entry = await getSession(id);
  if (req.destroyed) return;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const listener = (event) => {
    if (!res.writableEnded) sse(res, event);
  };
  entry.eventListeners.add(listener);
  sse(res, {
    type: "connected",
    sessionId: id,
    isStreaming: entry.session.isStreaming,
    isPromptRunning: activeRequests.has(id),
  });
  sse(res, contextUsageEvent(entry));

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(":\n\n");
  }, 30_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    entry.eventListeners.delete(listener);
  };
  req.once("close", cleanup);
}

async function handleCompletion(req, res, payload) {
  const id = sessionId(payload.session_id || payload.user || "default");
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const userMessage = [...messages].reverse().find((message) => message?.role === "user");
  const userText = textFromMessage(userMessage);
  if (!userText) throw new Error("messages must contain a user message");

  const entry = await getSession(id);
  const memoryContext = await recall(userText, String(payload.user_id || "local_user"));
  const pendingCompaction = compactingSessions.get(id);
  if (pendingCompaction) await pendingCompaction.catch(() => undefined);
  entry.memoryContext = memoryContext;
  activeRequests.set(id, entry.session);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let assistantText = "";
  let assistantFailure = "";
  let assistantAborted = false;
  let disconnected = false;
  const live = {
    userText,
    abortRequested: false,
    acknowledgementSent: false,
    assistantTextStarted: false,
    sendProgress: null,
    sendVisualState: null,
    visualQueue: [],
    flushVisualQueue: null,
    spokenProgress: new Set(),
  };
  entry.live = live;
  const sendProgress = (content, source) => {
    const text = String(content || "").trim();
    if (!text || disconnected || res.writableEnded) return;
    const progressKey = `${source || "voice_progress"}:${text}`;
    if (live.spokenProgress.has(progressKey)) return;
    live.spokenProgress.add(progressKey);
    persistVoiceTranscript(entry, text, source || "voice_progress");
    sse(res, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  };
  live.sendProgress = sendProgress;
  live.sendVisualState = (visualEvent) => {
    if (!visualEvent || disconnected || res.writableEnded) return;
    sse(res, visualEvent);
  };
  live.flushVisualQueue = () => {
    if (!live.visualQueue.length) return;
    const queued = live.visualQueue.splice(0);
    for (const visualEvent of queued) live.sendVisualState(visualEvent);
  };
  const queueOrSendVisualState = (visualEvent, toolName) => {
    if (!visualEvent) return;
    // A visual work indicator must not get ahead of the model-generated spoken
    // acknowledgement. This is an SSE-only ordering buffer; the Pi tool hook
    // still owns execution and remains independent of the browser.
    if (
      toolName !== "show_assistant_expression"
      && !live.assistantTextStarted
      && !live.acknowledgementSent
    ) {
      live.visualQueue.push(visualEvent);
      return;
    }
    live.sendVisualState(visualEvent);
  };
  const onResponseClose = () => {
    if (res.writableEnded) return;
    disconnected = true;
    void entry.session.abort();
  };
  res.once("close", onResponseClose);

  const unsubscribe = entry.session.subscribe((event) => {
    if (disconnected) return;
    if (event.type === "tool_execution_start") {
      queueOrSendVisualState(visualStateFromToolStart(event), event.toolName);
      return;
    }
    if (event.type === "tool_execution_update") {
      queueOrSendVisualState(visualStateFromToolUpdate(event), event.toolName);
      const progress = spokenToolUpdate(event.partialResult);
      if (!progress) return;
      sendProgress(progress, "tool_progress");
      return;
    }
    if (event.type === "tool_execution_end") {
      queueOrSendVisualState(visualStateFromToolEnd(event), event.toolName);
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type !== "text_delta" || !update.delta) return;
      live.assistantTextStarted = true;
      assistantText += update.delta;
      sse(res, { choices: [{ index: 0, delta: { content: update.delta }, finish_reason: null }] });
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      assistantAborted = event.message.stopReason === "aborted";
      assistantFailure = event.message.stopReason === "error"
        ? String(event.message.errorMessage || "The model request failed before producing a response.")
        : "";
      if (!assistantText.trim()) {
        const finalText = textFromMessage(event.message);
        if (!finalText) return;
        live.assistantTextStarted = true;
        assistantText = finalText;
        sse(res, { choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }] });
      }
    }
  });

  try {
    await entry.session.prompt(userText);
    if (!disconnected && assistantFailure) {
      sse(res, { error: { message: assistantFailure } });
      res.write("data: [DONE]\n\n");
    } else if (!disconnected && (assistantText.trim() || live.acknowledgementSent)) {
      if (assistantText.trim()) {
        await saveMemory(userText, assistantText, String(payload.user_id || "local_user"), id);
      }
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
    } else if (!disconnected && assistantAborted && live.abortRequested) {
      // A voice or UI interruption is a successful cancellation, not an LLM
      // failure. The realtime backend already owns the interrupted state.
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
    } else if (!disconnected) {
      sse(res, { error: { message: "The agent turn ended without a speakable response." } });
      res.write("data: [DONE]\n\n");
    }
  } finally {
    res.off("close", onResponseClose);
    unsubscribe();
    entry.memoryContext = "";
    if (entry.live === live) entry.live = null;
    activeRequests.delete(id);
    if (!res.writableEnded) res.end();
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        provider: "xiaomi",
        model: MODEL_ID,
        memory: Boolean(memory),
        memoryRecallTimeoutMs: MEMORY_RECALL_TIMEOUT_MS,
      });
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "xiaomi" }] });
    }
    if (req.method === "GET" && req.url === "/v1/extensions") {
      return json(res, 200, await extensionCatalog());
    }
    if (req.method === "POST" && req.url === "/v1/extensions/netease-music/login") {
      try {
        return json(res, 200, launchNeteaseLogin());
      } catch (error) {
        return json(res, 409, { error: { message: error.message || "无法启动网易云官方登录" } });
      }
    }
    if (req.method === "POST" && req.url === "/v1/extensions/netease-music/control") {
      const payload = await body(req);
      const action = String(payload.action || "").trim();
      if (!NETEASE_ACTION_ARGS[action] && action !== "volume") {
        return json(res, 400, { error: { message: "unsupported music control action" } });
      }
      try {
        return json(res, 200, await controlNeteaseMusic(action, payload));
      } catch (error) {
        return json(res, 502, { error: { message: "网易云播放器命令执行失败，请检查 ncm-cli 和本机播放器。" } });
      }
    }
    if (req.method === "GET" && req.url === "/v1/sessions") {
      return json(res, 200, { sessions: await listUserSessions() });
    }
    if (req.method === "POST" && req.url === "/v1/sessions") {
      return json(res, 201, { session: await createUserSession() });
    }
    const eventsMatch = req.method === "GET" && req.url?.match(/^\/v1\/sessions\/([^/?]+)\/events$/);
    if (eventsMatch) {
      const id = sessionId(decodeURIComponent(eventsMatch[1]));
      return await handleSessionEvents(req, res, id);
    }
    const snapshotMatch = req.method === "GET" && req.url?.match(/^\/v1\/sessions\/([^/?]+)\/snapshot$/);
    if (snapshotMatch) {
      const id = sessionId(decodeURIComponent(snapshotMatch[1]));
      return json(res, 200, sessionSnapshot(await getSession(id)));
    }
    const stateMatch = req.method === "GET" && req.url?.match(/^\/v1\/sessions\/([^/?]+)\/state$/);
    if (stateMatch) {
      const id = sessionId(decodeURIComponent(stateMatch[1]));
      const entry = await getSession(id);
      return json(res, 200, {
        running: activeRequests.has(id) || entry.session.isStreaming,
        state: {
          contextUsage: contextUsageEvent(entry),
          isStreaming: entry.session.isStreaming,
          isPromptRunning: activeRequests.has(id),
          isBashRunning: false,
          isCompacting: compactingSessions.has(id),
          thinkingLevel: "off",
          model: { provider: "xiaomi", id: MODEL_ID },
        },
      });
    }
    const renameMatch = req.method === "PATCH" && req.url?.match(/^\/v1\/sessions\/([^/?]+)$/);
    if (renameMatch) {
      const id = sessionId(decodeURIComponent(renameMatch[1]));
      if (!userSessionIds.has(id)) return json(res, 404, { error: { message: "session not found" } });
      const payload = await body(req);
      return json(res, 200, { session: await renameUserSession(id, payload.name) });
    }
    const toolsMatch = req.url?.match(/^\/v1\/sessions\/([^/?]+)\/tools$/);
    if (toolsMatch && req.method === "GET") {
      const id = sessionId(decodeURIComponent(toolsMatch[1]));
      return json(res, 200, { tools: sessionTools(await getSession(id)) });
    }
    if (toolsMatch && req.method === "POST") {
      const id = sessionId(decodeURIComponent(toolsMatch[1]));
      const payload = await body(req);
      const entry = await getSession(id);
      if (activeRequests.has(id) || entry.session.isStreaming) {
        return json(res, 409, { error: { message: "session is busy" } });
      }
      return json(res, 200, { tools: setSessionTools(entry, payload.tool_names) });
    }
    const promptMatch = req.method === "POST" && req.url?.match(/^\/v1\/sessions\/([^/?]+)\/prompt$/);
    if (promptMatch) {
      const id = sessionId(decodeURIComponent(promptMatch[1]));
      const payload = await body(req);
      const userText = String(payload.message || "").trim();
      if (!userText) return json(res, 400, { error: { message: "message is required" } });
      await promptSession(id, userText, String(payload.user_id || "local_user"));
      return json(res, 200, { ok: true, session_id: id });
    }
    const abortMatch = req.method === "POST" && req.url?.match(/^\/v1\/sessions\/([^/?]+)\/abort$/);
    if (abortMatch) {
      const id = sessionId(decodeURIComponent(abortMatch[1]));
      const entry = await getSession(id);
      if (entry.live) entry.live.abortRequested = true;
      await entry.session.abort();
      return json(res, 200, { ok: true, session_id: id });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const payload = await body(req);
      return await handleCompletion(req, res, payload);
    }
    const rebaseMatch = req.method === "POST" && req.url?.match(/^\/v1\/sessions\/([^/?]+)\/rebase$/);
    if (rebaseMatch) {
      const id = sessionId(decodeURIComponent(rebaseMatch[1]));
      const result = await rebaseSession(id);
      return json(res, 200, { ok: true, session_id: id, ...result });
    }
    const compactMatch = req.method === "POST" && req.url?.match(/^\/v1\/sessions\/([^/?]+)\/compact$/);
    if (compactMatch) {
      const id = sessionId(decodeURIComponent(compactMatch[1]));
      if (activeRequests.has(id) || compactingSessions.has(id)) {
        return json(res, 409, { error: { message: "session is busy" } });
      }
      const entry = await getSession(id);
      const usage = entry.session.getContextUsage();
      const compaction = entry.session.compact();
      compactingSessions.set(id, compaction);
      let result;
      try {
        result = await compaction;
      } finally {
        compactingSessions.delete(id);
      }
      return json(res, 200, {
        ok: true,
        session_id: id,
        tokens_before: result.tokensBefore,
        estimated_tokens_after: result.estimatedTokensAfter,
        context_tokens_before: usage?.tokens ?? null,
      });
    }
    const clearMatch = req.method === "DELETE" && req.url?.match(/^\/v1\/sessions\/([^/?]+)$/);
    if (clearMatch) {
      const id = sessionId(decodeURIComponent(clearMatch[1]));
      if (id === "jarvis-default") {
        return json(res, 400, { error: { message: "the primary session cannot be deleted" } });
      }
      if (!userSessionIds.has(id)) {
        return json(res, 404, { error: { message: "session not found" } });
      }
      if (compactingSessions.has(id)) {
        return json(res, 409, { error: { message: "session is compacting" } });
      }
      const entry = sessions.get(id);
      if (entry) {
        await entry.session.abort();
        entry.session.dispose();
        entry.unsubscribeEvents?.();
        sessions.delete(id);
      }
      if (sessionIndex[id]) {
        delete sessionIndex[id];
        saveSessionIndex();
      }
      userSessionIds.delete(id);
      saveUserSessionIds();
      return json(res, 200, { ok: true, session_id: id });
    }
    return json(res, 404, { error: { message: "not found" } });
  } catch (error) {
    if (!res.headersSent) return json(res, 500, { error: { message: String(error?.message || error) } });
    if (!res.writableEnded) res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Jarvis Pi bridge listening on http://127.0.0.1:${PORT}`);
});
