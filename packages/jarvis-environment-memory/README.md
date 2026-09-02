# Jarvis environment memory

An external Pi package for explicit, local-first environment facts. It is deliberately event-driven: nothing is captured unless the Agent explicitly calls `environment_memory` with a `record` action.

## Tool

`environment_memory` supports `record`, `recent`, `search`, `forget`, and `status`.

Records are JSONL and contain an id, timestamp, `source: "explicit_tool"`, summary, optional app/window/tags, and an optional screenshot reference. Screenshot bytes, microphone input, continuous screen polling, and keyword matching are not part of this package.

## Configuration

Defaults to `runtime/environment-memory/events.jsonl` relative to the Pi working directory.

- `JARVIS_ENVIRONMENT_MEMORY_PATH`: absolute or working-directory-relative JSONL path.
- `JARVIS_ENVIRONMENT_MEMORY_RETENTION_DAYS`: retention window, default 30 days, bounded to 1-3650 days.

The store keeps at most 2,000 records and writes local files with owner-only permissions where the platform supports them.
