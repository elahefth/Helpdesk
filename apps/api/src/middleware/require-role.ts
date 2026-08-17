import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { UserRole } from "@helpdesk/shared";
import { HttpError } from "./errors.ts";

/**
 * Restricts a route to the given roles. Composes *after* `requireAuth`, which is
 * what populates `req.user`.
 *
 * Attach it to the route, not with `router.use`. The app routers are mounted at
 * a bare "/api", so a pathless `router.use(requireRole("admin"))` would match
 * every request that fell through the routers above it — turning `GET /api/nope`
 * into a 403 for non-admins and making `notFoundHandler` unreachable.
 *
 * The rest parameter is typed as a non-empty tuple so `requireRole()`, which
 * would deny everyone, is a compile error rather than a runtime lockout.
 */
export function requireRole(
  ...roles: [UserRole, ...UserRole[]]
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    // No user means this was mounted without requireAuth in front of it. That is
    // a wiring bug, and 401 is the fail-closed answer to it.
    if (!req.user) throw HttpError.unauthorized();

    // 403 rather than 401 for a wrong or missing role: the caller proved who
    // they are, they just are not allowed here. `role` is nullable in the
    // generated auth schema, so "missing" is reachable, not merely theoretical.
    if (!roles.includes(req.user.role)) throw HttpError.forbidden();

    next();
  };
}
