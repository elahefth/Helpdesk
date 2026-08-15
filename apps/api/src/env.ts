import { z } from "zod";

/**
 * Fail fast on bad configuration. An app that boots with a missing secret and
 * dies on the first request is worse than one that refuses to start.
 *
 * DATABASE_URL is intentionally optional so the API runs before Postgres
 * exists — /readyz reports the truth instead of the process crash-looping.
 * BETTER_AUTH_SECRET follows the same rule for the same reason: optional in
 * development (Better Auth falls back to a dev secret and warns), mandatory
 * in production, enforced by the refinement below.
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
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
