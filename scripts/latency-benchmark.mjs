#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_FILE = path.resolve(process.cwd(), "runtime/diagnostics/turn-timings.jsonl");
const INTERRUPTION_KEYS = [
  "interrupt_ms",
  "interruption_ms",
  "interrupt_ack_ms",
  "interruption_ack_ms",
  "interruption_acknowledged_ms",
  "barge_in_ms",
  "barge_in_ack_ms",
  "barge_in_latency_ms",
  "speech_interrupt_ms",
  "assistant_interrupt_ms",
  "tts_interrupt_ms",
  "playback_stop_ms",
];

function parseArgs(argv) {
  const result = { file: DEFAULT_FILE, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      result.json = true;
    } else if (arg === "--file") {
      result.file = path.resolve(argv[++index] ?? "");
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

function summarize(values) {
  if (!values.length) return { count: 0, p50_ms: null, p95_ms: null, max_ms: null };
  return {
    count: values.length,
    p50_ms: Number(percentile(values, 0.5).toFixed(2)),
    p95_ms: Number(percentile(values, 0.95).toFixed(2)),
    max_ms: Number(Math.max(...values).toFixed(2)),
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstMetric(record, keys) {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function collect(records, keys) {
  return records.map((record) => firstMetric(record, keys)).filter((value) => value !== null);
}

function buildReport(file, records, parseErrors) {
  const asr = collect(records, ["asr_ms", "asr_duration_ms", "speech_to_asr_done_ms"]);
  const firstText = collect(records, [
    "speech_end_to_first_text_ms",
    "llm_request_to_first_text_ms",
    "first_text_ms",
    "first_token_ms",
  ]);
  const firstAudio = collect(records, [
    "speech_end_to_first_audio_ms",
    "total_to_first_audio_ms",
    "first_audio_ms",
    "tts_request_to_first_audio_ms",
  ]);
  const interruption = collect(records, INTERRUPTION_KEYS);
  return {
    ok: true,
    file,
    records: records.length,
    parse_errors: parseErrors,
    metrics: {
      asr: summarize(asr),
      first_text: summarize(firstText),
      first_audio: summarize(firstAudio),
      interruption: summarize(interruption),
    },
    notes: interruption.length
      ? []
      : ["日志中没有明确的打断延迟字段；未将 speech_end_to_turn_start_ms 当作打断指标。"],
  };
}

function printHuman(report) {
  console.log(`文件: ${report.file}`);
  console.log(`记录: ${report.records}，解析错误: ${report.parse_errors}`);
  for (const [name, metric] of Object.entries(report.metrics)) {
    const label = {
      asr: "ASR",
      first_text: "首字",
      first_audio: "首音频",
      interruption: "打断",
    }[name];
    if (!metric.count) {
      console.log(`${label}: 无样本`);
      continue;
    }
    console.log(`${label}: P50 ${metric.p50_ms} ms | P95 ${metric.p95_ms} ms | 最大 ${metric.max_ms} ms | n=${metric.count}`);
  }
  for (const note of report.notes) console.log(`说明: ${note}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/latency-benchmark.mjs [--json] [--file path]");
  process.exit(0);
}
if (!fs.existsSync(args.file)) {
  const report = {
    ok: false,
    file: args.file,
    error: "timing log does not exist",
    metrics: {},
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.error(`找不到延迟日志: ${args.file}`);
  process.exit(2);
}

const records = [];
let parseErrors = 0;
for (const line of fs.readFileSync(args.file, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const record = JSON.parse(line);
    if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    else parseErrors += 1;
  } catch {
    parseErrors += 1;
  }
}
const report = buildReport(args.file, records, parseErrors);
if (args.json) console.log(JSON.stringify(report, null, 2));
else printHuman(report);
