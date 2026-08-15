import { z } from "zod";

/**
 * Fail fast on bad configuration. An app that boots with a missing secret and
 * dies on the first request is worse than one that refuses to start.
 *
 * DATABASE_URL is intentionally optional so the API runs before Postgres
 * exists — /readyz reports the truth instead of the process crash-looping.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
