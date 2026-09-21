import { describe, expect, it } from "bun:test";
import {
  isAuthorizedSource,
  wantsClassificationSkipped,
} from "./inbound-email.ts";

/**
 * `env` is parsed once at import, so a test cannot configure a secret and then
 * make a request against it — which is exactly why the guard is a pure function
 * taking both sides. These are the only tests that can reach it, and it is the
 * whole of the protection on the API's one unauthenticated write.
 */
describe("isAuthorizedSource", () => {
  const SECRET = "an-inbound-secret-long-enough";

  it("admits the configured secret", () => {
    expect(isAuthorizedSource(SECRET, SECRET)).toBe(true);
  });

  it("refuses a wrong secret of the same length", () => {
    const wrong = `${SECRET.slice(0, -1)}X`;
    expect(wrong.length).toBe(SECRET.length);
    expect(isAuthorizedSource(wrong, SECRET)).toBe(false);
  });

  // timingSafeEqual throws on a length mismatch rather than returning false, so
  // an unguarded call would turn a short header into a 500 — and, worse, into a
  // reply that is distinguishable from a plain rejection.
  it.each([
    ["shorter", SECRET.slice(0, 4)],
    ["longer", `${SECRET}-and-then-some`],
    ["empty", ""],
    ["absent", undefined],
  ])("refuses a %s header without throwing", (_label, presented) => {
    expect(isAuthorizedSource(presented, SECRET)).toBe(false);
  });

  // The development posture: with nothing configured the endpoint is open, so a
  // local curl works. env.ts refuses to boot in production without a secret,
  // which is what keeps this branch out of a deployed process.
  it("admits anything when no secret is configured", () => {
    expect(isAuthorizedSource(undefined, undefined)).toBe(true);
    expect(isAuthorizedSource("anything", undefined)).toBe(true);
  });
});

/**
 * The other header this endpoint reads, and pure for the same reason: the queue
 * it governs needs a database and a model, neither of which a `bun test` run
 * has.
 *
 * It fails quietly in the direction that costs something. A header meant to
 * skip that is not recognised classifies a hundred fixtures anyway — a model
 * call each, and the committed corpus's deliberate unclassified tail rewritten
 * differently on every run, with nothing to say the flag was ignored.
 */
describe("wantsClassificationSkipped", () => {
  it.each([
    ["1", "1"],
    ["true", "true"],
    ["True", "True"],
  ])("skips on %s", (_label, header) => {
    expect(wantsClassificationSkipped(header)).toBe(true);
  });

  // Absent is the ordinary delivery: a real email from a real provider, which
  // is exactly what the classifier is for.
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["0", "0"],
    ["false", "false"],
    ["anything else", "yes please"],
  ])("classifies when the header is %s", (_label, header) => {
    expect(wantsClassificationSkipped(header)).toBe(false);
  });
});
