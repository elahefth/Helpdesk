import { describe, expect, it } from "bun:test";
import {
  buildPolishPrompt,
  INSTRUCTIONS,
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
    expect(
      buildPolishPrompt("d", ticket({ studentName: null }), AGENT),
    ).toContain("From: ada@example.edu");
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
