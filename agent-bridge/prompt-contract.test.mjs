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
assert.match(persona, /运行时显示名|运行时名称/);
assert.match(persona, /语音只是你与用户相遇的媒介/);
assert.match(persona, /不是你的职业身份/);
assert.match(persona, /回答角色本体/);
assert.match(persona, /个人数字生活伙伴/);
assert.match(persona, /默认预设可以叫“?小爱同学/);
assert.match(persona, /角色感不能授予不存在的能力/);
assert.match(persona, /第一次工具调用前/);
assert.match(persona, /没有这些依据时/);
assert.match(persona, /关键词表、删词/);
assert.match(persona, /睡眠表示暂时守候/);
assert.match(persona, /Pi 会话是短期上下文的权威来源/);
assert.match(persona, /长期记忆只保存/);
assert.doesNotMatch(persona, /我是小爱同学的电脑实时语音助手/);
assert.doesNotMatch(agents, /Xiao Ai Tong Xue|电脑实时语音助手|白月光|青梅|轻微、互相的暧昧/);
assert.match(agents, /\.pi\/APPEND_SYSTEM\.md/);

console.log("prompt contract ok");
