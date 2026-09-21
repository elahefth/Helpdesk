import { describe, expect, it } from "bun:test";
import { ModelError } from "./ai/openrouter.ts";
import type {
  AutoResolveDecision,
  TicketAutoResolver,
} from "./ai/auto-resolve-ticket.ts";
import {
  AUTO_RESOLVE_DEAD_LETTER_QUEUE,
  AUTO_RESOLVE_QUEUE_OPTIONS,
  AUTO_RESOLVE_SEND_OPTIONS,
  AUTO_RESOLVE_WORK_OPTIONS,
  assistantEmail,
  createAutoResolutionWorker,
  type AutoResolutionJob,
  type AutoResolutionStore,
} from "./ticket-auto-resolution.ts";

/**
 * Two things are tested here, and neither of them is pg-boss.
 *
 * The first is the **worker**, and it carries more than the classifier's does.
 * Both refuse to overwrite a human's decision; only this one can write to a
 * student and close their ticket, so its "do nothing" path is a *write* rather
 * than a return — a ticket left `pending` is a ticket `handledBy=human` hides,
 * which is the one failure in this feature that loses an email outright. That
 * asymmetry is what most of the cases below exist to pin, because it reads like
 * a redundant call and deleting it breaks nothing visible for weeks.
 *
 * The second is the **configuration**. pg-boss's behaviour is pg-boss's
 * business; which behaviour we asked for is ours, and every one of these
 * options fails quietly — the wrong policy is a duplicated queue on every
 * restart, and an expiry under the model's own deadline is two emails to one
 * student with nothing anywhere to say so.
 *
 * All of it is reachable only because the SQL sits behind
 * `AutoResolutionStore`: `bun run test` runs with `DATABASE_URL` stripped.
 */

const TICKET_ID = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

interface Recorded {
  claimed: string[];
  resolved: [string, string][];
  escalated: string[];
  failed: string[];
  skipped: string[];
}

function fakeStore(
  options: { jobs?: Record<string, AutoResolutionJob | undefined> } = {},
): AutoResolutionStore & { recorded: Recorded } {
  const recorded: Recorded = {
    claimed: [],
    resolved: [],
    escalated: [],
    failed: [],
    skipped: [],
  };

  return {
    recorded,
    claim(ticketId) {
      recorded.claimed.push(ticketId);
      const job =
        options.jobs && ticketId in options.jobs
          ? options.jobs[ticketId]
          : {
              id: ticketId,
              subject: "Can I download the videos?",
              body: "I want to watch offline.",
              studentName: "Ada Student",
              studentEmail: "ada.student@example.com",
            };
      return Promise.resolve(job);
    },
    resolve(job, reply) {
      recorded.resolved.push([job.id, reply]);
      return Promise.resolve();
    },
    escalate(job) {
      recorded.escalated.push(job.id);
      return Promise.resolve();
    },
    fail(job) {
      recorded.failed.push(job.id);
      return Promise.resolve();
    },
    skip(ticketId) {
      recorded.skipped.push(ticketId);
      return Promise.resolve();
    },
    pending() {
      return Promise.resolve([]);
    },
  };
}

const decides =
  (...values: (AutoResolveDecision | Error)[]): TicketAutoResolver =>
  () => {
    const value = values.shift();
    if (value instanceof Error) return Promise.reject(value);
    if (!value) return Promise.reject(new Error("no decision configured"));
    return Promise.resolve(value);
  };

const reply = (body: string): AutoResolveDecision => ({ kind: "reply", body });
const escalate: AutoResolveDecision = { kind: "escalate" };

describe("auto-resolution worker", () => {
  it("answers the student and closes the ticket", async () => {
    const store = fakeStore();
    const worker = createAutoResolutionWorker(
      store,
      decides(reply("Hello Ada,\n\nVideos stream online.")),
    );

    await worker.resolve(TICKET_ID);

    expect(store.recorded.resolved).toEqual([
      [TICKET_ID, "Hello Ada,\n\nVideos stream online."],
    ]);
    expect(store.recorded.escalated).toEqual([]);
  });

  /**
   * Escalation is a success, not a failure, and the distinction is the whole
   * design of the prompt next door. Throwing here would spend three retries and
   * then dead-letter the ticket into `failed` — marking a correct decision as a
   * fault, three and a half minutes after it was made.
   */
  it("records a decline as an answer, not a failure", async () => {
    const store = fakeStore();
    const worker = createAutoResolutionWorker(store, decides(escalate));

    await worker.resolve(TICKET_ID);

    expect(store.recorded.escalated).toEqual([TICKET_ID]);
    expect(store.recorded.resolved).toEqual([]);
    expect(store.recorded.failed).toEqual([]);
  });

  // Nothing is written to the student on an escalation. The ticket is an
  // ordinary open ticket and has to read as one.
  it("writes nothing to the student when it declines", async () => {
    const store = fakeStore();
    const worker = createAutoResolutionWorker(store, decides(escalate));

    await worker.resolve(TICKET_ID);

    expect(store.recorded.resolved).toEqual([]);
  });

  /**
   * A thrown handler is how a job asks pg-boss to retry it. Marking the ticket
   * `failed` here instead would give up on the first throttled minute — the
   * exact limitation that made a durable queue worth having — and only the dead
   * letter worker knows when the retries are actually spent.
   */
  it("rethrows a model failure instead of marking the ticket failed", async () => {
    const store = fakeStore();
    const worker = createAutoResolutionWorker(
      store,
      decides(new ModelError("rate limited")),
    );

    expect(worker.resolve(TICKET_ID)).rejects.toThrow("rate limited");
    expect(store.recorded.failed).toEqual([]);
  });

  // A write that did not land is as much a reason to retry as a model that did
  // not answer: the student has not been written to either way.
  it("rethrows when the write fails", async () => {
    const store = fakeStore();
    store.resolve = () => Promise.reject(new Error("connection lost"));
    const worker = createAutoResolutionWorker(store, decides(reply("Hello.")));

    expect(worker.resolve(TICKET_ID)).rejects.toThrow("connection lost");
  });

  /**
   * **The case this feature would otherwise lose a ticket on.**
   *
   * A claim comes back empty whenever a human got there first — the ticket was
   * assigned, resolved, or already replied to. The obvious handler is `return`,
   * and it is wrong: the row is still `pending`, `handledBy=human` hides every
   * `pending` row, and nothing else in the system will ever move it. The
   * student's email would sit in the database, in nobody's queue, indefinitely.
   *
   * So standing down is a write. This is the test that says so.
   */
  it("stands down in writing for a ticket somebody has taken", async () => {
    const store = fakeStore({ jobs: { [TICKET_ID]: undefined } });
    const worker = createAutoResolutionWorker(store, decides(reply("Hello.")));

    await worker.resolve(TICKET_ID);

    expect(store.recorded.skipped).toEqual([TICKET_ID]);
    expect(store.recorded.resolved).toEqual([]);
    expect(store.recorded.escalated).toEqual([]);
  });

  // And it must not be a failure either: a colleague taking a ticket is the
  // system working, and three retries ending in `failed` would report it as a
  // fault over the top of their decision.
  it("does not treat a taken ticket as a failure", async () => {
    const store = fakeStore({ jobs: { [TICKET_ID]: undefined } });
    const worker = createAutoResolutionWorker(store, decides(reply("Hello.")));

    expect(worker.resolve(TICKET_ID)).resolves.toBeUndefined();
    expect(store.recorded.failed).toEqual([]);
  });

  // The model is never asked about a ticket that is no longer the assistant's,
  // which is a cost as well as a correctness point: a claim that fails costs
  // one index probe, and asking anyway would cost a model call per taken ticket.
  it("does not call the model for a ticket it cannot claim", async () => {
    const store = fakeStore({ jobs: { [TICKET_ID]: undefined } });
    let asked = false;
    const worker = createAutoResolutionWorker(store, () => {
      asked = true;
      return Promise.resolve(escalate);
    });

    await worker.resolve(TICKET_ID);

    expect(asked).toBe(false);
  });
});

describe("auto-resolution dead letter worker", () => {
  /**
   * The only thing that ever writes `failed`, because it is the only place that
   * knows the retries are spent — a pg-boss worker is handed no attempt count.
   * The row must stop being `pending` here whatever happens: nothing will look
   * at it again on its own, and `pending` is what hides it from everybody.
   */
  it("marks a ticket failed once the retries are spent", async () => {
    const store = fakeStore();
    const worker = createAutoResolutionWorker(store, decides(escalate));

    await worker.bury(TICKET_ID);

    expect(store.recorded.failed).toEqual([TICKET_ID]);
  });

  // Somebody took it during the three and a half minutes of retries. Stamping
  // `failed` over that would report their ticket as a fault; standing down says
  // the true thing, and — the part that matters — still clears `pending`.
  it("stands down rather than failing a ticket somebody took", async () => {
    const store = fakeStore({ jobs: { [TICKET_ID]: undefined } });
    const worker = createAutoResolutionWorker(store, decides(escalate));

    await worker.bury(TICKET_ID);

    expect(store.recorded.failed).toEqual([]);
    expect(store.recorded.skipped).toEqual([TICKET_ID]);
  });
});

/**
 * The assistant's address. Namespaced because `user.email` is UNIQUE and a
 * soft-deleted row keeps its address, so a bare `assistant@…` would reserve one
 * a real person might need and answer the resulting 409 by blaming a deleted
 * user nobody can find.
 */
describe("assistantEmail", () => {
  it("namespaces the address under the support mailbox", () => {
    expect(assistantEmail("support@helpdesk.test")).toBe(
      "assistant.support@helpdesk.test",
    );
  });
});

/**
 * Which pg-boss behaviour we asked for. None of it is reachable from a test
 * without a database to run a queue in, and all of it fails silently.
 */
describe("auto-resolution queue configuration", () => {
  /**
   * The dedupe. `reconcile()` sends for every ticket the table calls `pending`
   * at every boot — usually the set that still has live jobs — so without
   * `short` answering `null` for a key already queued, each restart would
   * double the queue. `singleton` is the trap: it serialises same-key jobs but
   * still creates them.
   */
  it("dedupes queued jobs by key", () => {
    expect(AUTO_RESOLVE_QUEUE_OPTIONS.policy).toBe("short");
  });

  // Inert without `useListenNotify` on the instance, which is what makes the
  // pair easy to separate and break: dispatch falls back to polling in silence.
  it("asks for NOTIFY dispatch", () => {
    expect(AUTO_RESOLVE_QUEUE_OPTIONS.notify).toBe(true);
  });

  /**
   * Its own dead letter queue, not the classifier's. Sharing one would send
   * auto-resolution failures to a worker that marks tickets `failed` in the
   * *classification* column — a feature reporting the other's fault, in the
   * wrong place, with the ticket left `pending` and therefore hidden.
   */
  it("routes exhausted jobs to its own dead letter queue", () => {
    expect(AUTO_RESOLVE_QUEUE_OPTIONS.deadLetter).toBe(
      AUTO_RESOLVE_DEAD_LETTER_QUEUE,
    );
  });

  // A throttled free tier is the failure that actually happens, and the honest
  // answer to it is "ask again shortly" rather than a ticket marked failed.
  it("retries with backoff", () => {
    expect(AUTO_RESOLVE_SEND_OPTIONS.retryLimit).toBeGreaterThan(0);
    expect(AUTO_RESOLVE_SEND_OPTIONS.retryBackoff).toBe(true);
    expect(AUTO_RESOLVE_SEND_OPTIONS.retryDelay).toBeGreaterThan(0);
  });

  /**
   * The expiry has to clear `ai/openrouter.ts`'s 60-second deadline, or pg-boss
   * reclaims a job still legitimately waiting on a model and runs it again —
   * which here means **two emails to one student**, rather than the duplicate
   * model call it means next door.
   */
  it("lets a job outlive the model's deadline", () => {
    expect(AUTO_RESOLVE_SEND_OPTIONS.expireInSeconds).toBeGreaterThan(60);
  });

  it("pulls one job at a time", () => {
    expect(AUTO_RESOLVE_WORK_OPTIONS.batchSize).toBe(1);
  });
});
