import { Router } from "express";
import type { Health, Readiness } from "@helpdesk/shared";
import { checkDatabase } from "../db/client.ts";

export const healthRouter: Router = Router();

/** Liveness: is the process up? Never touches dependencies. */
healthRouter.get("/healthz", (_req, res) => {
  const body: Health = {
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
  };
  res.json(body);
});

/**
 * Readiness: should this instance receive traffic? Checks Postgres.
 * Returns 503 when degraded so the platform holds traffic back.
 */
healthRouter.get("/readyz", async (_req, res) => {
  const database = await checkDatabase();
  const body: Readiness = {
    status: database === "up" ? "ready" : "degraded",
    checks: { database },
  };
  res.status(database === "up" ? 200 : 503).json(body);
});
