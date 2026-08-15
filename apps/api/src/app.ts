import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { env } from "./env.ts";
import { createAuth } from "./auth.ts";
import { getDb } from "./db/client.ts";
import { requestContext } from "./middleware/request-context.ts";
import { errorHandler, notFoundHandler } from "./middleware/errors.ts";
import { healthRouter } from "./routes/health.ts";
import { ticketsRouter } from "./routes/tickets.ts";

/**
 * Built as a factory so tests can spin up an app without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind Render/Fly this is required for correct client IPs and secure
  // cookie handling once sessions land in Phase 4.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));

  // Above the auth mount so /api/auth requests get an ID and a log line too;
  // it never touches the body, so it is safe here.
  app.use(requestContext);

  // Must sit above express.json(): Better Auth reads the raw body itself, and
  // a consumed stream hangs the request. Express 5 rejects a bare "*", hence
  // the named splat. Mounted only when a database exists so the API still
  // boots without Postgres — the 404 handler covers /api/auth until then.
  const db = getDb();
  if (db) {
    app.all("/api/auth/*splat", toNodeHandler(createAuth(db)));
  }

  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);
  app.use("/api", ticketsRouter);

  // Order matters: 404 catch-all, then the error handler, both last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
