import assert from "node:assert/strict";
import test from "node:test";

// Behavioural test for the bounded long-term-memory write path. The queue lives
// inside bridge.mjs, which starts an HTTP server on import, so this mirrors the
// same contract against a stub Mem0 client. The source-level assertions in
// realtime-turn-contract.test.mjs keep the real implementation aligned.
//
// Mirrored semantics: pending is incremented synchronously at call time (that
// is what makes the cap meaningful for back-to-back calls), writes run
// strictly serially, every failure is contained, and the chain never rejects.

function createSaveQueue(add, { timeoutMs = 10_000, maxPending = 8 } = {}) {
  const state = { pending: 0, dropped: 0, lastError: null, lastSavedAt: null };
  let chain = Promise.resolve();

  function saveMemory() {
    if (state.pending >= maxPending) {
      state.dropped += 1;
      return chain;
    }
    state.pending += 1;
    const task = chain.then(async () => {
      let timer;
      try {
        await Promise.race([
          add(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`did not settle within ${timeoutMs}ms`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
        state.lastError = null;
        state.lastSavedAt = "saved";
      } catch (error) {
        state.lastError = String(error?.message || error);
      } finally {
        clearTimeout(timer);
        state.pending -= 1;
      }
    });
    chain = task;
    return task;
  }

  return { saveMemory, state, settle: () => chain };
}

test("writes are serialized, never concurrent", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  let sequence = 0;
  const { saveMemory, settle } = createSaveQueue(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const id = sequence++;
    order.push(`start${id}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end${id}`);
    inFlight -= 1;
  });

  saveMemory();
  saveMemory();
  saveMemory();
  await settle();

  assert.equal(maxInFlight, 1, "saves must not overlap");
  assert.deepEqual(order, ["start0", "end0", "start1", "end1", "start2", "end2"]);
});

test("a rejecting write is contained and does not poison the queue", async () => {
  const seen = [];
  let call = 0;
  const { saveMemory, state, settle } = createSaveQueue(async () => {
    call += 1;
    seen.push(call);
    if (call === 1) throw new Error("quota exceeded");
  });

  saveMemory();
  saveMemory();
  await settle();

  assert.deepEqual(seen, [1, 2], "the write after a failure must still run");
  assert.equal(state.pending, 0, "pending must drain to zero");
  assert.equal(state.lastError, null, "a later success clears the last error");
});

test("a hung write is bounded by the timeout and unblocks the queue", async () => {
  // A half-open connection that never settles: exactly the case the SDK's
  // missing fetch timeout would leave unbounded.
  const seen = [];
  let call = 0;
  const { saveMemory, state, settle } = createSaveQueue(async () => {
    call += 1;
    seen.push(call);
    if (call === 1) return new Promise(() => {});
    return undefined;
  }, { timeoutMs: 25 });

  // The production timer is unref'd so a best-effort write cannot hold the
  // process open. The bridge's HTTP server keeps the loop alive in production;
  // this test must hold it explicitly for the timer to fire.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await saveMemory();
  } finally {
    clearTimeout(keepAlive);
  }

  assert.match(state.lastError ?? "", /did not settle within 25ms/);
  assert.equal(state.pending, 0, "a timed-out write must release its slot");

  saveMemory();
  await settle();
  assert.equal(call, 2, "the write after a hung one must still run");
  assert.deepEqual(seen, [1, 2]);
});

test("pending writes are dropped past the cap rather than accumulating", async () => {
  let calls = 0;
  const { saveMemory, state, settle } = createSaveQueue(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }, { maxPending: 2 });

  for (let index = 0; index < 5; index += 1) saveMemory();
  await settle();

  assert.equal(calls, 2, "only the capped number of writes run");
  assert.equal(state.dropped, 3, "excess writes are counted as dropped");
  assert.equal(state.pending, 0, "the cap must not leak pending slots");
});

test("the queue never rejects, so a fire-and-forget caller is safe", async () => {
  const { saveMemory, settle } = createSaveQueue(async () => {
    throw new Error("network down");
  });

  // No .catch(): an unhandled rejection here would crash the bridge process.
  saveMemory();
  await assert.doesNotReject(() => settle());
});

test("an error path still releases its slot so later turns are not starved", async () => {
  let call = 0;
  const { saveMemory, state, settle } = createSaveQueue(async () => {
    call += 1;
    if (call === 1) throw new Error("validation failed");
  }, { maxPending: 1 });

  saveMemory();
  await settle();
  saveMemory();
  await settle();

  assert.equal(call, 2, "a released slot must admit the next write");
  assert.equal(state.pending, 0);
  assert.equal(state.dropped, 0, "a drained queue must not drop");
});
