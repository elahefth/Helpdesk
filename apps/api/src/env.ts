import { z } from "zod";

/**
 * Fail fast on bad configuration. An app that boots with a missing secret and
 * dies on the first request is worse than one that refuses to start.
 *
 * DATABASE_URL is intentionally optional so the API runs before Postgres
 * exists — /readyz reports the truth instead of the process crash-looping.
 * BETTER_AUTH_SECRET follows the same rule for the same reason: optional in
 * development (Better Auth falls back to a dev secret and warns), mandatory
 * in production, enforced by the refinement below. INBOUND_EMAIL_SECRET is the
 * third of the same shape.
 */
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: z.string().url().optional(),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

    /**
     * The mailbox tickets are created from. POST /api/inbound-email refuses
     * anything addressed elsewhere, which is what keeps it an ingestion
     * endpoint rather than an open "create a ticket about anything" API.
     */
    SUPPORT_EMAIL: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .default("support@helpdesk.test"),

    /**
     * Shared secret for the inbound-email webhook, compared against the
     * `x-inbound-secret` header. Optional in development for the same reason
     * BETTER_AUTH_SECRET is — a local `curl` should not need a ceremony — and
     * mandatory in production, enforced below. The endpoint is necessarily
     * unauthenticated (a mail provider holds no session), so this header is the
     * only thing standing between it and anyone who can reach the host.
     */
    INBOUND_EMAIL_SECRET: z.string().min(16).optional(),

    /**
     * OpenRouter credentials, shared by everything that runs a model: the reply
     * polisher, the ticket summariser, and the automatic classifier.
     *
     * Optional everywhere, including production, and that is the difference
     * between this and the two secrets above: they guard something, so booting
     * without one is a hole. This one *enables* something. An install that
     * never sets it simply has no polish button that works — the route answers
     * 503 and says so — which is a better failure than an API that refuses to
     * start because an optional convenience is unconfigured.
     *
     * The classifier is the one of the three with no route to answer for its
     * absence, because nobody asked it a question: ingestion marks the ticket
     * `skipped` instead, which is the honest record that nothing was asked and
     * nothing is coming. Categories then stay what they were before any of this
     * existed — a human decision, or null.
     */
    OPENROUTER_API_KEY: z.string().min(1).optional(),

    /**
     * Where the support knowledge base lives — the document the automatic
     * resolver answers students out of.
     *
     * A path rather than a database table, and that is the decision worth
     * knowing. The knowledge base is written and argued over by the people who
     * run the helpdesk, it changes on their schedule rather than the app's, and
     * every word of it is policy someone has to be able to review — so it is a
     * file in the repo, versioned in git, with a diff per change. A table would
     * make "what did we tell students last Tuesday" unanswerable.
     *
     * Optional, and relative paths resolve from the API's own directory so the
     * committed default works from any cwd. An install that points this at a
     * file that is not there has no resolver at all — see
     * `createTicketAutoResolver` — rather than one answering from nothing,
     * which is the failure worth refusing: a model handed an empty knowledge
     * base does not decline, it invents a refund policy.
     */
    KNOWLEDGE_BASE_PATH: z.string().trim().min(1).default("knowledge-base.md"),

    /**
     * The built SPA the API serves in production — see `spa.ts`. Relative
     * paths resolve from the API package, like `KNOWLEDGE_BASE_PATH`, so the
     * default finds `apps/web/dist` from any working directory.
     */
    WEB_DIST_PATH: z.string().trim().min(1).default("../web/dist"),

    /**
     * Which model runs — a comma-separated preference order, not one id, and
     * shared by all three features that call one.
     *
     * The first is the primary and the rest are fallbacks, handed to
     * OpenRouter's own `models` routing: when the primary is throttled it
     * serves the next one instead of failing the request. That is not a
     * nicety on a `:free` tier. Free models sit behind a shared upstream pool
     * that throttles and recovers minute to minute, so a single id means the
     * Polish button works intermittently for reasons no agent can see or act
     * on — and the whole chain has to be exhausted before the 502 is honest.
     *
     * Defaulted rather than required, so a key is the only thing an install
     * must set, and configurable because OpenRouter retires and renames free
     * models on its own schedule — a hardcoded list would make that a code
     * change. The defaults span five different providers on purpose: entries
     * from one provider share the pool that just throttled, so a chain of
     * siblings is barely a chain. Measured against the live free tier, a
     * throttled model refuses in well under a second, so a long chain costs
     * roughly nothing when it is walked and is the difference between the
     * button working and not.
     *
     * One id is still valid and is simply a chain of length one.
     */
    /**
     * A preference order, comma-separated, not one model.
     *
     * Two things about what belongs in it are easy to get wrong and quiet.
     * Every id should name a model that *answers directly*: a reasoning model
     * spends the output budget thinking before it writes, and a rewrite this
     * short can be finished by the budget before the reply begins — which
     * arrives as `content: null` and is reported as an empty reply, not as the
     * configuration mistake it is. The classifier is where that shows up first,
     * because its budget is the smallest of the three (one word), and it shows
     * up quietly: tickets marked `failed` with no button anyone pressed. And free models share an upstream pool that
     * throttles minute to minute, so a chain with nothing paid in it makes the
     * button work intermittently for reasons no agent can see.
     */
    OPENROUTER_MODEL: z
      .string()
      .default(
        "google/gemma-4-31b-it:free,inclusionai/ling-3.0-flash-vl:free,nex-agi/nex-n2.5-pro:free,qwen/qwen3.8-27b:free,nex-agi/nex-n2.5-mini:free",
      )
      // Split here rather than at the call site so a malformed list fails at
      // boot, where env problems are supposed to surface, rather than on the
      // first click of a button.
      .transform((value) =>
        value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      )
      .refine(
        (ids) => ids.length > 0,
        "name at least one model, or leave it unset for the default",
      ),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.BETTER_AUTH_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_SECRET"],
        message:
          "required in production — generate with: openssl rand -base64 32",
      });
    }

    /**
     * The two URLs that have to name the public address, and whose defaults
     * name a developer's laptop. Both compare as strings — WEB_ORIGIN against
     * the browser's `Origin` header for CORS and Better Auth's
     * `trustedOrigins`, BETTER_AUTH_URL as the base every auth cookie and
     * redirect is built from — so a deploy that kept either default boots,
     * serves the login page, and refuses every sign-in with `INVALID_ORIGIN`.
     * Refusing to boot says the true thing instead.
     */
    if (value.NODE_ENV === "production") {
      for (const key of ["WEB_ORIGIN", "BETTER_AUTH_URL"] as const) {
        if (new URL(value[key]).hostname === "localhost") {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message:
              "points at localhost in production — set it to the public URL, or generate a Railway domain so RAILWAY_PUBLIC_DOMAIN supplies one",
          });
        }
      }
    }

    if (value.NODE_ENV === "production" && !value.INBOUND_EMAIL_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["INBOUND_EMAIL_SECRET"],
        message:
          "required in production — the inbound-email webhook has no other guard",
      });
    }
  });

/**
 * On Railway the public address is already known: the platform sets
 * `RAILWAY_PUBLIC_DOMAIN` on a service once it has a domain. The SPA is served
 * from the API (see `spa.ts`), so the page's origin and the auth base URL are
 * the same address, and both default to it here — one fewer pair of variables
 * to keep in step with a domain that can change.
 *
 * Only ever a default. Anything set explicitly wins, which is what a custom
 * domain needs: `RAILWAY_PUBLIC_DOMAIN` keeps naming the *.up.railway.app one.
 */
export function withPlatformDefaults(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const domain = source.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (!domain) return source;

  const publicUrl = `https://${domain}`;
  return {
    ...source,
    WEB_ORIGIN: source.WEB_ORIGIN || publicUrl,
    BETTER_AUTH_URL: source.BETTER_AUTH_URL || publicUrl,
  };
}

const parsed = envSchema.safeParse(withPlatformDefaults(process.env));

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
