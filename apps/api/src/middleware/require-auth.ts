import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { User } from "@helpdesk/shared";
import type { Auth } from "../auth.ts";
import { HttpError } from "./errors.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Populated only by `requireAuth`. Optional because the middleware is
       * route-scoped, not app-wide — `/healthz` has no user and should not
       * pretend otherwise.
       */
      user?: User;
    }
  }
}

/**
 * A factory over the `Auth` instance rather than a module-level import, for the
 * same reason `createAuth` is one: the auth instance needs a concrete database
 * handle, and `getDb()` may return undefined.
 *
 * Fails closed. When the API boots without Postgres there is no way to verify a
 * session, so every guarded route answers 401 rather than waving requests
 * through on the grounds that the check was unavailable.
 */
export function requireAuth(auth: Auth | undefined): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!auth) throw HttpError.unauthorized();

    // Better Auth reads the session cookie off a WHATWG Headers object; Node's
    // IncomingHttpHeaders needs converting first.
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) throw HttpError.unauthorized();

    req.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
    };

    next();
  };
}
