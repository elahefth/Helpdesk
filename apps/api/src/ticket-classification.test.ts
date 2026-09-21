import { describe, expect, it } from "bun:test";
import type { TicketCategory } from "@helpdesk/shared";
import { ModelError } from "./ai/openrouter.ts";
import type { TicketClassifier } from "./ai/classify-ticket.ts";
import {
  createClassificationQueue,
  type ClassificationJob,
  type ClassificationStore,
} from "./ticket-classification.ts";

/**
 * The queue is the whole of what "non-blocking" means in this feature, and
 * every one of its rules fails silently: a ticket stuck on `pending` forever, a
 * human's category overwritten by a model some seconds after they chose it, a
 * week-old backlog dragged to the top of everyone's queue by a boot sweep. None
 * of those raise anything.
 *
 * They are reachable here at all because the SQL sits behind
 * `ClassificationStore` — `bun run test` runs with `DATABASE_URL` stripped, so
 * a worker that held a `Database` would be testable only by the parts that do
 * not touch it, which is none of them.
 */

const UPDATED_AT = new Date("2026-08-20T09:15:02.456Z");

interface Recorded {
  claimed: string[];
  settled: [string, TicketCategory | null][];
  failed: string[];
  /** What `settle` was handed for `updatedAt` — see the test that reads it. */
  stamps: Date[];
}

/**
 * A store that answers from a map and writes into an array, plus a hook for the
 * two things the real one does that matter: refusing a claim that has gone
 * stale, and throwing.
 */
function fakeStore(
  options: {
    jobs?: Record<string, ClassificationJob | undefined>;
    pending?: string[];
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
      return Promise.resolve(options.pending ?? []);
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

describe("createClassificationQueue", () => {
  /**
   * The contract the ingestion route is built on. `enqueue` is called after a
   * 201 has been written, and if it did anything on the caller's stack — a
   * SELECT, never mind a model call — the endpoint a mail provider is waiting
   * on would be as slow as the model. A provider that times out redelivers,
   * which is how a slow classification becomes a duplicate ticket.
   */
  it("returns from enqueue before touching the store", () => {
    const store = fakeStore();
    const queue = createClassificationQueue(store, answers("refund_request"));

    queue.enqueue("t1");

    expect(store.recorded.claimed).toEqual([]);
  });

  it("classifies the ticket and records the answer", async () => {
    const store = fakeStore();
    const queue = createClassificationQueue(store, answers("refund_request"));

    queue.enqueue("t1");
    await queue.drained();

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
    const queue = createClassificationQueue(store, answers(null));

    queue.enqueue("t1");
    await queue.drained();

    expect(store.recorded.settled).toEqual([["t1", null]]);
    expect(store.recorded.failed).toEqual([]);
  });

  /**
   * The row must stop being `pending` whatever happens, because nothing will
   * look at it again on its own — a ticket that claims to be queued when no
   * queue holds it is the one state a reader cannot act on.
   */
  it("marks a model failure rather than leaving the ticket pending", async () => {
    const store = fakeStore();
    const queue = createClassificationQueue(
      store,
      answers(new ModelError("The model is rate-limited right now.")),
    );

    queue.enqueue("t1");
    await queue.drained();

    expect(store.recorded.failed).toEqual(["t1"]);
    expect(store.recorded.settled).toEqual([]);
  });

  // A bug in this codebase, not the provider's. It is logged louder and the
  // ticket is settled the same way — the row still has to leave `pending`.
  it("marks an unexpected throw the same way", async () => {
    const store = fakeStore();
    const queue = createClassificationQueue(
      store,
      answers(new TypeError("undefined is not a function")),
    );

    queue.enqueue("t1");
    await queue.drained();

    expect(store.recorded.failed).toEqual(["t1"]);
  });

  /**
   * The race this feature has to survive: an agent categorises the ticket from
   * the detail page while the job is queued. The real store's guard turns the
   * claim into `undefined`, and the model must never be asked — asking would
   * spend a call to produce an answer the guarded UPDATE would then discard.
   */
  it("does not classify a ticket somebody has already decided", async () => {
    const store = fakeStore({ jobs: { t1: undefined } });
    let asked = 0;
    const queue = createClassificationQueue(store, () => {
      asked += 1;
      return Promise.resolve("technical" as const);
    });

    queue.enqueue("t1");
    await queue.drained();

    expect(asked).toBe(0);
    expect(store.recorded.settled).toEqual([]);
    expect(store.recorded.failed).toEqual([]);
  });

  /**
   * `updatedAt` is carried through the job and written back unchanged. The
   * column is `$onUpdate` and the queue's default sort is on it, so a
   * classification that restamped it would drag a backlog to the top of
   * everyone's queue — loudest on a boot sweep, which can touch every pending
   * ticket at once.
   */
  it("carries the row's own updatedAt into the write", async () => {
    const store = fakeStore();
    const queue = createClassificationQueue(store, answers("technical"));

    queue.enqueue("t1");
    await queue.drained();

    expect(store.recorded.stamps).toEqual([UPDATED_AT]);
  });

  /**
   * A provider retrying a webhook is the ordinary case — it is why
   * `source_message_id` is unique — and a boot sweep overlapping live ingestion
   * is another. Without the guard the same ticket costs two model calls.
   */
  it("ignores a second enqueue of a ticket already waiting", async () => {
    const store = fakeStore();
    const queue = createClassificationQueue(store, answers("technical"));

    queue.enqueue("t1");
    queue.enqueue("t1");
    await queue.drained();

    expect(store.recorded.claimed).toEqual(["t1"]);
  });

  /**
   * One at a time. The burst this exists for is a bulk replay, where fanning
   * out turns every request into a 429 against a shared free-tier pool and
   * every ticket into `failed`.
   */
  it("runs one classification at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const store = fakeStore();
    const queue = createClassificationQueue(store, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return "technical";
    });

    queue.enqueue("t1");
    queue.enqueue("t2");
    queue.enqueue("t3");
    await queue.drained();

    expect(peak).toBe(1);
    expect(store.recorded.settled).toHaveLength(3);
  });

  /**
   * The in-memory half of the queue dies with the process; the
   * `classification = 'pending'` on the rows does not. This is the one read
   * that turns those rows back into work, and without it a ticket that was
   * mid-flight during a deploy waits for a human forever.
   */
  it("resumes everything a previous process left pending", async () => {
    const store = fakeStore({ pending: ["t1", "t2"] });
    const queue = createClassificationQueue(
      store,
      answers("technical", "refund_request"),
    );

    expect(await queue.resume()).toBe(2);
    await queue.drained();

    expect(store.recorded.settled).toEqual([
      ["t1", "technical"],
      ["t2", "refund_request"],
    ]);
  });

  it("does not re-queue a resumed ticket that is already waiting", async () => {
    const store = fakeStore({ pending: ["t1"] });
    const queue = createClassificationQueue(store, answers("technical"));

    queue.enqueue("t1");
    await queue.resume();
    await queue.drained();

    expect(store.recorded.claimed).toEqual(["t1"]);
  });

  /**
   * A store failure at claim time leaves the row `pending`, which is the truth:
   * nothing was asked of the model, so `failed` would close a job that never
   * started, and the next boot's sweep is what recovers it.
   */
  it("leaves a ticket pending when the claim itself fails", async () => {
    const store = fakeStore({
      onClaim: () => {
        throw new Error("connection terminated");
      },
    });
    const queue = createClassificationQueue(store, answers("technical"));

    queue.enqueue("t1");
    await queue.drained();

    expect(store.recorded.settled).toEqual([]);
    expect(store.recorded.failed).toEqual([]);
  });

  // One bad ticket must not strand the ones behind it.
  it("keeps working after a job fails", async () => {
    const store = fakeStore();
    const queue = createClassificationQueue(
      store,
      answers(new ModelError("nope"), "technical"),
    );

    queue.enqueue("t1");
    queue.enqueue("t2");
    await queue.drained();

    expect(store.recorded.failed).toEqual(["t1"]);
    expect(store.recorded.settled).toEqual([["t2", "technical"]]);
  });
});
