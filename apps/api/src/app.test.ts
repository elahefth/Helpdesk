import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createApp } from "./app.ts";
import { canTransition } from "@helpdesk/shared";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

const get = (path: string) => fetch(`${baseUrl}${path}`);

/** `Response.json()` is `unknown`; tests assert on shape deliberately. */
const body = (res: Response) => res.json() as Promise<any>;

describe("health", () => {
  it("reports liveness", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.status).toBe("ok");
    expect(typeof payload.uptimeSeconds).toBe("number");
  });

  it("reports degraded readiness when no database is configured", async () => {
    const res = await get("/readyz");
    expect(res.status).toBe(503);
    const payload = await body(res);
    expect(payload.checks.database).toBe("down");
  });
});

describe("tickets", () => {
  it("returns an empty page", async () => {
    const res = await get("/api/tickets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], nextCursor: null });
  });

  it("accepts valid filters", async () => {
    const res = await get("/api/tickets?status=open&priority=urgent&limit=10");
    expect(res.status).toBe(200);
  });

  it("rejects an invalid filter value", async () => {
    const res = await get("/api/tickets?status=not-a-status");
    expect(res.status).toBe(400);
    const payload = await body(res);
    expect(payload.error.code).toBe("validation_failed");
  });

  it("attaches a request id to errors", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    const payload = await body(res);
    expect(payload.error.code).toBe("not_found");
    expect(payload.error.requestId).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("ticket lifecycle", () => {
  it("allows the student-replied reopen", () => {
    expect(canTransition("resolved", "open")).toBe(true);
  });

  it("treats closed as terminal", () => {
    expect(canTransition("closed", "open")).toBe(false);
  });

  it("rejects skipping straight from new to resolved", () => {
    expect(canTransition("new", "resolved")).toBe(false);
  });
});
