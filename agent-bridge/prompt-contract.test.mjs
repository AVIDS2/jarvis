import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [agents, persona] = await Promise.all([
  readFile(resolve(root, "AGENTS.md"), "utf8"),
  readFile(resolve(root, ".pi", "APPEND_SYSTEM.md"), "utf8"),
]);

assert.match(persona, /只追加到 Pi 的默认系统提示词之后/);
assert.match(persona, /运行时提供名称/);
assert.match(persona, /白月光/);
assert.match(persona, /角色感不能授予不存在的能力/);
assert.match(persona, /第一次工具调用前/);
assert.match(persona, /主动对话只能由真实的系统事件/);
assert.match(persona, /禁止关键词表|固定关键词表/);
assert.match(persona, /睡眠仅代表助手进入待机/);
assert.match(persona, /当前 Pi 会话是短期上下文的权威来源/);
assert.match(persona, /长期记忆按四类理解/);
assert.doesNotMatch(persona, /Xiao Ai Tong Xue|小爱同学/);
assert.doesNotMatch(agents, /Xiao Ai Tong Xue|白月光|青梅|轻微、互相的暧昧/);
assert.match(agents, /\.pi\/APPEND_SYSTEM\.md/);

console.log("prompt contract ok");
