# 贡献指南

感谢你愿意参与 Jarvis。这个项目最需要的是可复现的真实体验、清晰的边界和能长期维护的改动。

## 开始之前

请先阅读：

- README.md：安装、架构、运行和已知限制。
- THIRD_PARTY_NOTICES.md：上游归属和许可证边界。
- SECURITY.md：密钥和安全问题处理方式。

本地开发不使用 Docker。请把 jarvis、pi 和 whispera 放在同一个父目录，并使用 Windows PowerShell 运行现有脚本。

## 适合提交的改动

- 真实 Windows 设备上的 ASR、TTS、VAD、打断和恢复问题修复。
- 不改变实时协议的 UI、可访问性、键盘操作和 React/shadcn 组件改进。
- 有明确权限边界、失败行为和测试的 Pi 扩展。
- 脱敏后的错误复现、延迟数据、兼容性报告和文档改进。

## 核心边界

- Whispera 负责麦克风、PCM、VAD、ASR、TTS、播放和实时 WebSocket。
- Jarvis bridge 是 Jarvis 对话唯一的 Pi AgentSession 所有者。
- Pi 负责工具调用、会话持久化和官方 compaction。
- UI 不应创建第二个 Agent loop、第二套音频状态机或人为的用户请求队列。
- 不要用关键词过滤、固定文本兜底或删除 ASR 词汇来解决回声问题。
- 任何屏幕、文件、应用或账号动作都必须有清晰的授权和失败处理。

## 提交前检查

根据改动范围运行：

~~~powershell
node --test .\agent-bridge\visual-state.test.mjs
node .\scripts\full-foundation-smoke.mjs
node .\scripts\realtime-smoke.mjs
~~~

涉及配套 Whispera React renderer 时，也请在 ..\whispera\electron-app\renderer-react 运行其构建和 lint，并覆盖桌面与移动尺寸。

提交前确认：

- 没有 .env、API key、cookie、账号文件、runtime/ 或本地会话数据。
- 没有 Docker 生成物、node_modules、.venv、模型权重或日志。
- 没有把密钥放进命令行参数、截图、测试输出或异常信息。
- 新增外部依赖时已记录来源、许可证和必要的安装步骤。

## Issue 和 Pull Request

Issue 请包含：Windows 版本、Node/Python 版本、使用的 UI 模式、复现步骤、脱敏日志和预期结果。不要把完整 API 响应、会话内容、密钥或账号信息贴到公开 Issue。

Pull Request 请说明：改了什么、为什么改、影响哪个边界、如何验证，以及是否存在未覆盖的硬件或服务差异。小而明确的 PR 更容易审阅和回滚。
