import { describe, expect, it } from "bun:test";
import { APICallError, RetryError } from "ai";
import {
  buildPolishPrompt,
  INSTRUCTIONS,
  describeProviderFailure,
  modelBatches,
  unwrapModelReply,
  type PolishContext,
} from "./polish-reply.ts";

/** Whoever is signed in and pressing Polish. */
const AGENT = "Cass Agent";

function ticket(overrides: Partial<PolishContext> = {}): PolishContext {
  return {
    subject: "Double charged for the lab fee",
    studentName: "Ada Student",
    studentEmail: "ada@example.edu",
    body: "I paid the lab fee twice on Monday. Can you refund one of them?",
    category: "refund_request",
    status: "open",
    ...overrides,
  };
}

/**
 * The prompt is the only thing standing between "expand this" and "answer
 * this", and every way it goes wrong is quiet: a missing block reads as a
 * fluent, confident reply that invented its facts.
 */
describe("buildPolishPrompt", () => {
  it("carries the draft and the ticket the draft answers", () => {
    const prompt = buildPolishPrompt("we cant refund sorry", ticket(), AGENT);

    expect(prompt).toContain("we cant refund sorry");
    expect(prompt).toContain("Double charged for the lab fee");
    expect(prompt).toContain("I paid the lab fee twice");
  });

  /**
   * Both are wrapped in labelled blocks, with the instructions outside them.
   * Not a security boundary — a student who writes "ignore the above" is data
   * inside a block, and the real guard is that an agent reads the result — but
   * losing the delimiters is what turns their email into prompt text.
   */
  it("fences the ticket and the draft in separate blocks", () => {
    const prompt = buildPolishPrompt("draft text", ticket(), AGENT);

    expect(prompt).toContain("<ticket>");
    expect(prompt).toContain("</ticket>");
    expect(prompt).toContain("<draft>\ndraft text\n</draft>");
  });

  /** Says so in as many words, because the ticket is the tempting place to crib from. */
  it("tells the model the ticket is context and not a source of facts", () => {
    expect(buildPolishPrompt("draft", ticket(), AGENT)).toMatch(
      /context only — never a source of new facts/,
    );
  });

  /**
   * The same fallback every renderer here uses. A name is a display name, and
   * mail from a bare address has none — a prompt that read "From: null" would
   * be a model's invitation to address the student as "null".
   */
  it("names the sender, falling back to the address", () => {
    expect(buildPolishPrompt("d", ticket(), AGENT)).toContain(
      "From: Ada Student <ada@example.edu>",
    );
    expect(buildPolishPrompt("d", ticket({ studentName: null }), AGENT)).toContain(
      "From: ada@example.edu",
    );
  });

  /** Nothing classifies, so most tickets reach this with a null category. */
  it("spells a null category out rather than leaving it blank", () => {
    const prompt = buildPolishPrompt("d", ticket({ category: null }), AGENT);
    expect(prompt).toContain("Category: Unclassified");
    expect(prompt).not.toContain("Category: null");
  });

  it("uses the reader-facing category label, not the enum value", () => {
    expect(buildPolishPrompt("d", ticket(), AGENT)).toContain(
      "Category: Refund Request",
    );
  });

  /**
   * The sign-off's name, and the reason this function takes a third argument.
   * A model asked to close a reply warmly and given nobody to close it as will
   * supply someone — a department that does not exist, or the student's own
   * name read back off the ticket.
   */
  it("names the agent the reply is signed by", () => {
    const prompt = buildPolishPrompt("d", ticket(), AGENT);
    expect(prompt).toContain("You are writing as Cass Agent");
    expect(prompt).toMatch(/[Ss]ign off with that name/);
  });

  /**
   * Outside the fenced blocks, unlike the ticket and the draft: it came from
   * the session rather than from a stranger's email, and it is an instruction
   * about who is writing rather than material to rewrite. Inside `<ticket>` it
   * would read as something the student said about themselves.
   */
  it("keeps the agent out of the blocks holding untrusted text", () => {
    const prompt = buildPolishPrompt("d", ticket(), AGENT);
    const fenced = prompt.slice(prompt.indexOf("<ticket>"));
    expect(fenced).not.toContain(AGENT);
  });
});

/**
 * What the instructions ask for, pinned because the failure is a button that
 * works and disappoints: this file shipped once as a copy editor that turned
 * `fixed` into `Fixed.`, which is not a bug in any single line — it is every
 * line agreeing to the wrong job.
 */
describe("the instructions", () => {
  // Reachable only through the prompt, which is the only place they are joined
  // to anything: `buildPolishPrompt` carries the context, `INSTRUCTIONS` the
  // task, and the SDK puts them in the same request.
  const asked = (draft: string) => buildPolishPrompt(draft, ticket(), AGENT);

  /**
   * The draft is a note about *what* to say. Read as a note about *how much*
   * to write, a two-word draft comes back as a two-word reply — which is
   * exactly what the first version of this prompt did.
   */
  it("tells the model a short draft is not a short reply", () => {
    expect(INSTRUCTIONS).toMatch(/not a limit on how much to write/);
    expect(INSTRUCTIONS).toMatch(/complete, courteous sentences/);
  });

  /** The greeting and the sign-off, now wanted where they were once forbidden. */
  it("asks for the parts that make it an email rather than a note", () => {
    expect(INSTRUCTIONS).toMatch(/greeting the student/i);
    expect(INSTRUCTIONS).toMatch(/sign off with the agent's name/i);
  });

  /**
   * The rule that survived the change of job, and the one that matters: a
   * fluent reply inventing a refund window is the failure an agent skimming a
   * rewrite of their own words will not catch.
   */
  it("keeps the draft as the only source of facts", () => {
    expect(INSTRUCTIONS).toMatch(/only source of facts/);
    expect(INSTRUCTIONS).toMatch(
      /no policies, deadlines, timeframes, amounts, links, ticket numbers, or promises/i,
    );
    expect(INSTRUCTIONS).toMatch(/Do not answer the student yourself/);
  });

  /**
   * Expanding a draft means writing sentences the agent did not, so the one
   * thing that must not expand with it is the cast: two names are supplied and
   * a third would be invented.
   */
  it("forbids inventing a name for anyone", () => {
    expect(INSTRUCTIONS).toMatch(/Invent no others/);
    expect(INSTRUCTIONS).toMatch(/never guess a name from an email address/);
  });

  /** It goes straight into the agent's textarea, so anything else is litter. */
  it("asks for the reply and nothing around it", () => {
    expect(INSTRUCTIONS).toMatch(
      /no subject line, no preamble, no explanation/,
    );
    expect(asked("d")).not.toMatch(/```/);
  });
});

/**
 * What a small instruction-tuned model does with "reply with the text and
 * nothing else". Each of these lands in the agent's box, so a missed case is a
 * stray code fence in something about to be sent to a student.
 */
describe("unwrapModelReply", () => {
  it("leaves an ordinary answer alone", () => {
    expect(unwrapModelReply("Hi Ada,\n\nWe have issued the refund.")).toBe(
      "Hi Ada,\n\nWe have issued the refund.",
    );
  });

  it("trims the whitespace around it", () => {
    expect(unwrapModelReply("\n\n  Thanks for writing in.  \n")).toBe(
      "Thanks for writing in.",
    );
  });

  it.each([
    ["a bare fence", "```\nThanks for writing in.\n```"],
    ["a tagged fence", "```text\nThanks for writing in.\n```"],
    ["a fence with padding around it", "\n```\nThanks for writing in.\n```\n"],
  ])("unwraps %s", (_label, text) => {
    expect(unwrapModelReply(text)).toBe("Thanks for writing in.");
  });

  it("unwraps the prompt's own draft tags echoed back", () => {
    expect(unwrapModelReply("<draft>\nThanks for writing in.\n</draft>")).toBe(
      "Thanks for writing in.",
    );
  });

  /**
   * A fence in the *middle* is content — an agent pasting a command or a config
   * snippet into a reply is ordinary — and only a fence wrapping the whole
   * answer is the model's packaging.
   */
  it("keeps a fenced block that is part of the reply", () => {
    const reply = "Run this:\n\n```\nbun run dev\n```\n\nThen try again.";
    expect(unwrapModelReply(reply)).toBe(reply);
  });

  /**
   * Deliberately not stripped: there is no telling this line from a first
   * sentence the agent wrote, and deleting a real one is the worse mistake.
   */
  it("leaves a preamble line for the agent to remove", () => {
    const text = "Here is the improved reply:\n\nThanks for writing in.";
    expect(unwrapModelReply(text)).toBe(text);
  });

  it("reports an answer of nothing as empty rather than guessing", () => {
    expect(unwrapModelReply("   \n  ")).toBe("");
    expect(unwrapModelReply("```\n\n```")).toBe("");
  });
});

/**
 * What the agent is told when the provider fails.
 *
 * These messages are rendered verbatim under the reply box, and each one exists
 * to point at a different next move — press the button again, or go and find
 * whoever holds the API key. Collapsing them is not a cosmetic loss: it sends
 * an agent hunting a network problem while a free tier is merely busy.
 */
describe("describeProviderFailure", () => {
  const apiError = (statusCode: number) =>
    new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
    });

  /**
   * The shape a real failure arrives in: `generateText` spends its retries and
   * hands back a `RetryError` with the provider's own error underneath. Reading
   * the outer error alone finds no status and reports everything as generic,
   * which is the regression this pins.
   */
  const afterRetries = (statusCode: number) =>
    new RetryError({
      message: "Failed after 2 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(statusCode), apiError(statusCode)],
    });

  it("names a rate limit as one, and says to try again", () => {
    expect(describeProviderFailure(afterRetries(429))).toMatch(
      /rate-limited right now/,
    );
  });

  it.each([401, 403])(
    "points a %s at the credentials rather than at the agent",
    (status) => {
      expect(describeProviderFailure(afterRetries(status))).toMatch(
        /OPENROUTER_API_KEY/,
      );
    },
  );

  it("points a 404 at the configured model id", () => {
    expect(describeProviderFailure(afterRetries(404))).toMatch(
      /OPENROUTER_MODEL/,
    );
  });

  it("reads the status through the retry wrapper, not just off the top", () => {
    // The same status unwrapped must produce the same message, or only one of
    // the two paths is actually carrying the provider's answer.
    expect(describeProviderFailure(apiError(429))).toBe(
      describeProviderFailure(afterRetries(429)),
    );
  });

  /** Our own 30s abort, which is a different fact than the provider refusing. */
  it("tells a timeout apart from a refusal", () => {
    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    expect(describeProviderFailure(timeout)).toMatch(/took too long/);
  });

  it.each([
    ["an unmapped status", afterRetries(500)],
    ["something that is not an API error at all", new Error("socket hang up")],
  ])("falls back to the generic message for %s", (_label, error) => {
    expect(describeProviderFailure(error)).toBe(
      "The model could not be reached. Please try again.",
    );
  });
});

/**
 * OpenRouter accepts at most three ids in one `models` array and rejects a
 * fourth outright — so a chain longer than three has to be walked in groups
 * rather than sent whole.
 *
 * Worth pinning precisely because the failure has no partial form: a batch of
 * four does not fall back badly, it fails *every* request, and the provider
 * reports it as a generic call error. The symptom is a Polish button that has
 * never worked, on a `.env` line that reads perfectly well.
 */
describe("modelBatches", () => {
  it("sends one model as a batch of one, with no fallbacks", () => {
    expect(modelBatches(["a/one"])).toEqual([["a/one"]]);
  });

  it("keeps a chain of three in a single request", () => {
    expect(modelBatches(["a/one", "b/two", "c/three"])).toEqual([
      ["a/one", "b/two", "c/three"],
    ]);
  });

  /** Four is the case that motivated this: it must become two requests. */
  it("splits a fourth model into a second request", () => {
    expect(modelBatches(["a/one", "b/two", "c/three", "d/four"])).toEqual([
      ["a/one", "b/two", "c/three"],
      ["d/four"],
    ]);
  });

  it("splits five the same way", () => {
    expect(
      modelBatches(["a/one", "b/two", "c/three", "d/four", "e/five"]),
    ).toEqual([
      ["a/one", "b/two", "c/three"],
      ["d/four", "e/five"],
    ]);
  });

  /**
   * The preference order is the whole point of the chain: the primary must
   * stay first and nothing may be dropped or repeated on the way into batches.
   */
  it("preserves the order and loses nothing", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}/m${i}`);
    expect(modelBatches(ids).flat()).toEqual(ids);
  });

  it("never emits a batch past the provider's ceiling", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}/m${i}`);
    for (const batch of modelBatches(ids)) {
      expect(batch.length).toBeLessThanOrEqual(3);
      expect(batch.length).toBeGreaterThan(0);
    }
  });

  it("has nothing to send for an empty chain", () => {
    // `env.ts` refuses an empty chain at boot, so this is the shape rather
    // than a case — but an empty batch reaching the provider would be a 400.
    expect(modelBatches([])).toEqual([]);
  });
});
