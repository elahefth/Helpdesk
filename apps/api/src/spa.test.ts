import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { withPlatformDefaults } from "./env.ts";
import { notFoundHandler } from "./middleware/errors.ts";
import { createSpaRouter } from "./spa.ts";

/**
 * The production page server, against a throwaway build on disk and a real
 * listener. Every refusal here is a 200 of HTML that would otherwise reach
 * something expecting JSON or a script — which fails far from this file, in a
 * Zod parse or as a blank page.
 */
let dist: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "helpdesk-spa-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(dist, "theme.js"), "void 0");

  const app = express();
  const spa = createSpaRouter(dist);
  if (!spa) throw new Error("expected a router for a dist with index.html");
  app.use(spa);
  app.use(notFoundHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
  rmSync(dist, { recursive: true, force: true });
});

describe("createSpaRouter", () => {
  it("is undefined when there is no build to serve", () => {
    expect(createSpaRouter(join(dist, "missing"))).toBeUndefined();
  });

  it("answers a client-side route with the page, uncached", async () => {
    const res = await fetch(
      `${base}/tickets/33333333-3333-4333-8333-333333333333`,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  // The queue lives at "/", and Express 5's `*splat` needs a segment.
  it("answers the root with the page", async () => {
    const res = await fetch(`${base}/`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("serves fingerprinted assets as immutable", async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  // A stale tab after a deploy asks for the previous build's hashes. HTML
  // there is a script tag fed a page — a blank screen and a syntax error.
  it("404s a missing asset instead of answering with the page", async () => {
    const res = await fetch(`${base}/assets/index-old999.js`);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("leaves unmatched API paths to the JSON 404", async () => {
    for (const path of ["/api", "/api/nope"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("serves the theme script that index.html loads", async () => {
    const res = await fetch(`${base}/theme.js`);

    expect(res.status).toBe(200);
  });
});

describe("withPlatformDefaults", () => {
  it("defaults both URLs to Railway's public domain", () => {
    const env = withPlatformDefaults({
      RAILWAY_PUBLIC_DOMAIN: "helpdesk-production.up.railway.app",
    });

    expect(env.WEB_ORIGIN).toBe("https://helpdesk-production.up.railway.app");
    expect(env.BETTER_AUTH_URL).toBe(
      "https://helpdesk-production.up.railway.app",
    );
  });

  // A custom domain: RAILWAY_PUBLIC_DOMAIN keeps naming the railway.app one.
  it("never overrides a URL that was set explicitly", () => {
    const env = withPlatformDefaults({
      RAILWAY_PUBLIC_DOMAIN: "helpdesk-production.up.railway.app",
      WEB_ORIGIN: "https://support.example.com",
      BETTER_AUTH_URL: "https://support.example.com",
    });

    expect(env.WEB_ORIGIN).toBe("https://support.example.com");
    expect(env.BETTER_AUTH_URL).toBe("https://support.example.com");
  });

  it("changes nothing off Railway", () => {
    expect(withPlatformDefaults({ PORT: "3000" })).toEqual({ PORT: "3000" });
  });
});
