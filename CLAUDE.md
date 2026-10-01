# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

**Bun, not Node/npm.** Everything runs through `bun` — the Postgres driver is Bun's native `SQL` class, and workspace deps use `workspace:*`. The one exception is **pg-boss**, which runs its own `pg` pool against the same database because Bun's driver cannot bind array parameters — see Classification. TypeScript is executed directly; there is no build step in dev. The exception is test runners: `bun:test` for `apps/api` and `packages`, **Vitest for `apps/web`** (React components), Playwright for `e2e`. See Testing below.

## Commands

Run from the repo root unless noted.

```bash
bun run dev            # API (:3000) + Vite (:5173) together
bun run dev:api        # either half on its own
bun run dev:web

bun run check          # typecheck → lint → test → test:web; run before finishing work
bun run typecheck      # tsc --noEmit across all three workspaces
bun run lint           # eslint . (lint:fix to autofix)
bun run format         # prettier --write .
bun run test           # bun:test — apps/api + packages
bun run test:web       # Vitest — apps/web component tests

docker compose up -d postgres   # dev Postgres; api/web run on the host
bun run db:generate    # drizzle-kit generate after a schema change
bun run db:migrate
bun run db:studio
bun run seed:admin     # -- --email=… --password=… --name=… --role=admin|agent
bun run email:send     # deliver a fixture email to the running API -> one ticket
                       # -- --from=… --from-name=… --subject=… --text=… --category=…
bun run seed:tickets   # load the 100-ticket corpus (needs `bun run dev:api` up)
                       # -- --reset      to clear the table first; idempotent otherwise
                       # -- --classify   let the AI classifier see them (off by default)
                       # the auto-resolver never sees them, and has no opt-in flag
bun run seed:replies   # put a 20-message conversation on one ticket
                       # -- --ticket=<uuid> [--agent=<email>] [--reset]
bun run reset:password # set a staff password out of band (forgotten admin)
                       # -- --email=… --password=…

bun run e2e:install    # one-time: download the Chromium build
bun run db:up:test     # test Postgres on :5433 (see below)
bun run test:e2e       # Playwright; starts its own API :3001 + Vite :5174
bun run test:e2e:ui    # same, in the Playwright UI
bun run db:down:test   # stop it; db:reset:test to wipe and rebuild
```

`bun run check` is deliberately unit-only. E2E needs a database and two servers, so
it is a separate gate — run `bun run test:e2e` when you touch auth, routing, or the
API/SPA contract. New Playwright specs go through the **`e2e-test-writer` agent** — see
the E2E section under Architecture.

### Running a single test

The root `test` script strips `DATABASE_URL` and `BETTER_AUTH_SECRET` so the suite can never touch a real database. Mirror that when running a subset, or the stubbed-auth tests will behave differently than in CI:

```bash
env -u DATABASE_URL -u BETTER_AUTH_SECRET bun --env-file=/dev/null test apps/api/src/app.test.ts
env -u DATABASE_URL -u BETTER_AUTH_SECRET bun --env-file=/dev/null test -t "reopen"
```

The root `test` script also ends in `test apps/api packages`, and that path filter is load-bearing twice over: Bun's runner globs `*.test.ts`/`*.spec.ts` repo-wide, so a broader filter collects the Playwright specs under `e2e/` and dies on `import … from "@playwright/test"`, and it collects `apps/web`'s component tests and dies on `import … from "vitest"`. Keep new `bun:test` files inside `apps/api/` or `packages/`.

### Component tests (`apps/web`) run on Vitest

The SPA is the one workspace `bun test` does not own. React components need a DOM
and the `@/…` alias, both of which Vitest gets from the Vite pipeline the app
already builds with — under `bun:test` the same setup needs a `bunfig.toml`
preload that registers happy-dom *and* puts Bun's native `fetch` back, or the
`apps/api` tests lose the real `fetch` they use against an ephemeral listener.

- Config is `apps/web/vitest.config.ts`, kept separate from `vite.config.ts` so a
  test run can never be steered by `API_PROXY_TARGET`. Its
  `include: ["src/**/*.test.{ts,tsx}"]` is the other half of the three-runner
  boundary described above.
- `environment: "happy-dom"`; `unstubGlobals` + `restoreMocks` clean up per test.
- Run one file or one name: `cd apps/web && ./node_modules/.bin/vitest run src/routes/UsersPage.test.tsx`, or `-t "role=agent"`. No env stripping needed — no test here touches a database.
- **`renderWithQuery` (`apps/web/src/test/render-with-query.tsx`) is the entry point.** It mounts the component under a throwaway `QueryClient` with `retry: false`. A fresh client per call is the point: React Query caches by key, so a shared one leaks a resolved page into the next test and makes the pending state unassertable.
- Stub `fetch`, not `lib/api.ts`. Responses then still go through the `@helpdesk/shared` Zod schemas, so a contract drift fails the test the way it fails in the browser — see `UsersPage.test.tsx` for the queue-of-responders pattern, including the gated response that makes the loading state deterministic.

`bun run dev` and the db/seed scripts load `../../.env` explicitly (`bun --env-file=../../.env`); a bare `bun src/…` from `apps/api` will not see it.

## The planning docs are not the code

`project-scope.md`, `tech-stack.md`, and `implementation-plan.md` describe intent and are worth reading for *why* — but several decisions were made differently during implementation. Trust the code:

| Docs say | Actually |
|---|---|
| npm workspaces, Node 22 | Bun workspaces, Bun runtime |
| `express-session` + `connect-pg-simple` + argon2 | **Better Auth** with the Drizzle adapter |
| Vitest + Supertest | `bun:test` + `fetch` against a real ephemeral listener for the API; Vitest only for `apps/web` components |
| shadcn/ui on Radix | shadcn/ui on **Base UI** (`@base-ui/react`) |
| React Router 7 | React Router 8 |

The implementation plan's phase numbering is still the shared vocabulary — code comments reference "Phase 6" and "Phase 7" to mark deliberate placeholders. Current state is roughly Phase 0 complete, Phase 4 (auth) landed early, and the plain half of Phase 5 (email → ticket) landed after it: `db/schema.ts` re-exports the auth tables plus `ticket`, `GET /api/tickets` reads real rows, and there is no email *provider*. Two pieces of background work run off the back of ingestion — the automatic classifier and the automatic resolver — both on **pg-boss**, a job queue inside the same Postgres, worked by the API process itself rather than by a separate worker deployment; see Classification and Auto-resolution below.

The domain vocabulary was cut down when ingestion landed, and `packages/shared/src/domain.ts` no longer matches project-scope.md: statuses are `open | resolved | closed` (no `new`, no `pending`) and categories are `general_questions | technical | refund_request`. The short category list is now load-bearing in a second way: it is the closed set the classifier picks from, and `classify-ticket.ts` builds its prompt out of `TICKET_CATEGORIES` so a fourth category is offered to the model in the same commit that makes the column able to hold it. `TICKET_PRIORITIES` and `ROUTING_QUEUES` are still there, consumed by nothing, as the shape a later phase grows into.

## Architecture

Four workspaces: `apps/api` (Express 5), `apps/web` (React 19 SPA), `packages/shared`, and `e2e` (Playwright).

### `packages/shared` is the contract

Consumed as **source**, not built — `main` points at `src/index.ts`. It holds the domain enums (`TICKET_STATUSES`, `USER_ROLES`, categories) and every request/response Zod schema. Both sides import it, and both sides *use* it at runtime: the API parses query strings with `listTicketsQuerySchema` and the SPA parses responses with `listTicketsResponseSchema` (`apps/web/src/lib/api.ts`). A contract change is therefore a type error at build time and a loud throw at runtime, not a silent `undefined`. Add new API shapes here rather than inline.

### The API boots without Postgres, and fails closed

`getDb()` returns `Database | undefined` — `DATABASE_URL` is optional by design so `/readyz` can report `degraded` instead of the process crash-looping. Consequences that propagate through the codebase:

- `createAuth(db)` and `requireAuth(auth)` are **factories taking the handle**, not module-level singletons. Keep new db-dependent modules in that shape.
- With no database there is no auth instance, so `requireAuth` answers 401 to everything rather than waving requests through.
- `createApp({ auth })` accepts an injected auth instance purely as a test seam; `createApp({ jobs })` is the same seam for the background queues, and how `index.ts` hands ingestion the instance it reconciles against.

### Middleware order in `app.ts` is load-bearing

`helmet` → `cors` → `requestContext` → **Better Auth mount** → `express.json()` → health routes → **inbound-email router** → `requireAuth` + app routes → 404 → error handler.

Better Auth reads the raw request body itself, so its `app.all("/api/auth/*splat", …)` mount **must stay above `express.json()`** or auth requests hang. Express 5 rejects a bare `"*"` — hence the named splat. The 404 and error handlers must stay last, and `errorHandler` must keep all four parameters (Express identifies error middleware by arity).

The inbound-email router is the one app router above `requireAuth`, because a mail source has no session — see Ingestion below. It is mounted at `"/api"` with a path (`/inbound-email`) inside it, not pathlessly, so every other `/api/*` request still falls through to the guarded routers and on to `notFoundHandler` — the same trap `requireRole` documents.

Express 5 forwards rejected promises from async handlers to the error handler, so route handlers throw `HttpError.badRequest(…)` / let `ZodError` escape rather than wrapping themselves in try/catch. Every response carries an `x-request-id`, echoed into error bodies.

### Auth

Staff-only console: students never log in. Sessions live in the `session` table (no `cookieCache`, no `secondaryStorage`) specifically so an admin can revoke access with a `DELETE`.

- **HTTP sign-up is closed** via `databaseHooks.user.create.before` in `apps/api/src/auth.ts`, which throws when `ctx.request` exists. `disableSignUp` is deliberately not used because it would also block in-process `auth.api.signUpEmail()`, leaving no way to create the first user. In-process calls have no `ctx.request`, which is the seam `seed.ts` uses.
- **`role` is `input: false`**, so no HTTP payload can grant `admin`. `seed.ts` sets the role with a direct `UPDATE` after sign-up.
- `seed.ts` is idempotent and **never changes an existing account's password** — re-running only corrects the role. Overwriting one is a deliberate act, so it has its own command rather than a flag here: `bun run reset:password -- --email=… --password=…` (`apps/api/src/dev/reset-password.ts`).
- **`reset:password` is the way back in when the last admin forgets theirs.** There is no reset *in the console*, and deliberately: no mail provider means no reset link, and an unauthenticated reset endpoint without one is a way to lock people out rather than a way in. `PATCH /api/users/:id` is the in-app answer and it is admin-gated, which leaves exactly one hole — the last admin — and nobody left to reach the route that fixes it. So the way back in is the way the first account was made: in-process, from a shell on the machine holding the database, which is the same trust boundary `seed.ts` already runs on. It calls `setStaffPassword` from `routes/users.ts` rather than hashing its own — two implementations of a password write is one that silently stops matching the login form — and it deletes the account's sessions for the same reason that route does. It **refuses a soft-deleted account** instead of writing anyway: `databaseHooks.session.create.before` turns one away at sign-in whatever its password is, so a write there would report success and change nothing observable.
- **`POST /api/users` is the second door**, and the only one over HTTP: admin-gated, and it reaches Better Auth through the same in-process seam (`auth.api.signUpEmail({ body })` with no `headers`/`request` — forwarding the Express `req` would trip the gate above and answer "Sign up is disabled"). Accounts it creates are always `agent`, because `role` is `input: false`. Two consequences worth knowing before touching it: `emailAndPassword.autoSignIn` must stay on, since turning it off switches Better Auth's duplicate-email reply to a *synthetic* user and the route would report success while creating nothing; and because it is on, sign-up writes a session row for an account nobody has signed into, which the route deletes to keep "a session row means someone is signed in" true.
- **`PATCH /api/users/:id` edits one**, admin-gated the same way. Name and email are plain columns and are written with Drizzle; the password is not, and goes through `auth.$context` (`password.hash` + `internalAdapter.updatePassword`, creating the `credential` row if one is somehow missing). That mirrors what Better Auth's admin plugin does in `setUserPassword` — mirrored rather than adopted, because enabling that plugin to reach one function would also mount `/api/admin/*`: set-role, ban, impersonate. Three things about it are load-bearing. **A blank or whitespace-only password means "leave it alone"**, normalised to `undefined` by `updateUserBodySchema` so the route has one case to branch on. **A password change deletes the target's session rows**, including the admin's own when they edit themselves — otherwise resetting a compromised account leaves the intruder holding a valid multi-day cookie, and no `cookieCache` is exactly what makes deleting rows sufficient. **The two writes are not atomic** (Better Auth's adapter holds its own handle), so the row is written *first*: a failed password write leaves a retryable state, whereas the reverse order could answer a duplicate-email 409 after the password had already changed.
- **`DELETE /api/users/:id` is a soft delete**, admin-gated, and **admin accounts are exempt** — the route answers 403 for a target whose role is `admin`, which is the actual rule; the SPA merely omits the button. The row survives because `session` and `account` cascade from it and because past work — a reply's byline, a resolved ticket — still has to name whoever did it. Ownership is the part that does not survive: the same transaction clears `ticket.assigned_to_id` for every ticket the account owned, because an assignee is a claim on work nobody is going to do once its owner cannot sign in. Three things enforce what "deleted" means, and all three are load-bearing: every read in `routes/users.ts` carries `isNull(user.deletedAt)` (so a marked row is unlistable *and* uneditable), `databaseHooks.session.create.before` in `auth.ts` refuses the account a new session, and `requireAuth` refuses one that still holds an old one. Guarding `/sign-in/email` instead of the session insert would have left every future credential or social route open by default. The hook throws Better Auth's own `INVALID_EMAIL_OR_PASSWORD` verbatim so a deleted account is indistinguishable from a wrong password. Unlike PATCH's password write, all three statements here are Drizzle's, so they share a **transaction** — marking the row without clearing sessions would leave a deleted account signed in until its cookie expired, and releasing the tickets without marking the row would hand a working account's queue away.
- **`deletedAt` is declared in `auth.ts` as a `user.additionalFields` entry, not added to `db/auth-schema.ts`.** That file is generated; a hand-added column disappears the next time anyone regenerates it. Declaring the field is what makes `@better-auth/cli generate` emit it, and it is `input: false` so no payload can set or clear it. The regeneration added exactly one line. It also means `deletedAt` rides along on the session user, which is what lets `requireAuth` check it.
- **A deleted user keeps its email.** `user.email` is still UNIQUE, so the address stays reserved and re-creating that person fails — `emailConflict` in `routes/users.ts` answers "That email belongs to a deleted user" rather than the generic duplicate message, because otherwise an admin is told an address is taken by someone who appears in no list. There is no restore path; adding one is the natural way to make the address reachable again.
- **Email is stored lowercased, and that is load-bearing.** Better Auth lowercases the address at sign-up and its `findUserByEmail` lowercases the address it is *given* before comparing it to the column, so a row whose email carries a capital is unreachable by every sign-in — and a password reset does not recover it, because the lookup fails before a password is checked. Creating a user goes through Better Auth and is normalised for free; `PATCH /api/users/:id` writes the column directly and is not, so the `.toLowerCase()` lives on the shared `email` field in `packages/shared/src/api.ts`, where both routes and both forms pick it up. `packages/shared/src/api.test.ts` pins it. Anything else that writes `user.email` directly must normalise too.
- **A unique-violation from Drizzle is not the driver's error.** Drizzle wraps it in a `DrizzleQueryError` and keeps the original on `cause`, so `isDuplicateEmail` in `routes/users.ts` walks the cause chain to find Bun's `errno` (the SQLSTATE — `code` is Bun's own constant and the same for every failure) and the constraint name. Reading those off the thrown object alone passes a driver-level probe and turns every duplicate email into a 500; `routes/users.test.ts` pins it, since no test with a stubbed database can.
- `apps/api/src/db/auth-schema.ts` is generated by `@better-auth/cli generate` through `auth.cli.ts` — never hand-edit it. Hand-written domain tables live beside it in `ticket-schema.ts`; `db/schema.ts` re-exports both so `drizzle.config.ts` and `drizzle({ schema })` see one file.
- A `better-auth-best-practices` skill is available in `.claude/skills/` (symlinked from `.agents/skills/`).

### Ingestion — email becomes a ticket

`POST /api/inbound-email` is the whole of it. One delivered email becomes one `ticket` row, synchronously, and there is no broker to run beside Postgres. Two pg-boss jobs are sent after the response — never inside the request — one to classify the ticket and one to try to answer it from the knowledge base. See Classification and Auto-resolution below. The `ticket_reply` table beside it holds the *outbound* half — see Replies below — and is not an inbound message table: a student's reply still opens a new ticket.

- **It is the API's only unauthenticated write, and necessarily so.** Whatever delivers the mail — a provider webhook, a forwarding script, `bun run email:send` — holds no session and never will. It is mounted at `/api` *above* `requireAuth` in `app.ts` for that reason, and `INBOUND_EMAIL_SECRET` presented as `x-inbound-secret` stands in for the session. That secret is optional in development (a local `curl` should not need a ceremony) and `env.ts` refuses to boot in production without one, exactly like `BETTER_AUTH_SECRET`. The comparison lives in the exported pure function `isAuthorizedSource` because `env` is parsed once at import — a test cannot configure a secret and then make a request against it, so the guard has to be reachable some other way, and an untested guard on the one open write is not worth having.
- **`inboundEmailBodySchema` is the provider seam, not a provider payload.** It is the small intersection every provider can produce; a Mailgun or SES adapter's entire job becomes mapping its webhook onto this shape and posting it, so nothing downstream ever sees a provider-shaped object. It is `strictObject` for a sharper reason than the user writes: a plain `z.object` strips unknown keys, so an adapter that spelled the body `bodyText` would have the email's contents silently dropped and still be answered 201.
- **`SUPPORT_EMAIL` is enforced, not decorative.** The route answers 422 `wrong_recipient` for mail addressed elsewhere, which is what keeps this from being an open "create a ticket about anything" endpoint. Both sides are lowercased — the schema's `to` field and `env.ts`'s value — or a provider that capitalises the address would have every delivery refused.
- **`source_message_id` is UNIQUE, and that is the idempotency.** Insert is `onConflictDoNothing` on that column, in one statement: a provider retrying a slow webhook is the normal case, and SELECT-then-INSERT would lose that race. A conflicting delivery is answered **200 with the existing ticket** rather than 409 — the mail *was* accepted, the first time. `messageId` is optional because not every source has one, and Postgres treats NULLs as distinct under a unique index, so unidentified mail is simply never deduplicated rather than colliding with the last such row.
- **`student_name` is nullable and is never an identity.** It is the display name half of `From: "Ada Student" <ada@example.com>`, and splitting the header is the *adapter's* job — RFC 5322 allows quoted strings, escapes and RFC 2047 encoded words in there, and a regex over the raw header does not belong in a package the browser also imports. Null for mail that carried a bare address and for every ticket ingested before the column existed, so a renderer must always fall back to `student_email` — which is the column `ticket_student_email_idx` groups by, because two people can share a display name and one person can change theirs between emails.
- **`category` is nullable and the route itself still infers nothing.** A source that genuinely knows (a category-specific alias, a web form) may state one, and that is the only way a category is set before the 201. Everything else is left to the background classifier, which writes to the same nullable column after the fact and may decline — so null stays the honest arrival state, and a default would still be a guess indistinguishable from a decision. The SPA renders the null as "unclassified", or "classifying…" while an answer is outstanding.
- **`x-skip-classification: 1` turns the classifier off for one delivery**, and is a header rather than a field on `inboundEmailBodySchema` because that schema is the provider seam and a flag about our own background work has no business in it. It exists for bulk replay: `bun run seed:tickets` sets it, because the corpus's ~18% unclassified tail is data the category sort is checked against and filling it in would cost a model call per fixture to destroy the property — differently on every run, since a model is not a fixture. `--classify` opts back in.
- **`ticket` timestamps are `timestamptz`**, unlike the generated auth tables, which are not. The list pages on `created_at`/`updated_at` with a keyset cursor, and the driver round-tripping a naive timestamp through the host's local offset would silently skip or repeat rows at every page boundary. `received_at` is separate from `created_at` on purpose: replaying an archive must not make every ticket look like it arrived today.
- **Ticket sorting is server-side, and `routes/ticket-sort.ts` is the whole of it.** One `SORTS` table holds, per `TicketSortKey`, the SQL expression, whether it is nullable, how to read a cursor value off a row, and how to bind one back. The ORDER BY and the keyset predicate are built from the *same* expression — they have to be, or the two queries that make up a page boundary disagree about where it was. Four things there are load-bearing:
  - **Search (`?q=`) is a filter, not a mode.** It joins `status` and `category` in the one `filters` predicate, which is what keeps `total` — and therefore the page counter — describing the queue the reader is actually looking at. It matches with `ilike` across the subject, sender name, sender email **and body**; the body is included so "the one about the double charge" is findable when that phrase only ever appears inside the email, at the cost of results whose row shows nothing explaining the match. Highlighting is the fix, and it wants a ticket detail view first. `ilike` rather than `lower() like lower()` because it is the form a `pg_trgm` GIN index can serve later; today it scans, deliberately.
  - **The search term is escaped before it reaches LIKE** (`searchPattern` in `routes/tickets.ts`, exported only so `tickets.test.ts` can pin it). Unescaped, a `%` in the box matches every ticket and `_` matches any character — results unrelated to what was typed, with nothing to signal it. The backslash is escaped *first*, or escaping `%` into `\%` would have its own escape character escaped afterwards and undone. Blank is normalised to `undefined` in the shared schema so `?q=` cannot reach the route as a search for nothing.
  - **`total` rides along on every list response**, counted with the same filters as the page and *without* the cursor. It costs a second query per request, which cursor pagination partly exists to avoid, and it is there because "Page 3 of 10" cannot be derived from a cursor — a cursor knows whether a next page exists, never how many follow. Build the filter predicate once and pass it to both queries: a count that sees different filters than the page is a counter that lies.
  - **The cursor is a `[value, id]` JSON pair, base64url'd**, unlike the user list's single email — no sortable column is unique, and without the `id` tiebreaker two tickets sharing a status come back in whatever order the plan produced, which is how keyset pagination drops and repeats rows. JSON rather than `value|id` because a subject is user-supplied text and may contain the separator.
  - **`sender` sorts on `coalesce(student_name, student_email)`** — the same fallback the cell renders, so the column sorts the way it reads. Sorting the raw `student_name` would gather every nameless sender into one block.
  - **A nullable sort column (`category`, the only one) leads its ORDER BY with `IS NULL`**, so unclassified is the tail in *both* directions rather than flipping to the head on desc, and its keyset predicate carries an explicit `IS NULL` branch. The plain row-value tuple is wrong twice over there and both are silent: a NULL makes the comparison NULL rather than false, so the tail is unreachable and page two just ends early; and once the cursor is *inside* the tail there is no value left to compare.
  - **`ticket` timestamps are `precision: 3`.** Postgres defaults to microseconds and a JS `Date` holds milliseconds, so without it the driver truncates on read and a cursor lands a hair below the row it names — invisible descending, an infinite one-row loop ascending. `routes/ticket-sort.test.ts` pins both the column type and the round-trip.
- **The seeded corpus is 100 committed fixtures, delivered over HTTP.** `dev/ticket-fixtures.ts` holds them and `dev/seed-tickets.ts` posts each one to `POST /api/inbound-email` with a deterministic Message-ID, so a rerun is idempotent by the same unique index a retrying provider hits. It then writes `created_at`, `updated_at` and `status` **directly**, which is the one place anything reaches around the API: ingestion stamps `created_at` with the row default and every ticket is born `open`, and the corpus predates `PATCH /api/tickets/:id` — without the fix-up all hundred tickets would have been created this afternoon and none would ever have been resolved, which makes the date sort and the status filter impossible to check by eye. That route now takes `status`, so the status half *could* move — but it would be 100 extra HTTP round trips and the timestamps would still need the direct write, so the one statement stays. It does mean the seeded statuses bypass `canTransition`, which is deliberate: the corpus needs closed tickets that were never walked through a lifecycle.
- **The corpus's spread is load-bearing, and `dev/ticket-fixtures.test.ts` pins it.** Subjects start across the whole alphabet, senders repeat and nine carry no display name, ~18% are unclassified, statuses skew with age, and `daysAgo` is irregular with a few same-day collisions. Each of those exists because a corpus that is uniform in one column makes that column's sort look broken rather than look sorted — the same-day rows, for instance, are the only thing that exercises the cursor's id tiebreaker from the UI.
- **`apps/api/src/dev/send-inbound-email.ts` is the only source there is.** It posts the same normalised payload a real adapter would, to the same endpoint, so it exercises the real path rather than a test double — which is why there is no `EmailSource` interface yet: it would describe an integration nobody has written.

### Classification — the category fills itself in, after the response

`apps/api/src/ai/classify-ticket.ts` (the prompt) and
`apps/api/src/ticket-classification.ts` (when it runs, on **pg-boss**). One
delivered email goes to a model and comes back as one of the three categories,
or as nothing. There is no button and no route: it is a consequence of
ingestion.

- **It is non-blocking, and the ordering is the feature.** `POST
  /api/inbound-email` writes the row, answers 201 in tens of milliseconds, and
  *then* sends a pg-boss job. A model call takes seconds and is allowed sixty of
  them (`TIMEOUT_MS`), which is not time a mail provider's webhook will wait —
  it times out and redelivers, so a slow classification inside the request would
  turn into a duplicate delivery of mail that was already accepted.
- **The enqueue stays after the response even though it is now fast**, and the
  reason changed. `boss.send` is one INSERT, so it could safely go before the
  201; what keeps it after is a priority, not a latency. Losing mail is
  unrecoverable and failing to classify is not, so the queue is never in the
  critical path of the one write this API accepts from outside. Hence the catch
  around it — and hence `reconcile()`.
- **`ticket.classification` is the state, and it is not derivable from
  `category`.** A ticket with no category might be one the model has not reached
  yet, one it read and declined to place, one it could not be reached about, or
  one nobody ever tried to classify — four different things to do about it, and
  rendering all four as "unclassified" is what makes a classifier that runs
  *after* the response indistinguishable from one that is broken. Hence
  `skipped | pending | done | failed`; see `TICKET_CLASSIFICATIONS`. Note `done`
  does **not** imply a category: declining is a successful answer.
- **The column defaults to `skipped`, not `pending`**, which is what keeps the
  migration honest: every ticket that predates the column reads as "nobody
  asked" rather than as a hundred jobs queued against a classifier that will
  never run. Ingestion writes `pending` **in the INSERT**, so the row is pending
  from the instant it exists — true in the 201, and true if the process dies
  before the job is ever sent.
- **`classification` is on `ticketSummarySchema`, not the detail** — the
  opposite call to the assignee's, and for the opposite reason. It costs no
  join, it is already on the row, and the queue is where it has to be readable.

**Why pg-boss, and what it replaced.** This was an in-memory FIFO with a
microtask pump. Everything below was a hole in that, and each is now the
library's problem rather than ours:

- **Jobs survive the process.** A deploy mid-classification used to drop work on
  the floor.
- **Retries with backoff.** The failure that actually happens is a throttled
  free tier, and the honest answer is "ask again shortly". A ticket is marked
  `failed` only once pg-boss has exhausted `retryLimit` — measured at **~3.5
  minutes** for three attempts at a 15s base, during which the ticket reads
  "Classifying…" and the SPA polls it. That ceiling is the deliberate trade;
  read `SEND_OPTIONS` before changing it.
- **More than one process.** Dispatch is a row lock, so replicas share the work.
  Verified accidentally and conclusively during development: a second API
  started with a deliberately broken `OPENROUTER_MODEL` ingested a ticket, and
  the healthy instance on another port took the job and classified it.

Things about the pg-boss setup that are load-bearing:

- **It owns its own `pgboss` schema and migrates it on `start()`.** That makes
  it the second migration system in the repo. drizzle-kit does not know about it
  and must not be pointed at it; `bun run db:generate` will never mention it.
- **It uses its own `pg` pool, not the app's Bun `SQL` handle**, and that is not
  a preference. pg-boss accepts a caller's driver (`db: { executeSql }`), but
  Bun's driver cannot encode array parameters — `sql.unsafe("… $1::text[]",
  [["a"]])` reaches Postgres as the string `a` and fails with `malformed array
  literal` — and pg-boss binds arrays throughout. (Bun's pooled client also
  refuses the bare `BEGIN` pg-boss issues while migrating, unless the pool is
  `max: 1`.) Two pools against one database is the cheaper price.
- **The queue policy is `short`, and `singleton` is the trap.** `short` allows
  one job per `singletonKey` *in the queued state*, so a second send for a
  ticket already waiting is answered `null`. That matters because `reconcile()`
  sends for every ticket the table calls `pending` at every boot — usually the
  set that still has live jobs — so without the dedupe each restart would double
  the queue. `singleton` looks right and is not: it serialises same-key jobs but
  still creates them.
- **`notify: true` on the queue plus `useListenNotify: true` on the instance is
  what keeps it feeling immediate** — measured at ~16ms from send to handler,
  against a 30s backstop poll. They are two separate flags and the queue's one
  is inert without the instance's; dispatch then silently falls back to polling.
- **`expireInSeconds` must clear the model's own 60s deadline.** Below it,
  pg-boss reclaims a job that is still legitimately waiting on a model and runs
  it twice, with nothing anywhere to say so.
- **The dead letter queue exists because a handler cannot see its own retry
  count.** pg-boss hands a worker `{ id, name, data, … }` and nothing about
  attempts, so "throw and let it retry" and "give up and mark the ticket
  `failed`" cannot live in one function. The main worker therefore *only ever
  throws*, and the only thing that writes `failed` is the worker on
  `DEAD_LETTER_QUEUE`, which by definition runs once, after the last attempt.
  It must be created before the queue that names it.
- **The main worker returns rather than throws when there is nothing to do.** A
  ticket a colleague categorised mid-flight claims as `undefined`; throwing
  there would be read as failure, retried three times, and dead-lettered into
  `failed` — over the top of their decision. The dead letter worker re-claims
  for the same reason.
- **There is one pg-boss instance per process, and `ticket-jobs.ts` owns it.**
  It holds the connection, the error listener, `start()`, `reconcile()` and
  `stop()`; each feature contributes only its own queues, workers and sends
  through `register()`. That split arrived with the second background feature —
  two instances against one database would each migrate the same `pgboss`
  schema on boot and race each other doing it.
- **The classifier and the resolver are separate queues, not two steps of one
  job.** Different prompts, different failures, and — the part that settles it —
  a retry policy cannot be shared: a classification that succeeded must not be
  re-run because the resolver was throttled, and a resolver that has not run
  must not be skipped because the classifier gave up. They run concurrently on a
  ticket, safely, because they write different columns and neither reads the
  other's.
- **`createTicketJobs()`, `start()`, `reconcile()` and `stop()` are called from
  `index.ts`, never `createApp`.** Running a queue is a statement about being
  the server process; starting pg-boss inside the factory would have every
  `createApp()` in the test suite connect to a database, migrate a schema and
  register workers. Neither start nor reconcile is awaited before `listen` —
  they would delay the port and therefore a platform's health check — and a
  failure is logged, not fatal: the API serves tickets, replies, users and auth
  perfectly well without either background feature. Note what that costs while
  the queues are down, though: arriving tickets are marked `pending`, and
  `handledBy=human` hides `pending`, so they are in the database and not in the
  queue until `reconcile()` runs. That is what the boot sweep is for, and why it
  runs on every start rather than only after an unclean one.
- **`stop()` is ungraceful on purpose.** A model call is allowed sixty seconds
  and `index.ts` force-exits after ten, so waiting would just be waiting for the
  kill — and it is exactly what durability makes unnecessary: an abandoned job
  returns to `created` when it expires and runs on whichever process is up.

Things about the ticket row that are load-bearing:

- **Every write is guarded on `classification = 'pending'` AND a null
  category**, not just on the id. An agent can categorise the ticket during the
  seconds — or minutes, across retries — that a job is in flight; an unguarded
  UPDATE would overwrite a human's decision with a machine's, with nothing on
  screen to explain it. The other half lives in `PATCH /api/tickets/:id`, which
  writes `classification: "skipped"` in the same statement as any category
  change — without it the row stays `pending` forever, because the guarded
  UPDATE correctly refuses to move it and nothing else would.
- **`updatedAt` is written back explicitly, and it looks redundant.** The column
  is `$onUpdate` and the queue's default sort is `updated_at desc`, so leaving it
  out of `.set()` restamps it with `now()` — a reconciliation pass classifying a
  week-old backlog would silently drag all of it to the top of everyone's queue.
  Classification happened to the *record* of a ticket, not on the ticket.
  `dev/seed-tickets.ts` restates the column for the same reason.
- **The SQL sits behind `ClassificationStore` and the decisions behind
  `createClassificationWorker`**, which is why any of this is testable: `bun run
  test` runs with `DATABASE_URL` stripped, so a worker holding a `Database` — or
  a `PgBoss` — would be reachable only by the parts that touch neither, which is
  none of them. `ticket-classification.test.ts` also pins the pg-boss
  *configuration* (`short`, `notify`, the retry options, the expiry above the
  model deadline), because those are our decisions and every one of them fails
  silently.
- **The SPA polls, but only while something on screen will change on its own.**
  `TicketDetailPage` refetches every 4s while its ticket is `pending`;
  `TicketListPage` every 5s while *the page being looked at* holds a pending row
  — gated on the visible page rather than any loaded page, because it is an
  infinite query and a refetch re-fetches every page walked so far.

### Auto-resolution — the ticket answers itself, or reaches a human

`apps/api/src/ai/auto-resolve-ticket.ts` (the prompt),
`apps/api/src/ai/knowledge-base.ts` (the document), and
`apps/api/src/ticket-auto-resolution.ts` (when it runs). One delivered email
goes to a model together with `apps/api/knowledge-base.md`, and comes back
either as a finished reply to the student — written, posted to the thread, and
the ticket resolved — or as a refusal, which leaves an ordinary open ticket for
a person. There is no button and no route: like classification, it is a
consequence of ingestion, and it runs on the same pg-boss instance.

**This is the highest-stakes thing in the repo.** The classifier's worst case is
a refund request filed under Technical: visible, reversible, internal. This
one's worst case is a confident, fluent, wrong email in a student's inbox with
their ticket closed behind it. Everything below follows from that.

- **The knowledge base is the only permitted source of fact, and its absence
  turns the feature off.** `KNOWLEDGE_BASE_PATH` defaults to
  `apps/api/knowledge-base.md`, resolved from the API package so the default
  works from any cwd; no readable file means `createTicketAutoResolver()`
  returns `undefined` and every ticket is marked `skipped`. That is not
  defensive tidiness — a model handed an empty knowledge base and told to answer
  from it does not decline, it invents a refund policy. It is a **file, not a
  table**: it is policy, argued over by the people who run the helpdesk, and it
  wants a diff per change. Read **once, at startup**, so editing it takes a
  restart — two tickets ingested a second apart must not be answered from two
  different refund policies.
- **Whole, not retrieved.** No chunking, no embeddings, no similarity search. It
  is a few thousand words, well inside any context window, and retrieval would
  cost the property that makes it safe: section 10's escalation rules are not
  *about* any particular question, so a search over a student's email would
  routinely fail to retrieve them and the assistant would answer a chargeback
  dispute because nothing told it not to. A knowledge base that outgrows the
  context window is what makes retrieval worth its risks.
- **Escalation is the default, stated as free.** The prompt tells the model that
  handing back costs nothing and a wrong answer costs a real person, and lists
  seven conditions that force it — anything the document does not clearly cover,
  anything needing a fact about *this* student, anything that would decide or
  promise something, and plain uncertainty. `INSTRUCTIONS` is pinned line by
  line in `auto-resolve-ticket.test.ts` because these lines fail as an assistant
  that works and occasionally ruins somebody's afternoon.
- **"A refusal is an escalation, never a reply" is there because it shipped
  without it.** On the first live run against an uncovered question — a Rust
  course on the roadmap — the model invented nothing (the source-of-fact rule
  held) and answered `REPLY` with "The knowledge base does not mention any plans
  for a Rust course." That closed the student's ticket, told them nothing,
  leaked that they were being answered out of a document, and stopped a
  colleague ever seeing it: a correct observation turned into exactly what
  escalation exists to prevent, and the worst of the three failure modes because
  it looks like the feature working. The rules said "escalate when the knowledge
  base does not answer it" and never said *not to write that sentence down*,
  which a model with the source-of-fact rule strongly held satisfies by
  reporting the gap. It is now said twice — a refusal must be delivered by
  escalating, and the knowledge base is never mentioned to a student at all —
  and both lines are pinned.
- **`parseDecision` refuses rather than defaults.** The answer must lead with
  `REPLY` or `ESCALATE` on its own first line. Anything else is `undefined` and
  throws, and the tempting fix — treat an unrecognised answer as an escalation —
  is wrong twice: it throws away the only signal the model has stopped following
  instructions, and it makes a broken assistant indistinguishable from a
  cautious one, so nobody ever finds out it stopped working. An over-length
  reply is refused for the same reason it is not truncated: half an invented
  policy still reads as a finished email.
- **`ticket.auto_resolution` is the state, and it is not derivable from
  `status`.** `resolved` means the same word whether a person closed the ticket
  or the assistant answered it, and those are not the same event to anyone
  auditing the queue. Hence `skipped | pending | resolved | escalated | failed`
  — see `TICKET_AUTO_RESOLUTIONS`. `escalated` and `failed` are deliberately not
  collapsed into `skipped`: all three put the ticket in front of a person, and a
  reader who wants to know whether the assistant works at all cannot tell "it
  declined, correctly" from "it was never asked" from "it broke" once they are
  one value.
- **The column defaults to `skipped` and is written `pending` in ingestion's
  INSERT**, for the reason `classification` is — with one extra consequence that
  is the whole of the next bullet.

**The queue hides the assistant's tickets, and that is a filter with teeth.**
`listTicketsQuerySchema.handledBy` defaults to **`human`**, which excludes
`AI_HANDLED_AUTO_RESOLUTIONS` (`pending` and `resolved`). A ticket the assistant
is reading is not work anybody should start — the two would answer one student
twice, seconds apart — and a ticket it has answered is done.

- **The default lives in the shared schema, not the route**, so the SPA, a
  `curl` and the `total` count all inherit it. A default applied in the handler
  is one the page counter can disagree with.
- **`escalated` and `failed` are *not* hidden.** Those are the tickets the
  assistant handed back, and handing back means appearing in the queue. Putting
  either in the hidden set would be the worst possible reading of "don't show
  tickets the AI is handling" — `packages/shared/src/api.test.ts` pins the set
  for exactly that reason.
- **A row left `pending` is a row missing from the queue**, which is the one
  failure here that loses an email outright. Three things stand behind it, and
  all three look redundant until you know this: the worker **writes** `skipped`
  when it cannot claim a ticket rather than returning; the dead letter worker
  always clears `pending`, either to `failed` or by standing down; and ingestion
  puts the row back to `skipped` itself if the `enqueue` throws, rather than
  waiting for `reconcile()` on the next boot. `PATCH /api/tickets/:id` writes
  `autoResolution: "skipped"` alongside any change for the same reason —
  otherwise a ticket an agent just assigned to themselves would vanish from the
  queue they assigned it in.
- **The sidebar's queue views are what take the hidden rows back** — "Needs a
  human" (default, a bare `/`), "Handled by AI", "All tickets" — in the URL as
  `?handled=`, like every other piece of queue state, each with its live count.
  Without them those rows are filtered by a rule with nothing on screen to
  explain it, which is not a hidden row but a lost one. The counts are three
  `GET /api/tickets?handledBy=…&limit=1` requests reading `total`, keyed under
  `["tickets", "count", …]` — the same filters as the page, so the sidebar and
  the page counter cannot disagree, and the prefix invalidate a PATCH already
  does refreshes them. The page heading names the view, and the empty state
  names the hidden view for the same reason: "no tickets match that filter"
  beside controls reading All is how a reader concludes the queue is broken.
- **The row marker is deliberately sparse.** `by AI` for `resolved` and
  `AI unavailable` for `failed`; nothing for `skipped` or `escalated`. Escalated
  is the *ordinary* outcome of a working assistant, so a badge on it would sit
  on nearly every row and inform nobody — an escalated ticket is just a ticket,
  which is what escalating means.

Things about the worker that are load-bearing:

- **It claims far more narrowly than the classifier does.** Still `pending`,
  still `open`, still no replies on the thread, and still unassigned. The
  classifier only asks whether a human set the category; this one asks whether a
  human has touched the ticket *at all*, because writing to the student is wrong
  the moment somebody else is on it. A colleague who has already replied is the
  case worth naming: two different answers to one email, minutes apart.
- **`resolve` is one transaction, and the guarded UPDATE goes first.** Its
  `returning` is the arbiter — if the guard stopped matching while the model was
  writing, the reply is not inserted. A reply with no status change is a ticket
  that looks untouched; a status change with no reply is a student who was never
  written to. `status: "resolved"` bypasses `canTransition`, which is safe only
  because the claim pins the current status to `open`.
- **`updatedAt` is restated in SQL on `escalate`, `fail` and `skip`**, and left
  to `$onUpdate` on `resolve`. The first three happened to the *record* of a
  ticket; the fourth is a reply and a status change, which is activity the
  queue's default sort is supposed to surface. The idiom differs from the
  classifier's (which carries the value through the job) because `skip` has no
  claimed row to carry anything from.
- **Every automatic reply is authored by a soft-deleted stand-in `user` row**,
  `assistant.<SUPPORT_EMAIL>`, named `Helpdesk Assistant` — the same device
  `dev/seed-replies.ts` uses for a student's turns, and for the same reason:
  `ticket_reply.author_id` is NOT NULL and the thread's query inner-joins `user`
  *without* filtering `deletedAt`. Soft-deleted is what makes it safe rather
  than tidy: unlistable, unassignable, refused a session, and created with no
  `account` row so there is no password to try. The address is namespaced for
  the reason the student stand-in's is. `ASSISTANT_NAME` is the byline *and* the
  sign-off the prompt is given, so a thread cannot disagree with itself.
- **`x-skip-auto-resolve: 1` turns it off for one delivery**, a second header
  beside `x-skip-classification` because they switch off different things — a
  delivery that stated its own category still has a student waiting on an
  answer. `dev/seed-tickets.ts` always sets it and has **no opt-in flag**,
  unlike `--classify`: letting the assistant see a hundred committed fixtures
  would write a hundred replies to addresses out of a fixture file and resolve a
  hundred tickets, taking the corpus's status spread with them.
- **Retries are the classifier's — three attempts, 15s base, ~3.5 minutes to
  exhaust — and the ticket is invisible for all of it.** That is the deliberate
  trade: the alternative is showing a ticket and then answering it out from
  under whoever picked it up. `expireInSeconds` must clear the model's own 60s
  deadline, or pg-boss reclaims a live job and runs it twice — **two emails to
  one student**, rather than the duplicate model call it means next door.

### Ticket updates — status, category, assignee

`PATCH /api/tickets/:id` and `GET /api/assignees` are the whole of it, and the
SPA reaches them from the ticket detail page only. The queue is deliberately
untouched: no assignee column, no sort key, no filter — you change a ticket by
opening it.

- **One route, three optional fields, and a body naming none of them is a read
  rather than an error.** That is what keeps this one endpoint instead of three,
  and why it was never `PATCH /api/tickets/:id/assignee`. The SPA sends only the
  field the reader changed — a PATCH that restated all three would overwrite
  whatever a colleague changed while the page sat open.
- **The status move is checked against `TICKET_STATUS_TRANSITIONS`**, which had
  been declared in `packages/shared/src/domain.ts` and enforced nowhere until
  this route landed. Two things about it are easy to get wrong. `canTransition`
  answers false for the *identity* move, which is a true statement about the
  lifecycle and a wrong answer to `PATCH {status: "open"}` on an open ticket —
  so "no change" is filtered out before the check and only a real move reaches
  it. And the refusal is a **409, not a 400**: "closed" is a status, the payload
  is fine, and this ticket simply cannot become it, which is the line
  `HttpError.conflict` draws.
- **`closed` is terminal**, so the SPA disables the whole Status select and says
  why. That condition is read off `TICKET_STATUS_TRANSITIONS[status].length` and
  not spelled `=== "closed"` — a literal would keep claiming it after someone
  gave closed a way out. The per-option `disabled` beside it fires for nothing
  under today's table and is the general rule stated once.
- **An empty change set skips the UPDATE entirely.** Not an optimisation:
  `updatedAt` is `$onUpdate`, so a write that set nothing would still restamp it
  and move the ticket to the top of the queue's default sort.

- **`ticket.assigned_to_id` is nullable and references `user.id`.** Null is the
  unassigned pool every ticket arrives in — nothing routes, so an owner is
  always a human decision, the same reasoning `category` carries. `on delete set
  null` should never fire: `DELETE /api/users/:id` is a soft delete, so the
  constraint covers only a row someone removes by hand — that route clears the
  column itself for the case that actually happens. **There is no index on
  it**, on the stated policy the search's `ilike` follows: nothing queries by
  the column yet, and an "assigned to" filter is what would justify the write
  cost.
- **The assignee is on `ticketDetailSchema`, not `ticketSummarySchema`**, and
  that split is the whole reason the list query is unchanged. Putting it on the
  summary would make every list request pay for a join nothing renders. Adding
  an assignee column to the queue is what moves it up — along with the join, a
  sort key and a filter, which is why it is a decision rather than a field.
- **`PATCH /api/tickets/:id` is not admin-gated**, unlike every user route. An
  agent claiming a ticket or handing one to a colleague is how a queue gets
  worked; making it a supervisor act would mean an agent who picks something up
  cannot say so. `app.test.ts` asserts an *agent* reaches the database check,
  because a 403 there is the regression.
- **`updateTicketBodySchema` is a `strictObject`, and `assigneeId` is optional
  *and* nullable.** Absent means "leave it alone", explicit null means
  "unassign" — collapse them and there is no way to hand a ticket back. Strict
  for the reason `inboundEmailBodySchema` is: a plain `z.object` strips a
  misspelled `assignee` key and answers 200 for a request that assigned nobody.
  The route skips the UPDATE entirely when `assigneeId` is absent, so an empty
  PATCH cannot bump `updatedAt` through `$onUpdate` and move the ticket in the
  queue's default sort.
- **Deleting a colleague releases their queue.** `DELETE /api/users/:id`
  unassigns every ticket the account owned, in the transaction that marks the
  row — unlike `ticket_reply.author_id`, which records something that already
  happened and stays. Left alone, those tickets would sit owned by someone who
  cannot sign in, absent from the "unassigned" reading of the queue and
  unreachable through `GET /api/assignees`, so the only way to find one is to
  open it. It restamps `updated_at` through `$onUpdate` and moves them up the
  queue's default sort, which is wanted: they just became work with no owner.
  Two things downstream still handle a deleted assignee, for rows assigned
  before this landed. `findTicketDetail` does *not* filter `user.deletedAt` —
  answering with a departed owner is better than silently redrawing an owned
  ticket as unassigned — and the SPA folds the current assignee into the
  picker's `items` as a **`hidden`** entry, since Base UI renders the trigger's
  label out of `items` and without the merge such a ticket shows an empty box.
  `hidden` keeps it out of the listbox while leaving that label resolvable,
  which is the whole point: a departed colleague is named on the ticket they
  own and offered on none. It is distinct from `disabled` beside it, which is
  for a choice a reader should see and understand they cannot make (the status
  select's terminal `closed`). And `DeleteUserDialog` invalidates
  `["assignees"]`, `["ticket"]` and `["tickets"]` alongside `["users"]` — the
  picker's `staleTime` is five minutes, so without the first an admin who
  deletes a colleague is still offered them on the next ticket they open.
- **`GET /api/assignees` is unpaginated and open to every signed-in agent**,
  which is what distinguishes it from the admin-gated `GET /api/users` beside
  it. A picker needs every option at once — a cursor means the person you want
  might be on a page the control never fetched — and you cannot hand a ticket to
  a colleague you are not allowed to see. Both roles are in it: an admin works
  tickets like anyone else, and a fresh install where `seed:admin` made the only
  account would otherwise have nobody to assign to. When a team outgrows a
  select this wants a search, not a cursor.
- **`toTicketDetail` takes the assignee as a second, required argument.** The
  row alone cannot answer it — the column is an id and the response carries a
  name — and requiring it means a new call site has to say which it is. The one
  non-obvious caller is `inbound-email.ts`'s duplicate-delivery path: the first
  delivery is unassigned by definition, but the *existing* row has been there as
  long as the retry took, so that branch joins rather than assumes.

### Replies — the ticket's thread

`GET /api/tickets/:id/replies` and `POST /api/tickets/:id/replies`, rendered on
the ticket detail page under the email. One `ticket_reply` row is one thing a
member of staff said back.

- **Nothing is delivered.** There is no email provider in this repo, so a reply
  is recorded and not sent — the mirror image of the gap
  `dev/send-inbound-email.ts` stands in for on the way in. The form says so
  under the textarea rather than leaving an agent to believe a student has been
  written to. When a provider lands, `POST …/replies` is the seam it hooks into.
- **It is not a message table, and that is the design decision worth knowing.**
  The ticket's own `body` is the email that created it and stays on `ticket`;
  replies are a separate table with a `user` author. A uniform message table is
  what a *student* reply would need — an author who is not a `user`, a
  direction, a source message id — and nothing ingests one: inbound mail always
  opens a new ticket. Merging the two now would be a schema shaped for an
  integration nobody has written.
- **The thread is a separate request from the ticket, not a field on
  `ticketDetailSchema`.** `PATCH /api/tickets/:id` answers with a
  `TicketDetail`, so a thread on that shape would be re-sent in full every time
  someone changed a status. The two also have different lifetimes in the SPA's
  cache: posting a reply must not refetch the ticket, and changing a status must
  not refetch the conversation. The key is `["ticket", id, "replies"]`, nested
  under the ticket's so a future prefix invalidate takes both.
- **Unpaginated, like `GET /api/assignees`.** A conversation with a "load more"
  in the middle is one the reader reassembles. A ticket with enough replies to
  need a cursor is a different problem.
- **The author comes from the session and cannot come from the body.**
  `createTicketReplyBodySchema` is a `strictObject` with one field, so a payload
  carrying `authorId` is answered rather than stripped — otherwise anyone could
  sign a reply with a colleague's name. `toTicketReply` therefore takes a `User`
  rather than a `UserRow`: the write already holds the session's user, and only
  the thread query has a row to map.
- **`author_id` is NOT NULL with no `onDelete`**, unlike `ticket.assigned_to_id`'s
  `set null`. A reply always names its author, and a soft-deleted colleague
  keeps their byline for the same reason they stay assigned — the user row
  survives a delete precisely so past work can name who did it. The thread's
  join is therefore an `innerJoin` and does not filter `deletedAt`.
  `ticket_id` is the opposite case and cascades: a reply is part of its ticket,
  not a reference to one.
- **Writing a reply deliberately does not touch the ticket row.**
  `ticket.updatedAt` is `$onUpdate` and the queue's default sort is on it, so an
  UPDATE here would move a ticket to the top of the queue every time anyone
  replied. That is a real feature — "recently active" is what a support queue
  usually sorts by — and it is a decision about the queue rather than a side
  effect of this route. Making it means a transaction around the insert, plus
  the SPA invalidating `["tickets"]` on a successful reply.
- **A reply is immutable**: no `updated_at` column and no edit or delete route.
  Add the column when there is an editor to justify it.
- **`bun run seed:replies` is how a long thread gets into a dev database**
  (`dev/seed-replies.ts`, `dev/reply-fixtures.ts`). Twenty committed messages —
  ten from the agent, ten from the student, strictly alternating and at least
  ten lines each — walked forward from the ticket's own `createdAt` on
  irregular gaps. `reply-fixtures.test.ts` pins all of that, because each
  property fails as a thread that renders perfectly and exercises nothing. The
  arc deliberately leaves questions open and ends on an unanswered one, which
  is what gives the summariser something to put under "Outstanding".
- **It seeds the student's half through a soft-deleted stand-in `user` row, and
  that is worth understanding before touching it.** `ticket_reply.author_id` is
  NOT NULL and references `user`, so this schema *cannot* store a message from
  a student — the point made above, from the other side. A stand-in is the only
  way to seed an alternating conversation without building the message table,
  and a deleted one is the safe kind: `GET /api/assignees` and `GET /api/users`
  both filter `deletedAt` so it can never be assigned a ticket or listed, the
  session hook refuses it a login, and it is created with no `account` row so
  there is no password to try. Meanwhile the thread's own query inner-joins
  `user` *without* filtering `deletedAt` — the rule that keeps a departed
  colleague's byline — which is exactly what makes the student's turns render.
  Its email is namespaced `student.<address>` because `user.email` is UNIQUE
  and a deleted row keeps its address: without the prefix, a real student who
  later joined the staff could not be created, and the 409 would blame a
  deleted user nobody could find. The honest limitation is that the **SPA
  cannot tell the two apart** — there is no direction column, so a student's
  turn renders in the same card as an agent's and the thread reads as a
  conversation because of the names and the words, not because the app knows.
  Rendering a real inbound/outbound distinction is the schema change this
  deliberately does not make.
- **It writes with Drizzle rather than through `POST …/replies`**, unlike
  `seed-tickets.ts`, which posts to the real endpoint. Two reasons, both hard:
  that route takes its author from the session, which is the whole point of it
  and something a student can never have; and every fixture is deliberately in
  the past, while the route stamps `now()`. It leaves `ticket.updatedAt` alone
  for the reason the route does — `$onUpdate` plus the queue's default sort
  means touching it would jump a seeded ticket to the top of the queue.
- **The SPA appends the response rather than invalidating**, the opposite of
  what the sidebar does with the queue: the POST answers with the new row in the
  shape the list holds, so an invalidate would round-trip for something already
  in hand and blank the conversation while it did. The cost is a colleague's
  reply written in the meantime, which arrives on the next mount.

### Where a model runs

Four features, one core. `apps/api/src/ai/openrouter.ts` holds everything about
*reaching* a model — the fallback chain, the batching, the one shared deadline,
the translation of a provider failure into a sentence an agent can act on — and
exports `createTextGenerator()`, which is `undefined` when no key is configured.
Each feature beside it owns only what makes it that feature: its instructions,
its prompt, its temperature and its length ceiling. That split arrived with the
summariser, held when the classifier landed as the third, and held again for the
auto-resolver: everything about the provider lives in the core and is shared by
all four. A fifth feature is a fifth prompt file, never a second copy of the
batch walk — the trap in `OPENROUTER_MODELS_PER_REQUEST` below fails *every*
request and reports itself as a generic call error, and a missed copy of it is a
button that has never worked.

Two of the four have **no route and no reader**. The polisher and the summariser
answer a button press, so a provider failure becomes a 502 with a sentence in
it; the classifier and the auto-resolver run off the back of ingestion and write
to columns, so their failures are a state on the row (`failed`) rather than a
message, and their mistakes look exactly like correct answers. That is why both
of their prompts are stricter about declining than either button's, and why each
has a parse that refuses anything not in an exact shape — `parseAnswer` one of
four words, `parseDecision` one of two verdicts.

The auto-resolver is the end of that scale and is worth understanding as its own
category. Its output is not a column an agent reads and not a draft an agent
approves: it is **an email sent to a student under the helpdesk's name, with
their ticket closed behind it**. Nothing downstream checks it. Every decision in
`ai/auto-resolve-ticket.ts` — the temperature, the ceiling, the refusal to
salvage a malformed answer, the instruction that escalating is free — is made
against that.

### Reply polishing

`POST /api/tickets/:id/replies/polish` and the **Polish** button beside Send on
the reply form. An agent's shorthand goes to a language model through OpenRouter
(Vercel's AI SDK, `apps/api/src/ai/polish-reply.ts`) and the finished email
comes back into the box.

- **It expands, and it does not answer**, which is the whole design of the
  prompt — and the first half is a correction. It shipped as a copy editor
  ("fix the grammar, keep it concise, add no greeting"), which is a faithful
  description of the wrong job: an agent who typed `fixed` got back `Fixed.`
  A draft is a note about *what* to say, not a draft of *how* to say it. The
  half that survived is the half that matters: it expands how the draft is said
  and never adds to what it says, because a model asked to "improve a support
  reply" invents refund windows and deadlines, and the reader least likely to
  catch that is an agent skimming a rewrite of their own words. So the draft is
  the source of every fact, the ticket is context for tone and for what "it"
  refers to, and the instructions say so in as many words. The student's email
  is fenced in `<ticket>` with the instructions outside it, which is hardening
  rather than a boundary — the boundary is that an agent reads the result and
  presses Send themselves. `INSTRUCTIONS` is exported only so
  `polish-reply.test.ts` can pin those lines: they fail as a button that works
  and disappoints, with no error anywhere.
- **Courtesy is not a fact, but a name is.** A greeting, an acknowledgement and
  a sign-off assert nothing about the world, which is why they are wanted where
  the copy editor forbade them — but a model told to close warmly with no name
  to close as will supply one: a department that does not exist, or the
  student's own name read back off the ticket. So both are given, the student's
  from the ticket and the agent's from the session, which is why
  `buildPolishPrompt` and `ReplyPolisher` take it as a **required** argument
  (the reasoning `toTicketDetail`'s assignee argument carries) and why the route
  has its own `req.user` guard. The agent's name is the one piece of prompt
  outside the fenced blocks: it came from the session, not from a stranger's
  email.
- **`OPENROUTER_MODEL` must name models that answer directly.** A reasoning
  model spends the output budget thinking before it writes, and a rewrite this
  short is finished by the budget before the reply starts — OpenRouter answers
  `content: null` with `finish_reason: "length"`, which surfaces as "the model
  returned an empty reply" rather than as the configuration mistake it is.
  `openai/gpt-5-nano` fails exactly that way. Cheap instruct models do the job
  well, at roughly a hundredth of a cent per press; the committed default stays
  all-free so an install with no credit still works, and `.env.example`
  documents the paid-primary chain that does not throttle.
- **Temperature is 0.5, not the 0.3 the copy editor ran at.** Expanding two
  words into a paragraph is composition, and a near-deterministic setting
  returns the same stilted sentence on the second press — which is the press an
  agent makes *because* they disliked the first answer.
- **A separate route from `POST …/replies`, and it writes nothing.** Folding
  them together would mean the only way to see a polished reply is to have
  already published it. It answers **200** with `{ body }` rather than a
  `TicketReply`, and keeping the shapes distinct is what stops a rewrite from
  ever reading like something that was said.
- **Ticket-scoped for the model, not for the URL.** The route loads the ticket
  and puts the student's own email in the prompt. A context-free "improve this
  text" endpoint would have to guess at register and referents, and its guesses
  are the parts an agent has to undo.
- **`OPENROUTER_API_KEY` is optional even in production**, unlike
  `BETTER_AUTH_SECRET` and `INBOUND_EMAIL_SECRET`. Those guard something, so
  booting without one is a hole; this one *enables* something. `createReplyPolisher()`
  returns `undefined` without it — the same `getDb()` / `createAuth(db)` shape —
  and the route answers 503 naming the missing config.
- **`OPENROUTER_MODEL` is a preference order, not one id.** The first is the
  primary and the rest are handed to OpenRouter's own `models` routing, which
  serves the next one when the primary is throttled. That is what makes a
  `:free` tier usable at all: free models sit behind a shared upstream pool
  that throttles and recovers minute to minute, so a lone id makes Polish work
  intermittently for reasons no agent can see or act on. The default chain is
  five *different* providers on purpose — entries from one provider share the
  pool that just throttled — and `providerOptions` is omitted entirely when a
  batch has one entry, so a single-model install's requests are unchanged.
  Splitting happens in `env.ts` so a malformed list fails at boot rather than
  on the first click.
- **OpenRouter accepts at most three ids per `models` array**, so a longer
  chain is walked in batches of three by `modelBatches` rather than sent whole.
  This is the trap worth knowing before editing `OPENROUTER_MODEL`: a fourth id
  is not ignored and does not degrade — it is rejected outright with
  `'models' array must have 3 items or fewer`, failing *every* request, and it
  surfaces as a generic call error. The symptom is a Polish button that has
  never worked on a `.env` line that reads perfectly well. The batches share
  one `AbortSignal.timeout` deadline, because a per-batch timeout would
  multiply by the number of batches and hold a request for minutes while each
  individual call looked well-behaved; `maxRetries` is 0 for the same reason
  the chain exists — a retry re-asks the pool that just refused.
- **`TIMEOUT_MS` is 60s because it covers the whole walk, not one call.**
  Measured against the live free tier: a throttled model refuses in well under
  a second, but one that *accepts* can take twenty, so a chain that walks past
  several refusals into a slow answer needs room a 30s ceiling did not leave —
  it turned requests that were about to succeed into 502s.
- **A model's failures are 502, via `HttpError.badGateway`.** Distinct from
  500 (this API is broken) and 503 (a dependency is missing): the request was
  fine and someone else's server was not. `ModelError` (in `openrouter.ts`, and
  thrown by both features) carries a message written to be rendered as-is, and
  the provider's own error — which holds the URL, the model id, sometimes a key
  prefix — stays on `cause` for the log line.
  `describeProviderFailure` picks that message by status, and the point is the
  reader's next move rather than accuracy for its own sake: 429 means press the
  button again shortly, 401/403 means fetch whoever holds the key, 404 means
  `OPENROUTER_MODEL` names something retired. It reads the status off the SDK's
  `RetryError.lastError` — the outer error carries no `statusCode`, so reading
  it alone silently reports every failure as the generic one.
- **An unusable answer is refused, not salvaged.** Empty means a refusal or a
  filtered generation, and handing it back would silently blank a draft;
  over-length means the model started answering the student instead of editing,
  and truncating would put half of that in the box as if it were finished.
  `unwrapModelText` strips only the unambiguous wrappers a small model adds — a
  fence around the *whole* answer, and, when the caller names one, the prompt's
  own tags echoed back (`<draft>` here; the summariser names none, because a
  model that echoed `<ticket>` has not written a summary at all). A leading
  "Here is your improved reply:" is deliberately left alone: it cannot be told
  from a first sentence the agent wrote.
- **`ticketReplyBodyField` in `packages/shared` is shared between the two
  writes**, a factory so each says its own thing about an empty box while the
  *ceiling* cannot drift — a draft the polisher accepted and the send route
  rejected is a dead end reached only after the model has been paid for.
- **The SPA disables the textarea and both buttons while a rewrite is in
  flight.** A send would race the `setValue` and could publish the very draft
  the agent asked to have replaced; typing would be overwritten by the response,
  and losing a sentence that way is invisible. The Polish button is
  `type="button"` — the default inside a form is submit, which would send the
  unpolished draft with a click on the button meant to improve it — and the
  polisher's error renders separately from the form's `root`, so a failed
  polish never reads as a failed send.

### Ticket summaries — the second model

`POST /api/tickets/:id/summary` and the **Summarize** button under the student's
email on the ticket detail page (`apps/api/src/ai/summarize-ticket.ts`,
`apps/web/src/routes/TicketSummaryCard.tsx`). The ticket and its whole reply
thread go to a model and a few lines come back saying what it is about and where
it stands. It is the opposite job to the polisher next door — that one composes
and runs warm, this one extracts and runs cold (0.2) — and the two share
everything in `openrouter.ts` and nothing above it.

- **It is regenerated on every press, and nothing is stored.** No `summary`
  column, no cache entry, no `staleTime`. The alternative has to be invalidated
  by every reply, every status change and every edit, and the version that ships
  is the one where it silently is not: a summary describing the ticket as it
  stood four replies ago, presented exactly like a fresh one. A reader cannot
  tell those apart — they are looking at the summary precisely to avoid reading
  the thread — which is what makes a stale summary worse than none. The card
  shows the moment it was asked for, which is the other half of that contract.
- **A mutation in the SPA, not a query**, and that is what keeps the cost
  honest. A query would fire on mount, so every ticket anyone opened would spend
  a model call whether or not they wanted a summary, and would then serve the
  answer back while the thread grew underneath it. `TicketDetailPage.test.tsx`
  pins that opening a ticket sends no `POST …/summary`.
- **POST for something that reads.** GET is the verb this looks like and the one
  it must not be: a browser, a proxy and React Query all treat a GET as free to
  repeat and safe to cache, and here each repeat costs a model call and returns
  a different answer. POST states both facts.
- **The request carries no body, and the route never reads one.** The material
  is the email plus the thread, both of which the server already holds. A body
  would make this a summariser of whatever a caller sends wearing a ticket's
  URL — the mirror image of the polish route, where the draft is the point and
  only the agent has it. `app.test.ts` pins that a body changes nothing.
- **The thread query is shared with `GET …/replies`** (`findTicketReplies` in
  `routes/tickets.ts`). A summary built from a different set of replies than the
  page below it would be wrong in the one way nobody checks.
- **An empty thread is stated in the prompt, not omitted.** An absent block is
  ambiguous and a model resolves the ambiguity confidently — "the team has
  responded" about a ticket nobody has touched. Both blocks are fenced like the
  polisher's, now over staff replies too, since a reply is free text typed by a
  human like any other.
- **The instructions forbid advising, recommending or deciding anything**, which
  is the failure this prompt is built against: a model handed "I was charged
  twice" wants to help, and produces "The student should be refunded within 5
  working days" — a policy, in the helpdesk's voice, that nobody agreed to. An
  unanswered question is reported as still unanswered, never answered.
  `summarize-ticket.test.ts` pins those lines, because they fail as a button
  that works.
- **Nothing here is signed or sent**, so unlike the polisher the route needs no
  `req.user`: a summary names the people in the thread, never its reader.

### The dashboard — five numbers over every ticket

`GET /api/stats` and `apps/web/src/routes/DashboardPage.tsx`, at `/dashboard`.
Total tickets, open tickets, how many the assistant resolved, that as a share,
and the average time a ticket takes to resolve.

- **It counts what the queue hides, which is the whole reason it is not derived
  from `GET /api/tickets`.** That route defaults `handledBy` to `human`, so its
  `total` is the work a person still has to do — counting it would answer "how
  many tickets has the AI resolved" with a number chosen to exclude exactly
  those. These aggregates are over the whole table, unfiltered.
- **`ticket.resolved_at` exists because the average cannot be computed without
  it, and every approximation is wrong in a way the number hides.**
  `updated_at` is the tempting stand-in and is not a resolution time at all: it
  restamps on an assignment, a category change, a reopen, so a ticket resolved
  in an hour and re-tagged a week later reads as a week and the mean drifts
  upward every time anybody touches an old ticket. A dashboard figure nobody can
  check is worse than no figure.
- **`resolutionStamp` in `routes/tickets.ts` is the rule, exported so
  `tickets.test.ts` can pin it** — the same device `searchPattern` uses, and for
  the same reason: no test with a stubbed database reaches the UPDATE, and every
  way of getting this wrong is silent. Moving **out of `open`** stamps now;
  moving **to `open`** clears it, because a reopen says the ticket was not
  resolved after all and a stale stamp would both keep a withdrawn resolution in
  the average and then swallow the real one; **`resolved -> closed` leaves it
  alone**, because closing an already-resolved ticket is filing, not resolving,
  and restamping there turns a resolution-time average into an
  archiving-habits average. `undefined` means "do not write the column" and is
  distinct from the `null` that clears it — the same optional/nullable split
  `updateTicketBodySchema` uses.
- **The auto-resolver stamps it too**, in the guarded UPDATE inside `resolve`.
  Without that the average is an average of the tickets people got to first, and
  the assistant's — which are the fast ones — resolve without ever recording
  when.
- **`dev/seed-tickets.ts` writes `resolved_at` in the same statement as the
  backdated `updated_at`**, and to the same value: for a resolved or closed
  fixture that timestamp *is* the moment `updatedAtFor` invented for the work
  finishing, and nothing has touched the row since. Without it a freshly seeded
  database shows a hundred resolved tickets beside "no resolution times
  recorded", which reads as a broken tile rather than as a corpus that predates
  the column.
- **`GET /api/stats` is flat, not `/api/tickets/stats`.** Express matches in
  order, so the nested spelling would have to stay above `/tickets/:id` — move it
  one line down and `stats` arrives as an id, fails the UUID parse and answers
  400 for a route that exists. A flat noun beside `/assignees` has no ordering to
  preserve, and `app.test.ts` pins that it is not swallowed. It is open to every
  signed-in agent for the reason `/assignees` is: these are counts of the queue
  everyone works, and nothing in them names a person.
- **One query, not five.** Postgres computes every aggregate in a single pass
  with `count(*) filter (where …)`, the idiom `seed-tickets.ts` already uses.
  Five round trips would additionally be five *moments*, and a ticket resolved
  between the second and the third makes a dashboard whose tiles do not add up —
  the one thing a page of numbers must never do. `avg` needs `::float8`: it
  returns `numeric`, which the driver hands back as text to preserve precision it
  does not have here, and the response schema would throw on a good average.
- **`aiResolved` is read off `auto_resolution`, never off `status`.** The two
  answer different questions: a ticket the assistant resolved and a colleague
  reopened is no longer `resolved` and was still resolved by the AI; a ticket a
  person closed by hand is `resolved` and was not.
- **The response carries counts; the percentage is derived in the SPA.** A
  division on the wire is a second place the numerator and denominator get
  chosen, so a tile reading "30%" beside tiles reading 110 and 30 could disagree
  with both and nothing on screen would say which had drifted. The page does the
  arithmetic the reader can do themselves.
- **Null is not zero, and both tiles say so.** `averageResolutionSeconds` is
  null when no row carries a `resolved_at`, and the page renders an em dash
  rather than "0m" — "nothing has been resolved" and "everything was resolved
  instantly" are opposite facts. `resolutionSampleSize` ships for the same
  reason: `resolved_at` only exists from its migration onward, so naming the
  count is what stops an average of fifty-four reading as an average of all
  hundred and ten.
- **Two shares of the same number, deliberately.** The headline is
  `aiResolved / total` — what fraction of the workload the assistant closed,
  which is what a team measures when asking whether the feature pays for itself.
  The caption adds `aiResolved / (aiResolved + aiEscalated)` — how often it can
  answer when it looks at something, which is about the assistant rather than the
  workload. One percentage would have to be one of them and would be read as the
  other, which is why `aiEscalated` is on the response at all.
- **It does not poll, unlike the queue.** The queue refetches while a ticket on
  screen is mid-classification, because something there changes on its own within
  seconds. These counts move all day and no single reading is the one the reader
  is waiting for; the client's 30s `staleTime` refetches on a return to the tab,
  and a tile that ticks while being read is movement bought for nothing.
**The trend chart — arrivals per day, under the tiles.** One bar per day for
`TICKET_TREND_DAYS` (30), on the same `/api/stats` response as the counts above
it so the two cannot describe different moments.

- **`tz` is a query parameter because "tickets per day" has no answer without
  one.** A day is a range of instants and which range depends on where the
  reader is standing: bucketing in UTC files a ticket that arrived at 9pm in
  Tehran under the following day, so an agent's busiest evening lands on
  tomorrow's bar and today's is short a few hours. The SPA sends
  `Intl.DateTimeFormat().resolvedOptions().timeZone`; the schema defaults to UTC
  so a `curl` still works. Verified against the live database from both ends of
  the clock — `Pacific/Kiritimati` (+14) shifts the whole window forward a day
  and `Pacific/Niue` (-11) drops a ticket out of it entirely, which is the
  proof the conversion is doing something rather than being decorative.
- **The zone is validated in `packages/shared`, not left to Postgres.** It is
  interpolated into `timezone(…)`, so an unknown name comes back as a runtime
  error — a 500 blaming this API for a caller's typo. `Intl` throws for anything
  its tz database does not know, and that is the same IANA database Postgres
  ships, so the cheap check agrees with the thing that will actually run.
- **`generate_series` LEFT JOINed to the tickets, never a bare `GROUP BY`.** A
  group-by answers only about days that *have* rows, so a quiet Sunday comes
  back missing — and a 30-bar chart handed 28 rows does not draw a gap, it draws
  28 bars and slides every later one onto the wrong date. The zero-fill is the
  server's job because the response has to be a complete statement about the
  window it names. `ticket-trend` tests pin that empty days survive to the
  chart.
- **`to_char`, not a bare `date`.** The driver turns a `date` into a `Date` at
  midnight UTC and the browser then renders it in local time — a day earlier for
  anyone west of Greenwich, which is the exact off-by-one the bucketing exists
  to prevent. It crosses the wire as `YYYY-MM-DD`, and `parseCalendarDay` builds
  a **local** midnight from the parts rather than calling `new Date(iso)`, which
  would reintroduce the bug on the client instead.
- **It scans `ticket`, deliberately.** The conversion on `created_at` means no
  index on the column can serve the join. Same policy the search's `ilike`
  follows: a functional index is earned by a query plan that needs one.
- **Divs and flexbox, not SVG and not a charting library.** Thirty bars of one
  series need no scales, no axis engine and no layout pass; flexbox gives
  responsive widths where an SVG would want a `viewBox` and a resize observer. A
  chart dependency is worth adding the day this needs a second series, a time
  axis that skips weekends, or interpolation — none of which is a bar per day.
- **One series, so no legend** — the card title names the bars. The fill is
  `bg-primary`, not the theme's `--chart-1`. Under shadcn's stock palette that
  token was `oklch(0.87 0 0)` in *both* modes, near-invisible on a white card;
  the Workbench palette now sets it to the accent too, but `--primary` is the
  token whose per-mode contrast is actually designed.
- **A nonzero day always has a mark; an empty day never does.** A count of 1
  against a busy day's scale is a sub-pixel bar, so bars carry a 2px
  `min-height` — the difference between "one ticket" and "none" is the one this
  chart cannot lose. An all-zero window renders an empty state instead of thirty
  invisible bars, which would read as a chart that failed to load.
- **The readout sits above the plot rather than floating over the hovered bar**,
  because `Card` is `overflow-hidden` and a tooltip on the first or last column
  would be clipped by the card's own corner — and those two are the bars most
  likely to be inspected. It always occupies its line, so the chart does not
  jump as the pointer crosses it.
- **Axis labels are absolutely positioned and anchored, not `text-align`ed, and
  this is the one that had to be measured to be found.** A label is far wider
  than its column — thirty days across a phone leaves each about eight pixels —
  so the line overflows, and *an overflowing `nowrap` line ignores `text-align`
  and always spills right*. `text-align: right` on the last label changed
  nothing: it still ran 14px past a card that clips, rendering "Sep 21" as
  "Sep", the one label that says where the window ends. An absolutely positioned
  span is sized to its own text, so anchoring `right-0` actually holds it
  inside. Checked at 420/768/1100px.
- **The bars carry no `tabindex`; the accessible path is a `sr-only` table.**
  Thirty tab stops between the tiles and whatever follows is a keyboard trap
  dressed as access, and the table is the same numbers in a form a screen reader
  can walk.

- **It is not the index route.** The queue keeps `/`: a dashboard that took it
  would put a page of numbers between an agent and their work every time they
  sign in. There is exactly one hero figure on it, which is what makes the size
  mean "start here".

### Web

Routing is defined in one place, `apps/web/src/main.tsx`. `/login` sits outside the layout; **everything else nests under `RequireAuth`** so a new route is protected by default. `RequireAdmin` nests inside that for admin-only screens.

The queue lives at the index route, `/`, and the nav links to it with `end` — there is no separate `/tickets` path, because one screen with two URLs is a thing to keep in sync for no gain. `/dashboard` sits beside it and needs no `end`: it has no children, so there is nothing for the active state to over-match. `MainNav` in `AppLayout.tsx` lives in a left sidebar with the wordmark (folding into a scrolling strip below `md`); the top bar is about the session (environment, identity) rather than the app. `AppLayout.test.tsx` asserts that as *containment*, not document order or class names. The three queue views all live at `/`, so they are plain `Link`s with `aria-current` computed from `?handled=` — `NavLink` matches on pathname alone and would mark all three current at once.

**The look is the "Workbench" direction**: Onest (`@fontsource-variable/onest`) as the one family, slate neutrals with a blue bias, one cobalt accent meaning "open work / where you are", and two semantic tokens beside it that are not accents — `--caution` (refund requests, the category with money attached) and `--overdue` (an open ticket older than `OVERDUE_AFTER_DAYS`, a display judgement, not an SLA). All tokens live in `index.css`; dark mode is the `.dark` block, applied from the OS preference by `index.html`. Queue rows carry a one-line `preview` of the email, cut server-side by `ticketPreview` in `ticket-mappers.ts` so the list still never ships whole bodies.

`TicketListPage` and `UsersPage` are the same screen twice — a `useInfiniteQuery` over the keyset cursor, a "Load more" button, and a skeleton that renders the real `<thead>` so column widths do not shift — but they no longer share a table layer. `UsersPage` stays hand-rolled markup; `TicketListPage` runs on **TanStack Table v9**, which is where sorting arrived. Port `UsersPage` when it needs one, not before.

The queue shows **one page of 10 at a time**, with Prev/Next and a "Page 3 of 10" counter — not the accumulating "Load more" it started as. `TICKET_PAGE_SIZE` in `packages/shared` is the single source of both the API's default `limit` and the divisor the SPA turns `total` into a page count with; two matching numbers would drift into a page count that is quietly wrong.

**The queue's whole state lives in the URL** — `?status=`, `?category=`, `?q=`, `?handled=`, `?sort=`/`?order=` and `?page=` (one-based), read back through the shared Zod schemas by `readQueueState` and written by `writeQueueState`, which omits anything still at its default so an untouched queue stays a bare `/`. `?handled=` is the one whose default is not "everything": it is `human`, matching the API's own default, which is what keeps a bare `/` and a bare `GET /api/tickets` the same queue — see Auto-resolution. It is there because opening a ticket *unmounts* `TicketListPage`: state in `useState` dies with it, so returning from a ticket used to land on page 1 of an unfiltered queue. In the query string it survives the round trip and a reload, the browser's Back button restores it for free, and a position in the queue becomes something an agent can paste. An unrecognised value falls back to the default rather than erroring, and every request is built from the *parsed* value, so `?status=pending` cannot reach the API.

Three consequences. A page index restored from the URL may name a page nothing has fetched — cursor pagination cannot jump, so an effect **walks `fetchNextPage` forward one request at a time**, and clamps (with `replace`) when the cursors run out, so `?page=99` shows the end of the queue rather than an empty table. Clamping on `pageCount` instead would pick the same destination earlier and save no request, since reaching the last page still means walking to it. The detail page's own "Back to tickets" is a fresh navigation to `/`, so the subject link carries the queue's address in `state.from` and `BackToQueue` reads it back (validated as a path, since history state survives a reload).

And the queue is **a different cache entry from the ticket**, so `PATCH /api/tickets/:id` succeeding writes `["ticket", id]` *and* invalidates `["tickets"]` by prefix. Without the second half, going back showed the old status: the walked pages are still cached and `staleTime` holds them for 30s. Invalidated rather than patched in place, because the change can move the row out of the queue entirely (resolve one under `?status=open`) or to another page (under `?sort=status`), and `total` — the page counter's divisor — moves with it. Nothing refetches at mutation time, since the queue is unmounted and its queries inactive; they go stale and refetch when the reader lands back on them. That refetch stops at the first page whose `nextCursor` is null, which is what makes `data.pages` shrink to what is really there and lets the clamp above catch a reader stranded past the new end.

The search box still holds **two pieces of state for one input** — `searchInput` (per keystroke) and `search`, now the URL's `q`, committed on a 300ms debounce and the only one in the query key. Without the split, "refund" is six requests with six cursors and the last to *arrive* wins rather than the last asked for. It commits with `replace: true` so six keystrokes are not six history entries, and it resets `pageIndex` like every other control that changes the row set. The reverse sync — a Back that changes `q` pulling the box along — is a **render-phase adjustment against a `syncedTerm` state**, not an effect: `react-hooks/set-state-in-effect` is an error in this repo, and the comparison is trimmed so the debounce's own commit does not snatch back a trailing space someone is still typing.

It is still `useInfiniteQuery` underneath, and the accumulation is still what makes it work: every page walked stays in `data.pages`, so **Prev is an index change rather than a request**, and only a first visit to a page touches the network. What changed is that the component renders `data.pages[pageIndex]` instead of flattening them all. Anything that changes the ordering or the row set — both filters, the search and the sort — goes through `applyFilters`, which resets `pageIndex` to 0: page 3 of the open tickets is not page 3 of all of them, and a cursor from one ordering names a position the next ordering does not have. Paging is the one change that keeps its index, and goes through `goToPage` instead.

v9 is not v8 with a new version number, and three of its differences bit during that port:

- **`useTable`, not `useReactTable`.** Features are opt-in and passed in: `tableFeatures({ rowSortingFeature })` at module scope, then `useTable({ features, … })`. `useReactTable`/`getCoreRowModel` still exist under `@tanstack/react-table/legacy` as the v8 shim; this app uses the native API.
- **A display column cannot sort** — `column_getCanSort` is gated on `!!column.accessorFn`. Every ticket column is therefore an accessor column, even the ones whose cell renders entirely from `row.original`; the accessor exists only to make the header clickable.
- **Every column's `TValue` must be annotated `unknown`.** Left to inference each column gets its own (`subject` a string, `status` a literal union) and the array becomes a union `useTable` cannot resolve. It has to be the accessor's return annotation, not just the array's type argument: `cell` takes a `CellContext<…, TValue>`, and a function parameter is contravariant, so a cell typed for `string` rejects the `Cell<…, unknown>` that `getAllCells()` returns. (`getAllCells`, not `getVisibleCells` — that one needs `columnVisibilityFeature`.)

**What keeps the browser from re-sorting is the *absent* `sortedRowModel`, not `manualSorting: true`.** With no sorted row model registered, `getRowModel()` is the core model and there is nothing to re-order with — flipping `manualSorting` alone changes nothing, which is worth knowing before trusting a test that claims to cover it. `manualSorting` stays as the declaration of intent, and earns its keep the day someone adds a sorted row model.

These guards hide UI; they are not the security boundary — the API is. Any admin-only endpoint needs its own server-side role check: `requireRole("admin")` from `apps/api/src/middleware/require-role.ts`, attached **to the route** rather than via `router.use` (a pathless `use` on a router mounted at `/api` would turn every unmatched `/api/*` into a 403 and make `notFoundHandler` unreachable — there is a regression test for exactly that).

The auth client sets no `baseURL`, so requests stay same-origin: in dev Vite proxies `/api`, `/healthz`, and `/readyz` to :3000, and in production the API serves the built SPA. The session cookie therefore never needs a cross-site exemption. `inferAdditionalFields` teaches the client about `role`, using values from `@helpdesk/shared` rather than `typeof auth` because `apps/web` must not depend on `apps/api`.

The proxy target is `API_PROXY_TARGET`, defaulting to :3000. Only the E2E suite overrides it — do not hardcode a port back into `vite.config.ts`.

**`strictPort: true` on the dev server, and it is load-bearing.** Vite's default is to take the next free port when 5173 is busy, which here is not a convenience but a broken app wearing a misleading error: the API pins both its CORS allowlist and Better Auth's `trustedOrigins` to `WEB_ORIGIN` (`http://localhost:5173`), and both compare the `Origin` header as a string — so a browser served from :5174 loads the page, renders the queue through the proxy, and has every sign-in refused with **403 `INVALID_ORIGIN`**. The message points at auth configuration when the fault is a second `bun run dev:web` somebody started and forgot. :5174 is also the E2E suite's own Vite port, so a drifted dev server sits exactly where the test server belongs. With `strictPort` the second server says "Port 5173 is already in use" and exits, which is the true statement. If you ever do need the SPA on another port, move `WEB_ORIGIN` with it — the two are one setting in two files.

### E2E (`e2e/`) runs on Node, against a second Postgres

`apps/api/src/app.test.ts` stubs auth and runs with no database. Playwright is the opposite end: the real Express app, real Better Auth, real Postgres, the SPA behind the real Vite proxy. It starts its own API on :3001 and Vite on :5174 so a running `bun run dev` neither collides with it nor is mistaken for it.

**Writing a spec? Delegate to the `e2e-test-writer` agent** (`.claude/agents/e2e-test-writer.md`) rather than hand-rolling one. It already carries the harness API, the locator rules, and the traps below, so a one-line brief is enough:

> Use the e2e-test-writer agent to cover the sign-out flow.

Give it the behavior to cover and let it choose the assertions — it reads the route component and API handler first, and it is instructed to push back rather than invent coverage for something unimplemented. It runs what it writes, and verifies each test fails when the assertion is inverted, so treat a report that skips those steps as incomplete. Do the work inline only for a one-line tweak to an existing spec, or when the change is to the harness itself — the agent is told not to touch `playwright.config.ts`, `global-setup.ts`, or `auth.setup.ts`, and that boundary is deliberate.

Keep that agent in sync when the harness changes: its fixture table and its list of what is worth covering both go stale as phases land.

- **`playwright test` is a Node process, not Bun.** Nothing under `e2e/` may import `bun`'s `SQL`, which rules out `apps/api/src/db/client.ts`. Direct database access there goes through the `postgres` driver (`e2e/fixtures/db.ts`); anything needing the app's own code — migrations, Better Auth password hashing — is shelled out to a Bun subprocess in `e2e/global-setup.ts`.
- **The test database is a separate server on :5433**, never a second database inside dev's :5432. The suite truncates whole schemas, and a separate server is what makes reaching dev data impossible rather than merely unlikely. `bun run db:up:test` provisions a local cluster in `.pgdata-test/` (`e2e/scripts/test-db.sh`); `compose.yaml` has an equivalent `postgres-test` service under the `test` profile for CI.
- **`.env.test` is committed** — every value in it is throwaway. Its `WEB_ORIGIN` must stay byte-identical to `baseURL` in `playwright.config.ts`: it feeds both the CORS allowlist and Better Auth's `trustedOrigins`, and both compare the `Origin` header as a string, so `localhost` and `127.0.0.1` are not interchangeable.
- **Sessions come from the `setup` project, not the login form.** `e2e/auth.setup.ts` signs in over `/api/auth/sign-in/email` and saves cookies to `e2e/playwright/.auth/*.json`; the `chromium` project loads the admin one by default. Going through `LoginPage.tsx` would make every test's setup break whenever that markup changed. Note that project carries its own `testDir` — it lives beside the config, not in `tests/`.
- **`workers: 1`**, because every worker shares the one database. Raising it means per-worker schemas, not a flag flip.

## Conventions

- **Relative imports carry the `.ts`/`.tsx` extension** (`allowImportingTsExtensions`). Workspace and package imports do not.
- `verbatimModuleSyntax` is on and ESLint enforces **inline type imports**: `import { foo, type Bar } from …`.
- `@/…` resolves to `apps/web/src` — web only, mirrored in both `tsconfig.json` and `vite.config.ts` because shadcn generates those imports.
- Strictness beyond `strict`: `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. Prefix intentionally unused params with `_`.
- `no-console` is a warning (`error`/`warn` allowed); use the pino `logger`, or `req.log` inside a request so lines carry the request ID. `env.ts` is exempt — it logs before the logger exists.
- Comments in this codebase explain **why**, usually a decision that looks wrong until you know the constraint. Match that when touching load-bearing code; skip it for the obvious.
