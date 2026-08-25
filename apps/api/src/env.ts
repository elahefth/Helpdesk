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

    if (value.NODE_ENV === "production" && !value.INBOUND_EMAIL_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["INBOUND_EMAIL_SECRET"],
        message:
          "required in production — the inbound-email webhook has no other guard",
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
