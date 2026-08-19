# Real-time Voice Agent

一个基于实时语音交互的开源智能体，不仅能对话，还能执行任务。

## 功能特点

- **实时语音交互**：支持语音转文字、文字转语音
- **智能对话**：基于MiMo大模型，自然流畅的对话体验
- **任务执行**：可以执行各种计算机操作任务
- **记忆功能**：支持长期记忆，记住用户的偏好和习惯

## 快速开始

### Windows 桌面运行

```powershell
# 默认：Whispera 原生 Electron 语音界面 + Pi Agent 层
.\run.ps1
.\run.ps1 -Ui legacy

# 实验：pi-web 界面，不作为默认语音宿主
.\run.ps1 -Ui web
```

桌面快捷方式 `Jarvis 实时语音助手` 和 `Jarvis 原生语音 UI` 均启动原生界面。`Jarvis Web UI（实验）` 才启动 pi-web。两种界面复用同一套 Whispera 后端、Pi AgentSession 和持久上下文，不要同时启动两个麦克风客户端。

Electron 使用单实例锁；重复点击快捷方式只会唤起现有窗口，不会再启动第二个麦克风客户端。

当前本地唤醒声学模型仍是 `Hey Jarvis`。`小爱同学` 可以作为运行时助手名称，但尚未训练成中文唤醒模型，不能通过修改显示文本获得该能力。

### 实时链路验收

```powershell
node .\scripts\realtime-smoke.mjs
node .\scripts\music-tool-smoke.mjs
```

第一项验证无 Web 情况下的 ASR、Pi 文本流、MiMo TTS、打断和打断后续话；第二项验证网易云扩展与官方 CLI 错误协议。测试使用隔离会话并在结束后删除测试会话。

### 环境要求

- Docker 和 Docker Compose
- 小米MiMo API密钥

### 部署步骤

1. 克隆项目
```bash
git clone https://github.com/your-username/jarvis.git
cd jarvis
```

2. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 文件，填入你的 API 密钥
```

3. 启动服务
```bash
docker-compose up -d
```

4. 访问服务
- 主服务：http://localhost
- API接口：http://localhost/v1/chat/completions

## 技术架构

- **Jarvis**：基于Pi的AgentSession，作为对话和agent运行时
- **Whispera**：实时语音处理，包含VAD、ASR、TTS
- **Agent Bridge**：连接Whispera和Jarvis的桥梁
- **MiMo API**：提供强大的大模型能力
- **本地处理**：降噪、VAD等轻量级处理在本地运行，不消耗云端资源

## 配置说明

### 环境变量

- `XIAOMI_API_KEY`：小米MiMo API密钥
- `MEM0_API_KEY`：Mem0记忆服务API密钥（可选）
- `JARVIS_MODEL`：使用的模型名称，默认为mimo-v2.5
- `JARVIS_PORT`：服务端口，默认为3030

### 语音配置

- `ASR_MODE`：语音识别模式，支持cloud（云端）和local（本地）
- `TTS_MODE`：语音合成模式，支持cloud（云端）和local（本地）

## 开发计划

### 短期目标
- 完善云端贾维斯功能
- 优化语音交互体验
- 让对话更自然、更像真人

### 中期目标
- 添加视频交互功能
- 实现多模态理解
- 增强任务执行能力

### 长期愿景
- 考虑本地部署方案
- 搭建小型服务器集群
- 实现真正的贾维斯体验

## 贡献欢迎

欢迎贡献代码、报告问题或提出建议！

## 许可证

MIT License
