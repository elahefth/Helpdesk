import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import type { ApiError } from "@helpdesk/shared";
import { isProduction } from "../env.ts";

/** Thrown by route handlers for expected, client-visible failures. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  static notFound(message = "Not found") {
    return new HttpError(404, "not_found", message);
  }

  static badRequest(message: string, details?: unknown) {
    return new HttpError(400, "bad_request", message, details);
  }

  static unauthorized(message = "Authentication required") {
    return new HttpError(401, "unauthorized", message);
  }

  static forbidden(message = "Insufficient permissions") {
    return new HttpError(403, "forbidden", message);
  }

  /**
   * For a well-formed request that collides with existing state — a duplicate
   * email on POST /api/users. Distinct from 400: nothing about the payload is
   * malformed, so re-validating it would not help the caller.
   */
  static conflict(message: string) {
    return new HttpError(409, "conflict", message);
  }

  /**
   * For a dependency the API is designed to boot without — a route that needs
   * Postgres when `getDb()` returned undefined. Distinct from 500: the request
   * was well-formed and may succeed on retry.
   */
  static serviceUnavailable(message = "Service unavailable") {
    return new HttpError(503, "service_unavailable", message);
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiError = {
    error: {
      code: "not_found",
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.id,
    },
  };
  res.status(404).json(body);
}

/**
 * Must be registered last and must keep all four parameters — Express
 * identifies error middleware by arity.
 *
 * Express 5 forwards rejected promises from async handlers here automatically,
 * so route handlers do not need try/catch just to reach this.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    req.log?.warn({ err }, "request validation failed");
    const body: ApiError = {
      error: {
        code: "validation_failed",
        message: "Request validation failed",
        requestId: req.id,
        details: err.issues,
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof HttpError) {
    req.log?.warn({ err, code: err.code }, "request failed");
    const body: ApiError = {
      error: {
        code: err.code,
        message: err.message,
        requestId: req.id,
        details: err.details,
      },
    };
    res.status(err.status).json(body);
    return;
  }

  req.log?.error({ err }, "unhandled error");
  const body: ApiError = {
    error: {
      code: "internal_error",
      // Never leak internals to the client in production.
      message: isProduction
        ? "Internal server error"
        : err instanceof Error
          ? err.message
          : String(err),
      requestId: req.id,
    },
  };
  res.status(500).json(body);
}
