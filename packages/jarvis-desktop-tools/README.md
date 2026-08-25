# Jarvis desktop tools

An external Pi package for bounded Windows actions and local reminders. It does not expose an arbitrary shell tool.

## Tool

`desktop_tools` supports:

- `clipboard_read` and `clipboard_write`
- `open_url` through the default browser (HTTP/HTTPS only)
- `open_app` through `Start-Process` with a target and bounded argument list
- `file_reveal` through Explorer, requiring an existing path
- `reminder_add`, `reminder_list`, and `reminder_complete`

PowerShell commands are passed as encoded scripts and values are quoted as literals. Inputs have size, control-character, URL, path, and argument validation. No free-form shell command or background polling is provided.

## Configuration

- `JARVIS_POWERSHELL_PATH`: optional PowerShell executable path.
- `JARVIS_DESKTOP_COMMAND_TIMEOUT_MS`: command timeout, default 10 seconds, bounded to 1-30 seconds.
- `JARVIS_REMINDERS_PATH`: reminder JSON path; defaults to `runtime/desktop-tools/reminders.json` relative to the Pi working directory.

Reminder storage is a local JSON array. This package records reminder state but does not run a notification scheduler or claim that a reminder was delivered.
