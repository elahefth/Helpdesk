import { createAuth } from "./auth.ts";
import type { Database } from "./db/client.ts";

/**
 * Schema-generation entrypoint for `@better-auth/cli generate` — the CLI wants
 * a module exporting a built `auth`, which the factory in auth.ts is not.
 *
 * The CLI runs under Node, so it cannot import db/client.ts (Bun's `SQL`).
 * Generation only reads the auth options, never issues a query, so a stub
 * stands in for the real handle. Nothing in the running app imports this.
 * Re-run the generator through it after changing auth options or plugins.
 */
export const auth = createAuth({} as Database);
