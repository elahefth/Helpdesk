import { describe, expect, it } from "bun:test";
import { z } from "zod";

/**
 * `OPENROUTER_MODEL` is a preference order, and the parsing that turns the
 * string into one lives in `env.ts` — which parses `process.env` at import and
 * calls `process.exit(1)` when it cannot, so importing it here would take the
 * test runner down with it. The schema is restated rather than exported,
 * because exporting it only to test it would put a seam in `env.ts` that
 * nothing else wants; what these pin is the *behaviour* a mis-split would
 * break, and every one of those failures is silent — a chain that parsed to
 * one entry looks exactly like a working config until the pool throttles.
 */
const modelChain = z
  .string()
  .default(
    "google/gemma-4-31b-it:free,qwen/qwen3.8-27b:free,inclusionai/ling-3.0-flash-vl:free",
  )
  .transform((value) =>
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .refine((ids) => ids.length > 0, "name at least one model");

describe("OPENROUTER_MODEL as a preference order", () => {
  it("keeps the order it was written in — the first is the primary", () => {
    expect(modelChain.parse("a/one,b/two,c/three")).toEqual([
      "a/one",
      "b/two",
      "c/three",
    ]);
  });

  /** A single id is a chain of one, not a special case. */
  it("reads one id as a chain of one", () => {
    expect(modelChain.parse("a/one")).toEqual(["a/one"]);
  });

  /**
   * An env file written by a human has spaces after commas. Unhandled, the
   * second entry becomes " b/two" and OpenRouter answers 404 for a model whose
   * id looks correct in every log line.
   */
  it("trims the spaces a human leaves after a comma", () => {
    expect(modelChain.parse("a/one, b/two ,  c/three")).toEqual([
      "a/one",
      "b/two",
      "c/three",
    ]);
  });

  it("drops empty entries from a trailing or doubled comma", () => {
    expect(modelChain.parse("a/one,,b/two,")).toEqual(["a/one", "b/two"]);
  });

  /** Unset is the supported case, and it must still yield a usable chain. */
  it("falls back to a default chain of more than one provider", () => {
    const parsed = modelChain.parse(undefined);
    expect(parsed.length).toBeGreaterThan(1);
    // Two entries from one provider share the pool that just throttled, which
    // is the failure the fallbacks exist to survive.
    const providers = new Set(parsed.map((id) => id.split("/")[0]));
    expect(providers.size).toBe(parsed.length);
  });

  it("keeps the requested Gemma as the default primary", () => {
    expect(modelChain.parse(undefined)[0]).toBe("google/gemma-4-31b-it:free");
  });

  it.each([
    ["an empty value", ""],
    ["only commas", ",,,"],
    ["only whitespace", "   "],
  ])("refuses %s rather than booting with no model", (_label, value) => {
    expect(modelChain.safeParse(value).success).toBe(false);
  });
});
