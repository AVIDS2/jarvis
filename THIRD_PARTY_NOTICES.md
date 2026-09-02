# Third-Party Notices

Jarvis is an integration project. The MIT license in LICENSE applies to
original Jarvis code and project extensions in this repository; it does not
relicense upstream projects, npm packages, model weights, or external
services.

| Component | Role | License / terms | Source |
| --- | --- | --- | --- |
| Jarvis original code | Bridge, launcher, project extensions | MIT | This repository |
| Pi | AgentSession, Pi AI, coding-agent runtime | MIT | https://github.com/earendil-works/pi |
| Whispera | Realtime microphone, VAD, ASR, TTS and Electron runtime | Apache-2.0 | https://github.com/AVIDS2/Whispera |
| mem0 / mem0ai | Optional long-term memory integration | Apache-2.0 and package terms | https://github.com/mem0ai/mem0 |
| Kiranism dashboard starter | React/shadcn preview source used by the paired renderer | MIT | https://github.com/Kiranism/next-shadcn-dashboard-starter |
| shadcn/ui and Base UI packages | UI primitives used by the paired renderer | Follow each package and copied source notice | https://ui.shadcn.com/ |
| MiMo API | Optional external model, ASR and TTS service | Xiaomi/MiMo service terms | https://mimo.mi.com/docs/en-US/api/chat/openai-api |
| Windows-MCP | Optional screen capability provider | Follow its upstream license and terms | https://github.com/520mianMian/windows-mcp |
| @music163/ncm-cli | Optional local NetEase Cloud Music control | Follow the package and NetEase service terms | https://developer.music.163.com/st/developer/document?docId=2327e302009c437eb02af48f63d6e514 |

## Dependency licenses

The agent-bridge/package-lock.json records package metadata for the npm
dependency tree. When redistributing a packaged application, preserve the
required notices from all bundled dependencies and consult their current
license files. Do not assume that the repository-level MIT notice changes the
license of a dependency.

## Models and service accounts

Model weights, voice assets, API keys, account credentials, and runtime data
are not part of the source release. Each model or service has its own usage
and redistribution terms. Do not commit downloaded weights, .env files,
browser cookies, music credentials, or local Pi session data.
