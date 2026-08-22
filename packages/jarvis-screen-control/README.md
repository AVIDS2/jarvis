# Jarvis Screen Control

This is an external Pi package for Windows screen observation and computer use.
It does not modify Pi's agent loop or Whispera's realtime audio path.

The package starts [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) on
first use through a stdio JSON-RPC sidecar. The default command is:

```text
uvx --python 3.14 --from windows-mcp==0.8.5 windows-mcp serve
```

Pi receives three tools:

- `screen_snapshot`: fast screenshot image for MiMo.
- `screen_state`: screenshot plus Windows UI Automation state.
- `screen_action`: click, type, scroll, move, shortcut, wait, or app action;
  it returns a fresh screenshot by default for verification.

Override the sidecar without changing the extension:

```powershell
$env:JARVIS_WINDOWS_MCP_COMMAND = "uvx"
$env:JARVIS_WINDOWS_MCP_ARGS_JSON = '["--python","3.14","--from","windows-mcp==0.8.5","windows-mcp","serve"]'
```

The sidecar uses an isolated uv Python 3.14 environment. It does not replace
Jarvis's Python 3.11 voice runtime. Set `ANONYMIZED_TELEMETRY=false` and
`WINDOWS_MCP_WATCHDOG=off` for the Jarvis default behavior.
