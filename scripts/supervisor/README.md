# Jarvis Runtime Supervisor

`jarvis-supervisor.ps1` is a small Windows-only watchdog for the two local
runtime services. It only probes `127.0.0.1:3030/health` (Agent bridge) and
`127.0.0.1:8111/health` (Whispera realtime voice), and the only command it can
start is the project-local `launch-legacy-hidden.vbs`.

```powershell
# Inspect without acquiring the supervisor lock.
.\scripts\jarvis-supervisor.ps1 -Mode status

# Check once and start the existing native launcher if either service is down.
.\scripts\jarvis-supervisor.ps1 -Mode once

# Keep the watchdog alive. Ctrl+C stops only the watchdog; it does not kill
# Jarvis or any other process.
.\scripts\jarvis-supervisor.ps1 -Mode watch

# Safe test mode: probes health and records what would happen, but never starts.
.\scripts\jarvis-supervisor.ps1 -Mode once -DryRun -Json
```

The `watch`/`once` modes use a named Windows mutex plus a PID/start-time lock
record under `runtime/diagnostics`. A second supervisor exits; it never kills a
PID, closes a port, or scans unrelated services. Failed launch/readiness checks
use persisted exponential backoff (2, 4, 8 ... 60 seconds by default).

Supervisor events are JSONL at `runtime/diagnostics/supervisor.jsonl`; the
state file is `runtime/diagnostics/supervisor-state.json`. Health logs contain
only local endpoint status and bounded metadata, not response bodies or keys.

The latency report is independent:

```powershell
node .\scripts\latency-benchmark.mjs
node .\scripts\latency-benchmark.mjs --json
node .\scripts\latency-benchmark.mjs --file .\runtime\diagnostics\turn-timings.jsonl --json
```

It reports P50/P95/max for ASR, first text, first audio, and explicitly named
interruption fields. If the log has no interruption field, it reports no sample
instead of guessing from an unrelated timing field.

Run the pure PowerShell smoke test while the local services are running:

```powershell
.\scripts\supervisor\supervisor.test.ps1

Run the complete foundation acceptance (health, extensions, session CRUD/rebase,
task API, and supervisor status):

```powershell
node .\scripts\full-foundation-smoke.mjs
```
```
