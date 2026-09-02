<div align="center">

# Jarvis

### 把语音、记忆和行动，放进一个真正可持续的桌面 Agent

面向中文用户的开源实时语音智能体。它能听懂你正在说什么，保持连续上下文，调用 Pi 工具完成任务，并把回应以流式语音及时说出来。

[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](./LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-2563eb.svg)](#快速开始)
[![Status: Alpha](https://img.shields.io/badge/status-source%20alpha-f59e0b.svg)](#当前状态)

[快速开始](#快速开始) · [了解架构](#它是怎么工作的) · [参与贡献](./CONTRIBUTING.md) · [安全说明](./SECURITY.md)

</div>

> Jarvis 是一个由社区驱动的独立开源项目，不隶属于 Xiaomi、Pi、Whispera、Mem0 或任何其他上游项目。MiMo 是可选的外部模型服务，使用时请遵守对应服务条款并自行承担 API 费用。

## 先看它能做什么

Jarvis 不是一个把语音录下来再发给聊天接口的薄壳。它把实时音频、持久 Agent 会话和桌面行动连接成一条可以观察、可以中断、可以继续的工作流。

- **实时语音**：云端 ASR、流式文本、流式 TTS；讲话时可以打断正在播报的回应。
- **连续上下文**：Pi AgentSession 负责会话持久化和官方上下文压缩，不在 UI 层复制一套聊天状态。
- **任务执行**：通过 Pi 原生工具和项目扩展处理文件、桌面、屏幕、媒体与受限本地动作。
- **状态化角色**：Whispera 将聆听、思考、播报、工具执行和打断状态投影到角色表现层。
- **中文优先**：默认围绕中文语音、中文唤醒词和中英混合技术对话优化，保留原始技术名词。
- **本地优先**：Electron、桥接服务、会话数据和音频控制在本机运行；只有你配置的外部服务会访问云端。
- **可替换 UI**：稳定的原生 Electron renderer 与实验性的 React/shadcn renderer 分离，UI 迭代不需要重写语音和 Agent 核心。

## 当前状态

当前建议以 **Source Alpha** 方式发布：源码、启动脚本、扩展和验收脚本已经具备，适合开发者和中文社区用户体验、反馈和共建；暂时不把它包装成“开箱即用的安装包”。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Pi Agent bridge | 可用 | 单一 Pi AgentSession，持久会话，MiMo OpenAI-compatible provider |
| Whispera realtime | 可用 | ASR、VAD、打断、文本流、TTS、WebSocket |
| 原生 Electron UI | 稳定入口 | legacy，默认启动路径 |
| React + shadcn UI | 实验预览 | react，需要匹配的 Whispera React renderer |
| 长期记忆 | 可选 | Pi bridge 的 Mem0 云端能力可单独配置；本地 embedding 默认关闭 |
| 屏幕与桌面工具 | 可选 | 由扩展提供，危险动作需要明确授权和动作后验证 |
| Windows 安装包 | 尚未随源码发布 | 当前优先保证源码可审阅、可复现 |

## 快速开始

Jarvis 当前是一个跨仓库集成层。为了让依赖边界清楚，三个仓库需要放在同一个父目录中：

~~~text
jarvis-workspace/
├─ jarvis/       # 本仓库：Agent bridge、扩展和 Windows 启动入口
├─ pi/           # 上游 Pi：AgentSession、Pi AI、coding-agent
└─ whispera/     # Whispera：实时音频后端和 Electron 壳
~~~

### 1. 克隆源码

~~~powershell
New-Item -ItemType Directory -Force -Path .\jarvis-workspace | Out-Null
Set-Location .\jarvis-workspace

git clone https://github.com/AVIDS2/jarvis.git jarvis
git clone https://github.com/earendil-works/pi.git pi
git clone https://github.com/AVIDS2/Whispera.git whispera
~~~

jarvis/agent-bridge/package.json 使用本地 file:../../pi 依赖；不要把 pi 克隆到其他位置，否则 bridge 无法解析上游包。

### 2. 准备 Pi

要求 Node.js 22.19+。

~~~powershell
Set-Location .\pi
npm install
npm run build
~~~

### 3. 准备 Whispera 云端运行环境

要求 Windows 10/11、PowerShell、Python 3.11 和 Node.js。云端 ASR/TTS 模式不要求本地大模型权重；如果要启用本地模型或本地 TTS，请按 [Whispera README](https://github.com/AVIDS2/Whispera) 准备对应资源。

~~~powershell
Set-Location ..\jarvis
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r .\requirements-cloud.txt

npm install --prefix .\agent-bridge
npm install --prefix ..\whispera\electron-app
~~~

### 4. 配置 MiMo

~~~powershell
Copy-Item .\.env.example .\.env
notepad .\.env
~~~

至少配置：

~~~dotenv
XIAOMI_API_KEY=替换为你自己的密钥
JARVIS_MODEL=mimo-v2.5
JARVIS_ASSISTANT_NAME=Jarvis
JARVIS_PORT=3030
~~~

XIAOMI_API_KEY 只写入本机 .env。 .env 已被 Git 忽略，绝不要把真实密钥提交到仓库、截图或 Issue。MiMo 官方文档：[OpenAI Chat Completions 兼容接口](https://mimo.mi.com/docs/en-US/api/chat/openai-api)。

### 5. 启动

本地开发不需要 Docker，也不需要 Docker Compose。启动脚本会读取 .env，拉起 Pi bridge 和 Whispera Electron 运行链路。

~~~powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\run.ps1 -Ui legacy
~~~

可选 UI：

~~~powershell
# 稳定的原生 Electron 语音界面
.\run.ps1 -Ui legacy

# React + shadcn 工作台预览；需要匹配的 Whispera React 分支/构建
.\run.ps1 -Ui react

# pi-web 实验入口；不是默认语音宿主
.\run.ps1 -Ui web
~~~

不要同时启动两个麦克风客户端。Electron 使用单实例锁，重复启动只会唤起已有窗口。

## 它是怎么工作的

~~~text
麦克风 / 文字输入
        │
        ▼
Whispera realtime backend
  VAD · ASR · interruption · TTS · WebSocket
        │
        ▼
Jarvis Pi bridge :3030
  one AgentSession · persistent context · Pi tools · extensions
        │
        ▼
MiMo API / optional Mem0 / local desktop capabilities
        │
        ▼
streamed text + audio + visual state
~~~

关键边界：

- Whispera 负责麦克风、PCM、VAD、ASR、TTS、播放和实时 WebSocket。
- Jarvis bridge 是 Jarvis 对话唯一的 Pi AgentSession 所有者。
- Pi 负责工具调用、上下文持久化和官方 compaction。
- Electron renderer 只消费实时事件，不创建第二个 Agent loop。
- React UI 通过现有 preload 和 WebSocket 接入，不把 AI SDK useChat 作为第二条传输链路。

因此，替换 UI 不应该改变语音延迟、打断语义、Agent 会话或工具状态。发现 UI 问题时，请先确认问题发生在 renderer、preload、Whispera 还是 bridge，而不是直接在 UI 层增加等待队列。

## 实时体验与可靠性

- 用户的新发言沿用 Whispera 的实时打断路径，播放会在权威的语音状态变化上停止。
- 一次回合对应一个请求生命周期；content_filter、超时、传输和 TTS 错误都会进入明确终态。
- Provider 内容过滤不会被绕过，也不会被静默重试。
- Pi 的 compaction 由 Pi 官方会话管理负责，Jarvis 不按固定字数私自截断上下文。
- 本地环境记忆只在 Agent 明确调用工具时记录；不会持续监听屏幕或麦克风。

## 可选能力

扩展在 packages/ 下按能力拆分，默认由 Pi bridge 加载：

- jarvis-voice-control：云端 TTS 音色和待机/唤醒控制。
- jarvis-character-control：角色表达状态和一次性动作。
- jarvis-screen-control：基于 Windows-MCP 的屏幕观察与明确授权操作。
- jarvis-desktop-tools：剪贴板、URL、应用启动、文件定位和本地提醒。
- jarvis-environment-memory：显式记录、查询和遗忘本地环境事实。
- jarvis-subagents：可追踪的独立后台任务能力。它不是主会话的默认执行路径。
- jarvis-netease-music：通过官方 CLI 控制本机网易云播放器，登录态只保存在本机。
- jarvis-youtube-media：公开 YouTube 搜索、播放、元数据和字幕能力。

涉及屏幕、文件、应用、账号或播放控制的能力，请先阅读对应 package 的 README 和授权规则。

## 常用验收

先启动本地服务，再运行与当前环境匹配的检查：

~~~powershell
# bridge、扩展、会话和 supervisor 基础验收
node .\scripts\full-foundation-smoke.mjs

# 实时 WebSocket、文本流、MiMo TTS、打断和后续回合
node .\scripts\realtime-smoke.mjs

# Pi visual_state 合同
node --test .\agent-bridge\visual-state.test.mjs

# supervisor 只读/干运行检查
.\scripts\jarvis-supervisor.ps1 -Mode once -DryRun -Json
~~~

如果只想检查 bridge：

~~~powershell
.\start-bridge.ps1
~~~

## 配置速查

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| XIAOMI_API_KEY | 空 | MiMo API 密钥，必填 |
| MEM0_API_KEY | 空 | Pi bridge 的可选云端长期记忆 |
| JARVIS_MODEL | mimo-v2.5 | Pi 使用的模型 ID |
| JARVIS_ASSISTANT_NAME | 未命名角色 | 运行时显示名称 |
| JARVIS_PORT | 3030 | Pi bridge 端口 |
| MINIMIND_LLM_TIMEOUT_SECONDS | 75 | 实时 LLM 请求上限 |
| MINIMIND_MEMORY_ENABLED | 0 | 本地 realtime embedding，默认关闭 |
| MIMO_TTS_VOICE | 茉莉 | MiMo TTS 音色 |

完整模板见 [.env.example](./.env.example)。

## 已知限制

- 当前优先支持 Windows 10/11，macOS/Linux 尚未作为发布目标验收。
- 模型权重、语音资源、便携 Python runtime 和本地账号登录态不随源码发布。
- React + shadcn renderer 仍是显式预览入口，默认稳定入口是原生 Electron renderer。
- 本地 realtime Mem0 embedding 默认关闭；Pi bridge 的 Mem0 云端记忆是另一条可选能力。
- 使用 MiMo、Mem0、Windows-MCP、网易云或 YouTube 等外部服务时，相关账号、网络、服务条款和费用由使用者负责。
- 当前发布形式是源码 Alpha，尚未提供经过多硬件组合验证的 Windows 安装器。
- 本地支持路径是直接运行 Node.js、Python 和 Electron；仓库内旧的 Docker 文件不代表当前推荐的本地开发方式。

## 贡献方式

欢迎中文社区提交 Issue、改进文档、补充 Windows 设备兼容性记录和贡献扩展。开始前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

特别欢迎：

- 不改变实时协议的 UI/可访问性改进。
- 有实测数据的 ASR、TTS、VAD 和打断性能报告。
- 清晰的 provider 错误复现与日志脱敏样例。
- 新的 Pi 扩展，以及明确的权限边界和失败行为。

## 致谢与许可证

Jarvis 的原创集成代码和项目扩展采用 [MIT License](./LICENSE)。本仓库依赖或配套使用的上游项目不因此改变许可证，具体归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

- [earendil-works/pi](https://github.com/earendil-works/pi)：MIT，Agent toolkit 与 Pi runtime。
- [AVIDS2/Whispera](https://github.com/AVIDS2/Whispera)：Apache-2.0，实时语音运行时。
- [mem0ai/mem0](https://github.com/mem0ai/mem0)：Apache-2.0，可选长期记忆能力。
- [linux.do](https://linux.do/)：中文开源社区交流与反馈来源。

## 发布状态

仓库已经公开，当前公开的 Source Alpha 位于 [feat/full-foundation-baseline](https://github.com/AVIDS2/jarvis/tree/feat/full-foundation-baseline)。默认 main 分支按发布流程暂时保持原样，没有被直接覆盖；审阅通过后再通过 Pull Request 合并。

公开分支已经包含 LICENSE、第三方声明、贡献指南和安全政策。绝不公开 .env、API key、runtime/、账号登录态或本地会话文件。

这是一款正在成长的开源桌面 Agent。它的价值不只在“能回答”，更在于每次聆听、每次打断、每个工具动作和每个上下文都可以被看见、被验证、被继续改进。
