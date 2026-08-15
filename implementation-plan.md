# Implementation Plan

Companion to [project-scope.md](./project-scope.md) and [tech-stack.md](./tech-stack.md).

Sizes are relative: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

---

## Sequencing principles

Three things shape the phase order:

1. **Prove the risky chain early.** Phase 2 is a walking skeleton — one ticket travelling ingest → classify → draft → screen, with real Claude calls. It is deliberately ugly and deliberately first. Integration problems in an AI pipeline surface as "the schema doesn't hold" or "grounding is useless," and those are cheap in week one and expensive in week five.
2. **Seed data is the long pole.** The knowledge base is synthesized *from* the ticket archive, and the AI has nothing to be evaluated against until both exist. Phase 3 runs as a parallel track starting the moment the schema lands.
3. **The feedback loop ships with the first send button, not after.** Task 7.9 writes `draft_text`, `sent_text`, and edit distance on the very first send path. Per the scope, this is cheap now and expensive to retrofit.

### Critical path

```
P0 Foundations → P1 Domain model → P2 Walking skeleton → P5 Ingestion → P6 AI → P7 Workspace → P10 Deploy
                        └─────────→ P3 Seed corpus & KB ──────────────↗
                        └─────────→ P4 Auth ─────────────────────────↗
```

P3 and P4 are parallel tracks. If two people are on this, one takes the seed corpus and knowledge base end-to-end while the other runs the backend spine.

---

## Phase 0 — Foundations

Goal: `docker compose up` gives a running API, a running SPA, and a Postgres you can migrate against.

| ID | Task | Size | Depends on |
|---|---|---|---|
| 0.1 | npm workspaces skeleton — `apps/web`, `apps/api`, `packages/shared` | S | — |
| 0.2 | Root TypeScript config, path aliases, ESLint + Prettier | S | 0.1 |
| 0.3 | `compose.yaml` — Postgres 17 with named volume and healthcheck | S | — |
| 0.4 | Express 5 skeleton, `/healthz` + `/readyz`, graceful shutdown | S | 0.1 |
| 0.5 | Vite + React 19 + React Router skeleton | S | 0.1 |
| 0.6 | Tailwind + shadcn/ui init, base theme | S | 0.5 |
| 0.7 | Drizzle + Drizzle Kit wiring, empty initial migration | S | 0.3 |
| 0.8 | pino logger, request-ID middleware, central error handler | S | 0.4 |
| 0.9 | Vitest config for `api` and `web`; one passing test each | S | 0.1 |
| 0.10 | CI: typecheck → lint → test on push | S | 0.9 |

**Exit:** clean checkout to running stack in one command; CI green.

---

## Phase 1 — Domain model

Goal: the schema every later phase writes against, with the threading and feedback columns already present.

| ID | Task | Size | Depends on |
|---|---|---|---|
| 1.1 | Shared enums + Zod schemas: status, category, priority, queue, role | S | 0.2 |
| 1.2 | `users` and `session` tables | S | 0.7 |
| 1.3 | `tickets` — status, category, priority, queue, assignee, timestamps | M | 1.1 |
| 1.4 | `messages` — direction, body, `message_id`, `in_reply_to`, `references[]` | M | 1.3 |
| 1.5 | `raw_inbound_payloads` — untouched provider body, keyed to message | S | 1.4 |
| 1.6 | `kb_articles` — title, body, tags, `tsvector` generated column | S | 1.1 |
| 1.7 | `reply_drafts` — model output, cited article IDs, confidence | S | 1.3 |
| 1.8 | `outbound_messages` — `draft_text`, `sent_text`, `edit_distance`, `edit_bucket` | M | 1.7 |
| 1.9 | `ai_calls` — job, model, effort, tokens, cache hits, latency, cost | S | — |
| 1.10 | Indexes: list-view filter/sort composite, GIN on KB `tsvector`, message-ID lookup | M | 1.4, 1.6 |
| 1.11 | Migration runner script + idempotent seed harness | S | 1.10 |

**Exit:** migrations apply cleanly from scratch; a hand-inserted ticket with a two-message thread reads back correctly.

**Watch:** get `messages.message_id` unique and indexed now. Threading performance and correctness both hang off it.

---

## Phase 2 — Walking skeleton

Goal: one ticket, one real Claude call, one thing on screen. Throwaway UI is fine. Nothing here is reusable except the confidence it buys.

| ID | Task | Size | Depends on |
|---|---|---|---|
| 2.1 | Anthropic client wrapper, `claude-opus-5`, env-configured | S | 0.4 |
| 2.2 | Classification JSON schema via `output_config.format` + Zod mirror | M | 1.1, 2.1 |
| 2.3 | Hardcoded single-ticket ingest script → row in `tickets` | S | 1.11 |
| 2.4 | Classify that ticket, persist category/priority/queue/confidence | M | 2.2, 2.3 |
| 2.5 | Naive KB retrieval + draft one reply, capture cited article IDs | M | 2.4 |
| 2.6 | Bare `/tickets/:id` page rendering thread, classification, draft | M | 0.5, 2.5 |

**Exit:** you can point at a browser and watch an email become a classified, drafted ticket.

**Decide here, before Phase 6 builds on it:** does the structured-output schema hold under messy real-world tickets? Is retrieval returning anything a draft can actually stand on? Is `effort: "low"` good enough for classification? Cheap answers now.

---

## Phase 3 — Seed corpus & knowledge base *(parallel track)*

Goal: ~150 tickets and a coherent KB, both good enough to evaluate against. Start as soon as Phase 1 lands.

| ID | Task | Size | Depends on |
|---|---|---|---|
| 3.1 | Write the domain brief — bootcamp name, courses, policies, staff, tone | M | — |
| 3.2 | Generation script: Claude → ticket JSON, batched by category | M | 3.1, 2.1 |
| 3.3 | Generate the corpus — realistic mix, varied tone, correct category balance | L | 3.2 |
| 3.4 | Multi-message threads: replies, follow-ups, student-goes-quiet cases | M | 3.3 |
| 3.5 | Edge cases the AI should decline: legal threats, refund disputes, off-topic, abusive | M | 3.3 |
| 3.6 | Human review pass; commit fixtures as version-controlled JSON | M | 3.4, 3.5 |
| 3.7 | Hand-label a ~40-ticket holdout set for evaluation | M | 3.6 |
| 3.8 | Idempotent seed loader → tickets + messages with valid header chains | M | 3.6, 1.11 |
| 3.9 | KB synthesis script: cluster the archive → draft articles | M | 3.6 |
| 3.10 | Review and edit KB articles; commit and load | M | 3.9 |

**Exit:** `npm run seed` produces a database that looks like a real support queue on a busy Tuesday.

**Watch:** 3.7 is the task everyone skips. Without a labeled holdout you cannot tell whether a prompt change helped or hurt, and you will make prompt changes.

---

## Phase 4 — Auth & authorization *(parallel track)*

| ID | Task | Size | Depends on |
|---|---|---|---|
| 4.1 | argon2id hashing helpers + user creation service | S | 1.2 |
| 4.2 | `express-session` + `connect-pg-simple`, hardened cookie flags | S | 1.2 |
| 4.3 | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | S | 4.1, 4.2 |
| 4.4 | `requireAuth` and `requireRole` middleware | S | 4.3 |
| 4.5 | CSRF double-submit token on mutating routes | S | 4.2 |
| 4.6 | Session revocation (admin ends an agent's sessions) | S | 4.2 |
| 4.7 | Frontend auth context, protected routes, login page | M | 0.5, 4.3 |
| 4.8 | Auth integration tests incl. role-denial paths | M | 4.4 |
| 4.9 | Seed an admin + a few agents | S | 4.1 |

**Exit:** an agent cannot reach an admin route by any path, and there is a test proving it.

---

## Phase 5 — Ingestion pipeline

| ID | Task | Size | Depends on |
|---|---|---|---|
| 5.1 | `EmailSource` / `EmailSink` interfaces in `packages/shared` | S | 1.1 |
| 5.2 | pg-boss install, schema, worker entrypoint separate from API | M | 1.11 |
| 5.3 | `MockSource` replaying committed fixtures | S | 5.1, 3.8 |
| 5.4 | Threading resolver: `in_reply_to` → `references` → new ticket | L | 1.4, 5.1 |
| 5.5 | Threading test suite with real multi-hop header chains | M | 5.4 |
| 5.6 | `ingest-email` job — thread or create, persist, enqueue AI jobs | M | 5.2, 5.4 |
| 5.7 | Reopen rule: `resolved` → `open` when a student replies | S | 5.6 |
| 5.8 | Store raw payload before parsing | S | 1.5, 5.6 |
| 5.9 | `MailgunSource` — normalize inbound payload to `InboundEmail` | M | 5.1 |
| 5.10 | `POST /webhooks/email/inbound` — HMAC verify, stale-timestamp reject, fast 200 | M | 5.9 |
| 5.11 | `OutboxSink` (default) and `MailgunSink` (flag-gated, unwired) | M | 5.1 |
| 5.12 | `EMAIL_SOURCE` / `EMAIL_SINK` config switching + startup validation | S | 5.10, 5.11 |
| 5.13 | Idempotency: replayed provider message never double-creates | M | 5.6 |

**Exit:** replaying the fixture corpus through the mock source produces correctly threaded tickets, and re-running it changes nothing.

**Watch:** 5.4 and 5.5 are the highest-risk correctness work in the project. Mis-threading corrupts data silently and is painful to unwind. Budget real time; resist subject-line shortcuts.

---

## Phase 6 — AI pipeline

Promotes the Phase 2 spike into something durable.

| ID | Task | Size | Depends on |
|---|---|---|---|
| 6.1 | Harden the client wrapper: timeouts, retries with backoff, typed errors | M | 2.1 |
| 6.2 | `ai_calls` logging on every call — tokens, cache hits, latency, cost | M | 1.9, 6.1 |
| 6.3 | Prompt assembly with a stable cached prefix and volatile content last | M | 6.1 |
| 6.4 | Verify caching via `usage.cache_read_input_tokens`; fix invalidators | S | 6.3 |
| 6.5 | `classify-ticket` job — category, priority, queue, confidence, `needsHuman` | M | 2.2, 5.6 |
| 6.6 | Low-confidence routing → `Other / Needs Human`, flag on the ticket | S | 6.5 |
| 6.7 | `summarize-thread` job, triggered only above a message-count threshold | M | 5.6 |
| 6.8 | `KnowledgeRetriever` interface + `tsvector` implementation | M | 1.6, 3.10 |
| 6.9 | `draft-reply` job grounded in retrieved articles, returning cited IDs | L | 6.8, 1.7 |
| 6.10 | Decline path: AI produces no draft and says why | M | 6.9 |
| 6.11 | Job failure states — surface "classification failed," never fail silently | M | 6.5, 6.9 |
| 6.12 | Effort sweep across `low`/`medium`/`high` per job; record results | M | 6.2, 3.7 |
| 6.13 | Eval harness: run classifier over the holdout, report per-category accuracy | L | 3.7, 6.5 |

**Exit:** the full seeded corpus classifies and drafts in one batch run, with a number attached to how good it is.

**Watch:** 6.13 turns prompt tuning from taste into measurement. Build it before you start tuning, not after.

---

## Phase 7 — Agent workspace

| ID | Task | Size | Depends on |
|---|---|---|---|
| 7.1 | App shell — nav, layout, error boundary, toasts | M | 4.7 |
| 7.2 | TanStack Query setup, query-key conventions, error handling | S | 7.1 |
| 7.3 | `GET /tickets` — filter, sort, cursor pagination | M | 1.10, 4.4 |
| 7.4 | Ticket list UI with TanStack Table | L | 7.2, 7.3 |
| 7.5 | Filter controls — status, category, priority, assignee, age | M | 7.4 |
| 7.6 | `GET /tickets/:id` — thread, classification, summary, draft, sources | M | 7.3 |
| 7.7 | Thread view — inbound/outbound, timestamps, sender | M | 7.6 |
| 7.8 | AI panel — summary, classification, confidence, needs-human badge | M | 7.6 |
| 7.9 | Draft editor + **send flow capturing draft, final text, edit distance, bucket** | L | 7.8, 1.8, 5.11 |
| 7.10 | Cited-source display linking into the KB | S | 7.8 |
| 7.11 | Status transitions with legal-move enforcement server-side | M | 7.6 |
| 7.12 | Assignment — self-assign and assign-to-agent | M | 7.11 |
| 7.13 | Empty, loading, and error states throughout | M | 7.4, 7.6 |
| 7.14 | Poll or invalidate on interval so new tickets appear without a refresh | S | 7.2 |

**Exit:** an agent can work a queue start to finish without touching the database.

**Watch:** 7.9 carries the feedback loop. Compute the edit bucket on write — bucketing at send time makes the Phase 8 dashboard a `GROUP BY` instead of a per-row diff over the whole history.

---

## Phase 8 — Feedback loop & measurement

| ID | Task | Size | Depends on |
|---|---|---|---|
| 8.1 | Time-to-first-response computation | M | 7.9 |
| 8.2 | Time-to-resolution computation, handling reopens | M | 7.11 |
| 8.3 | Volume by category and priority over time | M | 1.10 |
| 8.4 | Draft acceptance rate — unedited / light / heavy / discarded | M | 7.9 |
| 8.5 | Nightly rollup job into a metrics table | M | 5.2, 8.3 |
| 8.6 | `GET /metrics` with a date-range parameter | S | 8.5 |
| 8.7 | Dashboard UI with Recharts | L | 8.6, 7.1 |
| 8.8 | AI cost/usage panel sourced from `ai_calls` | M | 6.2 |

**Exit:** you can answer "is the AI getting better or just different" with a chart.

---

## Phase 9 — Admin

| ID | Task | Size | Depends on |
|---|---|---|---|
| 9.1 | `GET/POST/PATCH /admin/users`, admin-gated | M | 4.4 |
| 9.2 | User management UI — create agent, set role, deactivate | M | 9.1, 7.1 |
| 9.3 | KB article CRUD API | M | 1.6, 4.4 |
| 9.4 | KB list and editor UI | L | 9.3 |
| 9.5 | Re-index on KB save so retrieval reflects edits immediately | S | 9.3, 6.8 |
| 9.6 | Admin ticket dashboard — all tickets, bulk reassign | M | 7.4 |

**Exit:** an admin can fix bad grounding by editing an article and see the next draft improve.

---

## Phase 10 — Deploy & harden

| ID | Task | Size | Depends on |
|---|---|---|---|
| 10.1 | Multi-stage `Dockerfile.api` — non-root, prod deps, `dumb-init` | M | 0.4 |
| 10.2 | Frontend build served by the API or a CDN | S | 0.5 |
| 10.3 | Worker as a separate service on the same image, different command | S | 5.2, 10.1 |
| 10.4 | Render services: web, worker, Postgres, cron | M | 10.1, 10.3 |
| 10.5 | Migrations as a release step, never on boot | S | 10.4 |
| 10.6 | Secrets wiring; `.env.example` complete with blank values | S | 10.4 |
| 10.7 | Playwright E2E: login → list → detail → edit draft → send | L | 7.9 |
| 10.8 | Rate limiting on auth and webhook routes | S | 5.10 |
| 10.9 | Structured error reporting and alerting on job failures | M | 6.11 |
| 10.10 | Load check: batch-classify the corpus, confirm workers hold up | M | 10.3 |
| 10.11 | Runbook — stuck jobs, replay ingestion, rotate keys, restore | M | 10.4 |

**Exit:** a deployed V1 an agent can log into, and a document telling the next person how to keep it running.

---

## Deferred to V2

Tracked here so they don't creep in: student portal, auto-send, live outbound delivery, SLA rules and breach alerting, multi-language, mobile, `pgvector` semantic retrieval, and attachment storage.

---

## Open questions to resolve before the phase that needs them

| Question | Needed by |
|---|---|
| Are the eight scope categories final, or should the seed corpus test alternatives? | 3.3 |
| What confidence threshold routes to `Needs Human`? Pick a starting number, tune with 6.13. | 6.6 |
| How many KB articles is "enough" — one per recurring theme, or per policy? | 3.9 |
| Do we store attachment metadata in V1 even though we don't store payloads? | 1.4 |
| Which edit-distance thresholds separate light from heavy edits? | 7.9 |
