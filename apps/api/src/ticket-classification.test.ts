import { describe, expect, it } from "bun:test";
import type { TicketCategory } from "@helpdesk/shared";
import { ModelError } from "./ai/openrouter.ts";
import type { TicketClassifier } from "./ai/classify-ticket.ts";
import {
  createClassificationWorker,
  QUEUE_OPTIONS,
  SEND_OPTIONS,
  WORK_OPTIONS,
  DEAD_LETTER_QUEUE,
  type ClassificationJob,
  type ClassificationStore,
} from "./ticket-classification.ts";

/**
 * Two things are tested here, and neither of them is pg-boss.
 *
 * The first is the **worker**, which is where every decision that can be wrong
 * lives: refusing to overwrite a human's category, not bumping the queue,
 * telling "nothing to do" apart from "this failed". Each fails silently — a
 * ticket stuck on `pending` forever, a colleague's decision quietly reverted —
 * and each is reachable here only because the SQL sits behind
 * `ClassificationStore`: `bun run test` runs with `DATABASE_URL` stripped, so a
 * worker holding a `Database` would be testable by the parts that do not touch
 * it, which is none of them.
 *
 * The second is the **configuration**. pg-boss's behaviour is pg-boss's
 * business, but which behaviour we asked for is ours, and those options fail as
 * quietly as anything else: the wrong queue policy is a duplicate job on every
 * restart, and an expiry below the model's own deadline is a ticket classified
 * twice with nothing to show it.
 */

const UPDATED_AT = new Date("2026-08-20T09:15:02.456Z");

interface Recorded {
  claimed: string[];
  settled: [string, TicketCategory | null][];
  failed: string[];
  stamps: Date[];
}

function fakeStore(
  options: {
    jobs?: Record<string, ClassificationJob | undefined>;
    onClaim?: (ticketId: string) => void;
  } = {},
): ClassificationStore & { recorded: Recorded } {
  const recorded: Recorded = {
    claimed: [],
    settled: [],
    failed: [],
    stamps: [],
  };

  return {
    recorded,
    claim(ticketId) {
      recorded.claimed.push(ticketId);
      options.onClaim?.(ticketId);
      const job =
        options.jobs && ticketId in options.jobs
          ? options.jobs[ticketId]
          : {
              id: ticketId,
              subject: "Double charged",
              body: "Please refund one of them.",
              updatedAt: UPDATED_AT,
            };
      return Promise.resolve(job);
    },
    settle(job, category) {
      recorded.settled.push([job.id, category]);
      recorded.stamps.push(job.updatedAt);
      return Promise.resolve();
    },
    fail(job) {
      recorded.failed.push(job.id);
      return Promise.resolve();
    },
    pending() {
      return Promise.resolve([]);
    },
  };
}

const answers =
  (...values: (TicketCategory | null | Error)[]): TicketClassifier =>
  () => {
    const value = values.shift();
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? null);
  };

describe("classification worker", () => {
  it("classifies the ticket and records the answer", async () => {
    const store = fakeStore();
    const worker = createClassificationWorker(store, answers("refund_request"));

    await worker.classify("t1");

    expect(store.recorded.settled).toEqual([["t1", "refund_request"]]);
    expect(store.recorded.failed).toEqual([]);
  });

  /**
   * A model that declines has done its job. Recording that as a failure would
   * show the reader "could not be classified" for a ticket the model read and
   * correctly refused to guess about — and would invite a retry that will
   * decline again.
   */
  it("records a decline as an answer, not a failure", async () => {
    const store = fakeStore();
    const worker = createClassificationWorker(store, answers(null));

    await worker.classify("t1");

    expect(store.recorded.settled).toEqual([["t1", null]]);
    expect(store.recorded.failed).toEqual([]);
  });

  /**
   * **The throw is the interface.** It is how a handler tells pg-boss to retry,
   * and the failure that actually happens — a throttled free tier — is the one
   * worth retrying. Swallowing it here would mark a ticket `failed` on its
   * first bad minute and never look at it again, which is exactly what the old
   * in-memory queue had to do.
   *
   * The second assertion is the one that would rot quietly: a handler that both
   * threw *and* marked the ticket failed would look correct, retry three times,
   * and leave the row unable to be settled by any of them.
   */
  it("rethrows a model failure instead of marking the ticket failed", async () => {
    const store = fakeStore();
    const worker = createClassificationWorker(
      store,
      answers(new ModelError("The model is rate-limited right now.")),
    );

    await expect(worker.classify("t1")).rejects.toThrow("rate-limited");

    expect(store.recorded.failed).toEqual([]);
    expect(store.recorded.settled).toEqual([]);
  });

  // The model answered and the write did not land. Retrying costs a second
  // model call and is still the right trade: the alternative is losing the
  // answer with no trace that there ever was one.
  it("rethrows when the write fails", async () => {
    const store = fakeStore();
    store.settle = () => Promise.reject(new Error("connection terminated"));
    const worker = createClassificationWorker(store, answers("technical"));

    await expect(worker.classify("t1")).rejects.toThrow(
      "connection terminated",
    );
  });

  it("rethrows when the claim itself fails", async () => {
    const store = fakeStore({
      onClaim: () => {
        throw new Error("connection terminated");
      },
    });
    const worker = createClassificationWorker(store, answers("technical"));

    await expect(worker.classify("t1")).rejects.toThrow(
      "connection terminated",
    );
  });

  /**
   * The race this feature has to survive: an agent categorises the ticket from
   * the detail page while the job is queued. The store's guard turns the claim
   * into `undefined`, and the model must never be asked — asking would spend a
   * call to produce an answer the guarded UPDATE would then discard.
   *
   * It must **return**, not throw. A throw here would be read by pg-boss as a
   * failure, retried three times, and land the ticket in the dead letter queue
   * to be marked `failed` — over the top of the category a colleague chose.
   */
  it("does nothing, quietly, for a ticket somebody has already decided", async () => {
    const store = fakeStore({ jobs: { t1: undefined } });
    let asked = 0;
    const worker = createClassificationWorker(store, () => {
      asked += 1;
      return Promise.resolve("technical" as const);
    });

    await worker.classify("t1");

    expect(asked).toBe(0);
    expect(store.recorded.settled).toEqual([]);
    expect(store.recorded.failed).toEqual([]);
  });

  /**
   * `updatedAt` is carried through the job and written back unchanged. The
   * column is `$onUpdate` and the queue's default sort is on it, so a
   * classification that restamped it would drag a backlog to the top of
   * everyone's queue — loudest on a reconciliation pass, which can touch every
   * pending ticket at once.
   */
  it("carries the row's own updatedAt into the write", async () => {
    const store = fakeStore();
    const worker = createClassificationWorker(store, answers("technical"));

    await worker.classify("t1");

    expect(store.recorded.stamps).toEqual([UPDATED_AT]);
  });
});

/**
 * The dead letter worker is the *only* thing that writes `failed`, because it
 * is the only place that knows the retries are spent — a pg-boss handler is
 * handed nothing about its own attempt count.
 */
describe("classification dead letter worker", () => {
  it("marks a ticket failed once the retries are spent", async () => {
    const store = fakeStore();
    const worker = createClassificationWorker(store, answers("technical"));

    await worker.bury("t1");

    expect(store.recorded.failed).toEqual(["t1"]);
  });

  // Two minutes of retries is plenty of time for a colleague to categorise the
  // ticket by hand. Stamping `failed` over that would replace a decision with a
  // report of a machine's bad day.
  it("leaves a ticket alone if somebody decided it during the retries", async () => {
    const store = fakeStore({ jobs: { t1: undefined } });
    const worker = createClassificationWorker(store, answers("technical"));

    await worker.bury("t1");

    expect(store.recorded.failed).toEqual([]);
  });

  it("preserves updatedAt when it marks a failure", async () => {
    const store = fakeStore();
    let stamped: Date | undefined;
    store.fail = (job) => {
      stamped = job.updatedAt;
      return Promise.resolve();
    };
    const worker = createClassificationWorker(store, answers("technical"));

    await worker.bury("t1");

    expect(stamped).toEqual(UPDATED_AT);
  });
});

/**
 * Which pg-boss behaviour we asked for. Every one of these is a silent failure
 * if it drifts, and none of them is reachable from a test that does not have a
 * database to run a queue in.
 */
describe("queue configuration", () => {
  /**
   * The dedupe, and the reason it matters more than it looks: `reconcile()`
   * runs at every boot and sends for every ticket the table calls `pending`,
   * which is usually the set that still has live jobs. `short` answers `null`
   * for a key already queued, so that is a no-op. `singleton` — the
   * obvious-looking choice — serialises same-key jobs but still *creates* them,
   * so every restart would double the queue.
   */
  it("dedupes queued jobs by key", () => {
    expect(QUEUE_OPTIONS.policy).toBe("short");
  });

  // Inert without `useListenNotify` on the instance, which is why they are
  // easy to separate and break: dispatch silently falls back to polling.
  it("asks for NOTIFY dispatch", () => {
    expect(QUEUE_OPTIONS.notify).toBe(true);
  });

  it("routes exhausted jobs to the dead letter queue", () => {
    expect(QUEUE_OPTIONS.deadLetter).toBe(DEAD_LETTER_QUEUE);
  });

  // Without retries a throttled free tier is a `failed` ticket on the first bad
  // minute — the exact limitation that made this worth moving off an in-memory
  // queue.
  it("retries with backoff", () => {
    expect(SEND_OPTIONS.retryLimit).toBeGreaterThan(0);
    expect(SEND_OPTIONS.retryBackoff).toBe(true);
    expect(SEND_OPTIONS.retryDelay).toBeGreaterThan(0);
  });

  /**
   * The job's expiry has to clear `ai/openrouter.ts`'s own 60-second deadline,
   * or pg-boss reclaims a job that is still legitimately waiting on a model and
   * runs it a second time — a duplicate model call with nothing anywhere to say
   * it happened.
   */
  it("lets a job outlive the model's deadline", () => {
    expect(SEND_OPTIONS.expireInSeconds).toBeGreaterThan(60);
  });

  /**
   * One model call at a time per process. The thing on the other end is a
   * shared free-tier pool that throttles, and the only burst this sees is a
   * bulk replay, where fanning out turns every request into a 429.
   */
  it("pulls one job at a time", () => {
    expect(WORK_OPTIONS.batchSize).toBe(1);
  });
});
