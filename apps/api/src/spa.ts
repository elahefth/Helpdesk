import { existsSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router } from "express";

/**
 * Serves the built SPA from the API process, so production is one service on
 * one origin.
 *
 * One origin is the decision that matters, not the convenience of one deploy.
 * The auth client sets no `baseURL` and the session cookie carries no
 * cross-site exemption, which is exactly how dev works through Vite's proxy —
 * so serving the bundle from here means the browser sees in production the
 * same-origin arrangement it was built and tested against. Two services on two
 * hostnames would need `SameSite=None` cookies and a CORS allowlist that has to
 * be right for sign-in to work at all.
 *
 * `undefined` when there is no build to serve, the same shape as `getDb()`:
 * the API still boots and answers `/api`, and the absence is logged by the
 * caller rather than discovered as a blank page.
 */
export function createSpaRouter(distPath: string): Router | undefined {
  const indexHtml = join(distPath, "index.html");
  if (!existsSync(indexHtml)) return undefined;

  const router = Router();

  // Vite fingerprints everything under /assets, so a file there never changes
  // under the same name and can be cached for as long as a browser likes. A
  // miss falls through to the fallback below, which declines it (it has an
  // extension) and lets `notFoundHandler` answer a plain 404.
  router.use(
    "/assets",
    express.static(join(distPath, "assets"), { immutable: true, maxAge: "1y" }),
  );

  // Everything else at the top level (theme.js, favicons) keeps its name across
  // deploys, so it is revalidated rather than trusted. `index: false` leaves "/"
  // to the fallback below, which owns index.html's headers.
  router.use(express.static(distPath, { index: false, maxAge: 0 }));

  /**
   * Client-side routes — /tickets/:id, /dashboard, /users — have no file on
   * disk, so they get index.html and React Router takes over.
   *
   * Three kinds of path are refused rather than answered with the page, each
   * because a 200 of HTML would be a lie the caller cannot detect:
   * - `/api/*`, which must keep falling through to `notFoundHandler`'s JSON
   *   404 — a fetch that gets HTML back fails in the Zod parse with a message
   *   about the wrong thing. (`createApp` mounts this after the API routers, so
   *   in practice only an unmatched API path gets here.)
   * - the health routes, for the same reason a platform probe would.
   * - anything with a file extension: `/assets/old-hash.js` after a deploy is a
   *   missing file, and handing a script tag an HTML page is how a stale tab
   *   turns into a blank one with a syntax error in the console.
   *
   * `no-cache` on the page itself: it names the current asset hashes, so a
   * cached copy after a deploy points at files that no longer exist.
   */
  // `{*splat}` rather than `*splat`: in Express 5 a bare splat needs at least
  // one segment, so "/" — the queue — would fall through to the 404.
  router.get("/{*splat}", (req, res, next) => {
    if (
      req.path.startsWith("/api/") ||
      req.path === "/api" ||
      req.path === "/healthz" ||
      req.path === "/readyz" ||
      extname(req.path) !== ""
    ) {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });

  return router;
}

/**
 * Where the built SPA is, resolved from the API package rather than the
 * process's working directory — the reasoning `KNOWLEDGE_BASE_PATH` follows,
 * so `bun apps/api/src/index.ts` from the repo root and `bun src/index.ts`
 * from `apps/api` find the same folder.
 */
export function resolveWebDist(configured: string): string {
  if (isAbsolute(configured)) return configured;
  const apiRoot = fileURLToPath(new URL("..", import.meta.url));
  return resolve(apiRoot, configured);
}
