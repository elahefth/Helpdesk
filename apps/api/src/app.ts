import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { env, isProduction } from "./env.ts";
import { createAuth, type Auth } from "./auth.ts";
import { getDb } from "./db/client.ts";
import { requestContext } from "./middleware/request-context.ts";
import { requireAuth } from "./middleware/require-auth.ts";
import { errorHandler, notFoundHandler } from "./middleware/errors.ts";
import { healthRouter } from "./routes/health.ts";
import { createInboundEmailRouter } from "./routes/inbound-email.ts";
import { createTicketsRouter } from "./routes/tickets.ts";
import { createUsersRouter } from "./routes/users.ts";
import { logger } from "./logger.ts";
import { createSpaRouter, resolveWebDist } from "./spa.ts";
import { createTicketJobs, type TicketJobs } from "./ticket-jobs.ts";

export interface CreateAppOptions {
  /** Test seam: inject an auth instance so the guard can be exercised without Postgres. */
  auth?: Auth;
  /**
   * Where newly ingested tickets go to be categorised, after their response has
   * been sent.
   *
   * Injected rather than only built here because `index.ts` needs the *same*
   * instance: it calls `resume()` on it at boot to re-queue whatever a previous
   * process left pending. Defaulted so nothing else has to know, and so the
   * absence of a model or a database is answered in one place.
   */
  jobs?: TicketJobs;
}

/**
 * Built as a factory so tests can spin up an app without binding a port.
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  // Railway (like Render and Fly) terminates TLS at one proxy in front of the
  // container. Trusting exactly one hop is what makes `req.ip` the client and
  // `req.secure` true, without letting a client spoof X-Forwarded-For.
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
  const auth = options.auth ?? (db ? createAuth(db) : undefined);
  if (auth) {
    app.all("/api/auth/*splat", toNodeHandler(auth));
  }

  app.use(express.json({ limit: "1mb" }));

  // Public: the platform gates traffic on these and the SPA polls /readyz from
  // its login screen, before anyone has a session.
  app.use(healthRouter);

  // Also public, and necessarily so: whatever delivers mail here — a provider
  // webhook, a forwarding script, the fixture sender — has no session and never
  // will. It sits above requireAuth for that reason, and carries its own guard
  // (the x-inbound-secret header) in place of one. Mounted at "/api" like the
  // routers below, so an unmatched /api path still falls through to them and on
  // to notFoundHandler.
  app.use(
    "/api",
    createInboundEmailRouter(db, options.jobs ?? createTicketJobs(db)),
  );

  // Everything else under /api is staff-only. The auth routes above already
  // terminated their own responses, so they never reach this guard.
  //
  // Both routers share the one requireAuth rather than getting an app.use each:
  // a request that fell through the first router would otherwise pay for a
  // second session lookup. Admin-only routes carry their own requireRole
  // internally, so the gate here stays "any signed-in staff".
  app.use(
    "/api",
    requireAuth(auth),
    createTicketsRouter(db),
    createUsersRouter(db, auth),
  );

  // The SPA, after every API router so it can only ever answer what they did
  // not. Production only: in dev Vite serves the page on :5173, and a stale
  // `apps/web/dist` answering on :3000 would be a second, older copy of the
  // app one typo away from the real one.
  if (isProduction) {
    const dist = resolveWebDist(env.WEB_DIST_PATH);
    const spa = createSpaRouter(dist);
    if (spa) app.use(spa);
    else logger.warn({ dist }, "no built SPA found — serving the API only");
  }

  // Order matters: 404 catch-all, then the error handler, both last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
