# Security Policy

## 不要公开提交密钥

请不要把以下内容提交到 Git、Issue、截图或日志：

- XIAOMI_API_KEY、MEM0_API_KEY 或其他 provider key。
- 浏览器 cookie、网易云登录态、Windows-MCP 凭据。
- Pi session 文件、runtime 数据、录音和包含个人信息的截图。

本地密钥应写入被 Git 忽略的 .env。如果密钥曾经进入 Git 历史或公开聊天，请立即在对应服务控制台撤销并重新生成。

## 报告漏洞

仓库公开后，优先使用 GitHub 的 Security Advisories / Report a vulnerability 私下报告。不要在公开 Issue 中发布可直接利用的细节。

报告请包含：

- 受影响的文件、版本或提交。
- 最小复现步骤和影响范围。
- 脱敏后的日志或截图。
- 你建议的修复方向（如果有）。

Jarvis 是本地桌面集成项目，外部 provider、Pi、Whispera、Mem0、Windows-MCP 和第三方 CLI 的安全问题应同时向对应上游报告。不要把上游凭据或个人数据转发到本项目的公开渠道。

## 默认安全边界

- API key 不通过 UI 暴露，也不放入进程命令行参数。
- 本地服务默认绑定 loopback 地址。
- 本地 realtime embedding 默认关闭，避免缺少依赖时阻塞语音链路。
- 屏幕和桌面扩展对危险动作要求明确授权，并应返回动作后状态。
- 音频反馈应在 VAD/ASR 之前处理，不通过词汇过滤伪造转录结果。
