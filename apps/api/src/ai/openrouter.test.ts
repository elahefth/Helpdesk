import { describe, expect, it } from "bun:test";
import { APICallError, RetryError } from "ai";
import {
  describeProviderFailure,
  modelBatches,
  unwrapModelText,
} from "./openrouter.ts";

/**
 * The shared model-call core: what every feature that runs a model gets for
 * free, and what it is told when the provider will not play.
 *
 * These were the polisher's tests while polishing was the only caller. They
 * moved with the code, and the move is the point — a second feature on the
 * same core must not mean a second, drifting copy of the rules about what
 * OpenRouter accepts and what an agent is told when it refuses.
 */

/**
 * What a small instruction-tuned model does with "reply with the text and
 * nothing else". Each of these lands in the agent's box, so a missed case is a
 * stray code fence in something about to be sent to a student.
 */
describe("unwrapModelText", () => {
  it("leaves an ordinary answer alone", () => {
    expect(unwrapModelText("Hi Ada,\n\nWe have issued the refund.")).toBe(
      "Hi Ada,\n\nWe have issued the refund.",
    );
  });

  it("trims the whitespace around it", () => {
    expect(unwrapModelText("\n\n  Thanks for writing in.  \n")).toBe(
      "Thanks for writing in.",
    );
  });

  it.each([
    ["a bare fence", "```\nThanks for writing in.\n```"],
    ["a tagged fence", "```text\nThanks for writing in.\n```"],
    ["a fence with padding around it", "\n```\nThanks for writing in.\n```\n"],
  ])("unwraps %s", (_label, text) => {
    expect(unwrapModelText(text)).toBe("Thanks for writing in.");
  });

  it("unwraps the prompt's own draft tags echoed back", () => {
    expect(
      unwrapModelText("<draft>\nThanks for writing in.\n</draft>", "draft"),
    ).toBe("Thanks for writing in.");
  });

  /**
   * A fence in the *middle* is content — an agent pasting a command or a config
   * snippet into a reply is ordinary — and only a fence wrapping the whole
   * answer is the model's packaging.
   */
  it("keeps a fenced block that is part of the reply", () => {
    const reply = "Run this:\n\n```\nbun run dev\n```\n\nThen try again.";
    expect(unwrapModelText(reply)).toBe(reply);
  });

  /**
   * Deliberately not stripped: there is no telling this line from a first
   * sentence the agent wrote, and deleting a real one is the worse mistake.
   */
  it("leaves a preamble line for the agent to remove", () => {
    const text = "Here is the improved reply:\n\nThanks for writing in.";
    expect(unwrapModelText(text)).toBe(text);
  });

  /**
   * The summariser passes no tag, because its prompt has no block a model could
   * echo that would still be a summary. Stripping one anyway would mean a
   * feature's answer silently losing text it meant to keep.
   */
  it("leaves tags alone when the caller names none", () => {
    expect(unwrapModelText("<draft>\nSome text.\n</draft>")).toBe(
      "<draft>\nSome text.\n</draft>",
    );
  });

  /** Only the caller's own tag, not any tag that happens to wrap the answer. */
  it("ignores a tag the caller did not name", () => {
    expect(unwrapModelText("<ticket>\nSome text.\n</ticket>", "draft")).toBe(
      "<ticket>\nSome text.\n</ticket>",
    );
  });

  it("reports an answer of nothing as empty rather than guessing", () => {
    expect(unwrapModelText("   \n  ")).toBe("");
    expect(unwrapModelText("```\n\n```")).toBe("");
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
