# Tech Stack

Companion to [project-scope.md](./project-scope.md). The scope fixes *what* we build; this fixes *what we build it with*.

---

## Summary

| Layer | Decision |
|---|---|
| Repo | npm workspaces monorepo — `apps/web`, `apps/api`, `packages/shared` |
| Language | TypeScript, `strict: true`, everywhere |
| Frontend | React 19 + Vite + React Router 7 |
| Server state | TanStack Query |
| UI | Tailwind + shadcn/ui (Radix primitives) |
| Tables / charts | TanStack Table, Recharts |
| Forms | React Hook Form + Zod resolver |
| API | Node 22 LTS + Express 5 |
| Validation | Zod, schemas shared FE↔BE via `packages/shared` |
| ORM | Drizzle |
| Database | Postgres 17 |
| Jobs / queue | pg-boss (queue lives in Postgres — no Redis) |
| AI | `@anthropic-ai/sdk`, model `claude-opus-5` |
| Retrieval | Postgres full-text search (`tsvector`), behind an interface |
| Email | **Mailgun** (inbound routes + outbound send), behind an adapter |
| Auth | Session cookies, sessions stored in Postgres |
| Logging | pino |
| Testing | Vitest, Supertest, Playwright, MSW |
| Packaging | Docker (multi-stage) + Docker Compose for local dev |
| Hosting | Render (Docker-native, managed Postgres) |

---

## Monorepo layout

```
apps/
  web/          React SPA (Vite)
  api/          Express API + pg-boss worker entrypoint
packages/
  shared/       Zod schemas, domain enums, generated types
docker/
  Dockerfile.api
  Dockerfile.web
compose.yaml
```

`packages/shared` holds the ticket status/category/priority enums, the AI classification schema, and every request/response Zod schema. Both sides import from it, so an API contract change is a type error in the SPA rather than a runtime surprise.

---

## Email — Mailgun

**Chosen over SendGrid** because this system is *inbound-first*. Mailgun's Inbound Routes sign their webhook payloads with HMAC out of the box, and the parsed payload gives us `stripped-text` (the reply with quoted history already removed) — which is exactly what we need to avoid re-ingesting the entire thread on every reply. SendGrid's Inbound Parse works, but has historically leaned on a secret URL path rather than a signature for authenticity; verify current capabilities before swapping.

Both sit behind the same adapter, so the swap is one file.

### Adapter interface

```ts
// packages/shared/email.ts
export interface InboundEmail {
  providerMessageId: string;
  messageId: string;          // RFC 5322 Message-ID header
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string;
  subject: string;
  bodyText: string;           // quoted history stripped
  bodyHtml: string | null;
  receivedAt: Date;
}

export interface EmailSource {
  /** Verify provider authenticity, then normalize the raw payload. */
  parseInbound(req: Request): Promise<InboundEmail>;
}

export interface EmailSink {
  send(msg: OutboundEmail): Promise<{ providerMessageId: string }>;
}
```

Implementations: `MailgunSource` / `MailgunSink`, `MockSource` / `OutboxSink`.

### Threading

Thread on **RFC 5322 headers**, never on the subject line:

1. Look up `inReplyTo` against `messages.message_id`.
2. Fall back to scanning `references` newest-to-oldest.
3. Only if both miss, create a new ticket.

Subject-based threading works on seeded data and breaks the first day real mail arrives.

### Inbound flow

```
Mailgun Route → POST /webhooks/email/inbound
  → verify HMAC (timestamp + token + signing key; reject if timestamp is stale)
  → 200 immediately (Mailgun retries on non-2xx; don't hold the connection)
  → enqueue pg-boss job: ingest-email
      → thread or create ticket
      → enqueue: classify-ticket
      → enqueue: summarize-thread (only if >1 message)
      → enqueue: draft-reply
```

Store the raw provider payload before parsing. When threading gets something wrong, that raw row is the only way to find out why.

### Outbound and the V1 scope

The scope is explicit: **draft-only, nothing leaves the machine in V1.** So `MailgunSink` is written and tested but not wired live — `EMAIL_SINK=outbox` is the default, and `EMAIL_SINK=mailgun` is the flag that arms it. The simulated outbox writes to the `outbound_messages` table and renders in the thread exactly as a sent message would.

Same for inbound: `EMAIL_SOURCE=mock` seeds from fixtures; `EMAIL_SOURCE=mailgun` enables the webhook route. This keeps the pipeline honest — the mock and the real provider produce the identical `InboundEmail` shape.

---

## AI layer

SDK: `@anthropic-ai/sdk`. Default model: **`claude-opus-5`**.

### Structured outputs, not prompt-and-parse

Classification returns a schema-constrained object via `output_config.format`. The low-confidence signal from the scope is a *required field*, not a string we regex for:

```ts
const ClassificationSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: CATEGORIES },
    priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    routingTarget: { type: "string", enum: QUEUES },
    confidence: { type: "number" },
    needsHuman: { type: "boolean" },
    reasoning: { type: "string" },
  },
  required: ["category", "priority", "routingTarget", "confidence", "needsHuman"],
  additionalProperties: false,
};
```

Mirror it as a Zod schema in `packages/shared` and re-validate on receipt.

### Cost / quality dial

Use `output_config.effort` rather than downgrading models:

| Job | Starting effort |
|---|---|
| `classify-ticket` | `low` — sweep up if accuracy dips |
| `summarize-thread` | `medium` |
| `draft-reply` | `high` |

Opus 5 is strong at low effort; measure before assuming a bigger dial is needed.

### Prompt caching

Every ticket in a batch shares the same system prompt and KB context. Put a `cache_control: { type: "ephemeral" }` breakpoint on the last stable block (system prompt + retrieved articles) and keep the per-ticket content *after* it. Minimum cacheable prefix on Opus 5 is 512 tokens, so even modest prompts benefit. Verify with `usage.cache_read_input_tokens` — if it's zero across repeated calls, something volatile (a timestamp, a ticket ID) has leaked into the prefix.

### Observability

An `ai_calls` table logging model, job type, effort, prompt hash, input/output/cache tokens, latency, computed cost, and outcome. Same reasoning as the scope's feedback loop: cheap now, expensive to retrofit, and it's the only way to answer "why did this month cost more."

---

## Retrieval

**Postgres full-text search for V1.** Anthropic has no embeddings endpoint, so vectors mean adding a second AI vendor (Voyage or OpenAI) for a knowledge base of maybe 30–60 articles. Not worth it yet.

```
tsvector over (title, body) with a GIN index
→ ts_rank top ~10 candidates
→ pass to Claude as grounding context with article IDs
→ surface the cited IDs to the agent
```

Behind a `KnowledgeRetriever` interface, same move as the email adapter. Adding `pgvector` + a hybrid rank later touches one module, not the drafting pipeline.

---

## Auth — database sessions

Staff-only, admin + agent roles. **Session cookies with sessions stored in Postgres.**

| Piece | Choice |
|---|---|
| Password hashing | `argon2` (argon2id, default params) |
| Session middleware | `express-session` |
| Session store | `connect-pg-simple` → `session` table in Postgres |
| Cookie | `httpOnly`, `secure` in prod, `sameSite: "lax"`, rolling expiry |
| CSRF | Double-submit token on all mutating routes |

Why not JWT: this is a staff console where an admin needs to revoke an agent's access *now*. Server-side sessions give us that with a `DELETE`. JWTs would need a revocation list — which is a session store with extra steps.

Roles are checked in middleware (`requireRole("admin")`), not in the SPA. The frontend hides admin UI as a convenience; the API is the boundary.

A demo role-switcher can sit on top of this for presentations without weakening the underlying auth.

---

## Deployment — Docker

### Local

`compose.yaml` brings up four services:

| Service | Notes |
|---|---|
| `postgres` | Postgres 17, named volume, healthcheck |
| `api` | Express, hot reload via bind mount in dev |
| `worker` | Same image as `api`, different command — runs pg-boss handlers |
| `web` | Vite dev server; in prod it's static files behind the API or a CDN |

The worker is a **separate process from day one**. Running LLM jobs in the request handler works right up until a burst of tickets ties up every Express worker.

### Images

Multi-stage builds, `node:22-slim` base:

```
deps  → npm ci (workspace-aware)
build → tsc / vite build
run   → non-root user, prod deps only, dumb-init as PID 1
```

Health endpoints: `/healthz` (process alive) and `/readyz` (Postgres reachable, migrations applied) so the platform can gate traffic correctly.

### Host: Render

Chosen because it takes a Dockerfile directly, has background workers as a first-class service type (matching our API/worker split), and includes managed Postgres with automated backups.

| Render resource | Maps to |
|---|---|
| Web Service (Docker) | `apps/api` — serves the API and the built SPA |
| Background Worker (Docker) | Same image, `npm run worker` |
| Postgres | Managed instance |
| Cron Job | Nightly metrics rollup |

**Alternatives**, in case of a different constraint:

- **Fly.io** — cheaper, closer to the metal, good if we want multi-region later.
- **AWS ECS Fargate + RDS** — if the org mandates AWS. More setup, same containers.
- **Railway** — fastest to stand up; least control.

The Docker images are host-agnostic, so switching is a config change, not a rewrite.

### Migrations

Drizzle Kit migrations run as a release step before new containers take traffic — never on app boot, or two replicas race each other.

---

## Environment variables

```
# Core
NODE_ENV
PORT
DATABASE_URL

# Auth
SESSION_SECRET
SESSION_TTL_HOURS

# AI
ANTHROPIC_API_KEY
ANTHROPIC_MODEL=claude-opus-5

# Email
EMAIL_SOURCE=mock|mailgun
EMAIL_SINK=outbox|mailgun
MAILGUN_API_KEY
MAILGUN_DOMAIN
MAILGUN_SIGNING_KEY          # HMAC verification for inbound webhooks
MAILGUN_INBOUND_ADDRESS      # e.g. support@mg.example.com
```

Secrets come from the host's secret store in production, `.env` (gitignored) locally. `.env.example` is committed with every key present and every value blank.

---

## Testing

| Scope | Tool |
|---|---|
| Unit / integration (API) | Vitest + Supertest |
| Database tests | Testcontainers (real Postgres, not a mock) |
| Frontend | Vitest + Testing Library, MSW for API mocking |
| E2E | Playwright — one happy path: ingest → classify → draft → edit → send |
| AI calls in tests | Recorded fixtures by default; a tagged suite hits the live API |

Threading logic gets its own test file with real multi-message header chains. It's the piece most likely to silently corrupt data.

---

## Open items

- **Mailgun domain setup** — sending needs SPF/DKIM DNS records on a subdomain (`mg.example.com`). Not blocking for V1 since outbound is simulated, but it's lead time worth starting early if V2 goes live.
- **Inbound webhook in local dev** — Mailgun can't reach `localhost`. Use an ngrok tunnel, or stay on `EMAIL_SOURCE=mock` for day-to-day work and test the real route against a staging deploy.
- **Attachments** — the scope doesn't mention them. Mailgun will send them; V1 should record that an attachment existed without storing the payload, so the data model doesn't need reshaping later.
