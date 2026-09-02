import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-latency-test-"));
const input = path.join(tempRoot, "turn-timings.jsonl");
const records = [
  { asr_ms: 10, llm_request_to_first_text_ms: 20, speech_end_to_first_audio_ms: 30, interrupt_ack_ms: 40 },
  { asr_ms: 20, llm_request_to_first_text_ms: 30, speech_end_to_first_audio_ms: 40, interrupt_ack_ms: 50 },
  { asr_ms: 30, llm_request_to_first_text_ms: 40, speech_end_to_first_audio_ms: 50, interrupt_ack_ms: 60 },
  { asr_ms: 40, llm_request_to_first_text_ms: 50, speech_end_to_first_audio_ms: 60, interrupt_ack_ms: 70 },
  { asr_ms: 50, llm_request_to_first_text_ms: 60, speech_end_to_first_audio_ms: 70, interrupt_ack_ms: 80 },
];
fs.writeFileSync(input, `${records.map((record) => JSON.stringify(record)).join("\n")}\nmalformed\n`, "utf8");

try {
  const result = spawnSync(process.execPath, [
    path.resolve(process.cwd(), "scripts/latency-benchmark.mjs"),
    "--file",
    input,
    "--json",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.records, 5);
  assert.equal(report.parse_errors, 1);
  assert.deepEqual(report.metrics.asr, { count: 5, p50_ms: 30, p95_ms: 50, max_ms: 50 });
  assert.deepEqual(report.metrics.first_text, { count: 5, p50_ms: 40, p95_ms: 60, max_ms: 60 });
  assert.deepEqual(report.metrics.first_audio, { count: 5, p50_ms: 50, p95_ms: 70, max_ms: 70 });
  assert.deepEqual(report.metrics.interruption, { count: 5, p50_ms: 60, p95_ms: 80, max_ms: 80 });
  console.log("latency benchmark smoke passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
