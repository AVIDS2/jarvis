const WS_URL = process.env.JARVIS_REALTIME_WS || "ws://127.0.0.1:8111/ws/realtime";
const CAPTURE_RATE = 16_000;
const FRAME_SAMPLES = 1_024;
const TEST_TIMEOUT_MS = 45_000;

class RealtimeClient {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.messages = [];
    this.waiters = [];
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(WS_URL);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket open timed out")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      }, { once: true });
    });
    socket.send(JSON.stringify({ type: "session.start", client: "realtime-smoke", session_id: this.sessionId }));
    await this.waitFor((message) => message.type === "session.ready");
  }

  waitFor(predicate, timeoutMs = TEST_TIMEOUT_MS) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return this.waitForAfter(0, predicate, timeoutMs);
  }

  waitForAfter(messageIndex, predicate, timeoutMs = TEST_TIMEOUT_MS) {
    const existing = this.messages.slice(messageIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: (message) => this.messages.length > messageIndex && predicate(message),
        resolve,
        timeout: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error("Realtime event timed out"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  mark() {
    return this.messages.length;
  }

  sendJson(message) {
    this.socket.send(JSON.stringify(message));
  }

  sendPcm(samples) {
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = sample < 0 ? sample * 32_768 : sample * 32_767;
    }
    this.socket.send(pcm.buffer);
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendJson({ type: "session.stop" });
      this.socket.close();
    }
  }
}

async function waitForStage(client, messageIndex, predicate, stage, timeoutMs = TEST_TIMEOUT_MS) {
  try {
    return await client.waitForAfter(messageIndex, predicate, timeoutMs);
  } catch (error) {
    const recentEvents = client.messages.slice(-20).map((message) => message.type).join(", ");
    throw new Error(`${stage} timed out; recent events: ${recentEvents}`, { cause: error });
  }
}

function decodeAudio(messages) {
  const chunks = messages
    .filter((message) => message.type === "assistant.audio.chunk" && message.data)
    .map((message) => {
      const bytes = Buffer.from(message.data, "base64");
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  const sampleRate = messages.find((message) => message.type === "assistant.audio.chunk")?.sample_rate || 24_000;
  return { samples, sampleRate };
}

function resample(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = sourceIndex - left;
    output[index] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return output;
}

async function feedUtterance(client, speech) {
  const silence = new Float32Array(CAPTURE_RATE);
  const combined = new Float32Array(CAPTURE_RATE / 2 + speech.length + silence.length);
  combined.set(speech, CAPTURE_RATE / 2);
  for (let offset = 0; offset < combined.length; offset += FRAME_SAMPLES) {
    const frame = new Float32Array(FRAME_SAMPLES);
    frame.set(combined.subarray(offset, Math.min(offset + FRAME_SAMPLES, combined.length)));
    client.sendPcm(frame);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const runId = Date.now().toString(36);
const source = new RealtimeClient(`jarvis-smoke-source-${runId}`);
const loopback = new RealtimeClient(`jarvis-smoke-loopback-${runId}`);
const interruption = new RealtimeClient(`jarvis-smoke-interrupt-${runId}`);
const startedAt = performance.now();

try {
  await source.connect();
  source.sendJson({ type: "text.input", text: "请只回答这句话：小爱同学，我在这里。" });
  await source.waitFor((message) => message.type === "assistant.completed");
  const generated = decodeAudio(source.messages);
  if (!generated.samples.length) throw new Error("Source turn returned no TTS audio");

  await loopback.connect();
  const asrStartedAt = performance.now();
  await feedUtterance(loopback, resample(generated.samples, generated.sampleRate, CAPTURE_RATE));
  const transcriptEvent = await loopback.waitFor(
    (message) => message.type === "asr.completed" && Boolean(message.text?.trim()),
  );
  const transcriptAt = performance.now();
  const firstTextEvent = await loopback.waitFor(
    (message) => message.type === "assistant.delta" && Boolean(message.text),
  );
  const firstAudioEvent = await loopback.waitFor(
    (message) => message.type === "assistant.audio.chunk" && Boolean(message.data),
  );
  const completedEvent = await loopback.waitFor((message) => message.type === "assistant.completed");

  await interruption.connect();
  interruption.sendJson({
    type: "text.input",
    text: "请用六个完整句子介绍你自己，每句话都要清楚自然。",
  });
  await interruption.waitFor(
    (message) => message.type === "assistant.audio.chunk" && Boolean(message.data),
  );
  const interruptMark = interruption.mark();
  const interruptStartedAt = performance.now();
  let interruptAckReceivedAt = null;
  const interruptAckPromise = waitForStage(
    interruption,
    interruptMark,
    (message) => message.type === "interrupt.ack" && message.accepted !== false,
    "voice interruption acknowledgement",
  ).then((message) => {
    interruptAckReceivedAt = performance.now();
    return message;
  });
  await feedUtterance(interruption, resample(generated.samples, generated.sampleRate, CAPTURE_RATE));
  const interruptAck = await interruptAckPromise;
  const interruptedTurn = await waitForStage(
    interruption,
    interruptMark,
    (message) => message.type === "assistant.completed" && message.interrupted === true,
    "interrupted assistant completion",
  );
  const followUpTranscript = await waitForStage(
    interruption,
    interruptMark,
    (message) => message.type === "asr.completed" && Boolean(message.text?.trim()),
    "post-interruption ASR",
  );
  const followUpAudio = await waitForStage(
    interruption,
    interruptMark,
    (message) => message.type === "assistant.audio.chunk"
      && message.turn_id === followUpTranscript.turn_id
      && Boolean(message.data),
    "post-interruption TTS",
  );

  console.log(JSON.stringify({
    ok: true,
    transcript: transcriptEvent.text,
    asr_ms: Math.round(transcriptAt - asrStartedAt),
    first_text_received: Boolean(firstTextEvent.text),
    first_audio_samples: firstAudioEvent.num_samples || null,
    assistant_chars: String(completedEvent.text || "").length,
    interrupt_accepted: Boolean(interruptAck.accepted),
    interrupt_ack_ms: Math.round(interruptAckReceivedAt - interruptStartedAt),
    interrupted_turn_id: interruptedTurn.turn_id || null,
    follow_up_transcript: followUpTranscript.text,
    follow_up_audio_samples: followUpAudio.num_samples || null,
    total_ms: Math.round(performance.now() - startedAt),
  }, null, 2));
} finally {
  source.close();
  loopback.close();
  interruption.close();
}
