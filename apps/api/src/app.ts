import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./env.ts";
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
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext);

  app.use(healthRouter);
  app.use("/api", ticketsRouter);

  // Order matters: 404 catch-all, then the error handler, both last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
