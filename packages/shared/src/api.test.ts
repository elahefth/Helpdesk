import { describe, expect, it } from "bun:test";
import { createUserBodySchema, updateUserBodySchema } from "./api.ts";

/**
 * The email normalisation these cover is not cosmetic, and it is the reason
 * this file exists at all.
 *
 * Better Auth lowercases an address when it stores one at sign-up, and its
 * `findUserByEmail` lowercases the address it is handed before comparing it to
 * the column. A row whose email carries a capital is therefore unreachable by
 * every sign-in, and a password reset does not help — the lookup fails before a
 * password is checked, so the account is locked out permanently.
 *
 * Creating a user goes through Better Auth and is normalised on the way past.
 * Editing one writes the column directly, so the normalisation has to live here
 * instead: in the schema both routes parse with, and both forms resolve against.
 */
const VALID = {
  name: "Ada Admin",
  email: "ada@helpdesk.test",
  password: "correct-horse",
};

describe("email normalisation", () => {
  it.each([
    ["createUserBodySchema", createUserBodySchema],
    ["updateUserBodySchema", updateUserBodySchema],
  ])("%s lowercases the address", (_label, schema) => {
    const parsed = schema.parse({ ...VALID, email: "Ada@Helpdesk.TEST" });
    expect(parsed.email).toBe("ada@helpdesk.test");
  });

  it.each([
    ["createUserBodySchema", createUserBodySchema],
    ["updateUserBodySchema", updateUserBodySchema],
  ])("%s trims before it stores", (_label, schema) => {
    const parsed = schema.parse({ ...VALID, email: "  Ada@Helpdesk.test  " });
    expect(parsed.email).toBe("ada@helpdesk.test");
  });

  it("still rejects an address that is malformed in any case", () => {
    const parsed = updateUserBodySchema.safeParse({
      ...VALID,
      email: "NOT-AN-EMAIL",
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The other half of the edit contract: blank means "leave the password alone".
 * All three spellings have to reach the route as `undefined`, because that is
 * the single case it branches on.
 */
describe("updateUserBodySchema password", () => {
  it.each([
    ["omitted", undefined],
    ["blank", ""],
    ["whitespace only", "   "],
  ])("treats a %s password as unchanged", (_label, password) => {
    const body = { name: VALID.name, email: VALID.email };
    const parsed = updateUserBodySchema.parse(
      password === undefined ? body : { ...body, password },
    );
    // The route branches on this, and JSON.stringify drops an undefined value,
    // so the key never reaches the wire either. Asserting the key is *absent*
    // from the parsed object would be wrong: Zod's transform leaves it present
    // and undefined when the input carried one.
    expect(parsed.password).toBeUndefined();
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({
      name: VALID.name,
      email: VALID.email,
    });
  });

  it("keeps a real password, trimmed", () => {
    const parsed = updateUserBodySchema.parse({
      ...VALID,
      password: "  correct-horse  ",
    });
    expect(parsed.password).toBe("correct-horse");
  });

  // "Unchanged" is the empty string, not any short string.
  it("still enforces the floor on a non-empty password", () => {
    const parsed = updateUserBodySchema.safeParse({
      ...VALID,
      password: "1234567",
    });
    expect(parsed.success).toBe(false);
  });
});
