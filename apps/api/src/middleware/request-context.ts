import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      log: typeof logger;
    }
  }
}

/**
 * Stamps every request with an ID and a child logger bound to it, so a single
 * request's lines can be grepped out of production logs. The ID is echoed in
 * error responses — when a user reports a failure, that string finds it.
 */
export function requestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header("x-request-id");
  req.id = incoming && incoming.length <= 200 ? incoming : randomUUID();
  req.log = logger.child({ requestId: req.id });
  res.setHeader("x-request-id", req.id);

  const startedAt = performance.now();
  res.on("finish", () => {
    req.log.info(
      {
        method: req.method,
        // originalUrl, not path — inside a mounted router `req.path` is
        // router-relative, so /api/tickets would log as /tickets.
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "request completed",
    );
  });

  next();
}
