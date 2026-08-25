# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

**Bun, not Node/npm.** Everything runs through `bun` — the Postgres driver is Bun's native `SQL` class, and workspace deps use `workspace:*`. TypeScript is executed directly; there is no build step in dev. The exception is test runners: `bun:test` for `apps/api` and `packages`, **Vitest for `apps/web`** (React components), Playwright for `e2e`. See Testing below.

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
                       # -- --reset   to clear the table first; idempotent otherwise

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

The implementation plan's phase numbering is still the shared vocabulary — code comments reference "Phase 6" and "Phase 7" to mark deliberate placeholders. Current state is roughly Phase 0 complete, Phase 4 (auth) landed early, and the plain half of Phase 5 (email → ticket) landed after it: `db/schema.ts` re-exports the auth tables plus `ticket`, `GET /api/tickets` reads real rows, and there is no worker, no AI, and no email *provider*.

The domain vocabulary was cut down when ingestion landed, and `packages/shared/src/domain.ts` no longer matches project-scope.md: statuses are `open | resolved | closed` (no `new`, no `pending`) and categories are `general_questions | technical | refund_request`. Nothing classifies, so a longer list would only be filters that always return nothing. `TICKET_PRIORITIES` and `ROUTING_QUEUES` are still there, consumed by nothing, as the shape a later phase grows into.

## Architecture

Four workspaces: `apps/api` (Express 5), `apps/web` (React 19 SPA), `packages/shared`, and `e2e` (Playwright).

### `packages/shared` is the contract

Consumed as **source**, not built — `main` points at `src/index.ts`. It holds the domain enums (`TICKET_STATUSES`, `USER_ROLES`, categories) and every request/response Zod schema. Both sides import it, and both sides *use* it at runtime: the API parses query strings with `listTicketsQuerySchema` and the SPA parses responses with `listTicketsResponseSchema` (`apps/web/src/lib/api.ts`). A contract change is therefore a type error at build time and a loud throw at runtime, not a silent `undefined`. Add new API shapes here rather than inline.

### The API boots without Postgres, and fails closed

`getDb()` returns `Database | undefined` — `DATABASE_URL` is optional by design so `/readyz` can report `degraded` instead of the process crash-looping. Consequences that propagate through the codebase:

- `createAuth(db)` and `requireAuth(auth)` are **factories taking the handle**, not module-level singletons. Keep new db-dependent modules in that shape.
- With no database there is no auth instance, so `requireAuth` answers 401 to everything rather than waving requests through.
- `createApp({ auth })` accepts an injected auth instance purely as a test seam.

### Middleware order in `app.ts` is load-bearing

`helmet` → `cors` → `requestContext` → **Better Auth mount** → `express.json()` → health routes → **inbound-email router** → `requireAuth` + app routes → 404 → error handler.

Better Auth reads the raw request body itself, so its `app.all("/api/auth/*splat", …)` mount **must stay above `express.json()`** or auth requests hang. Express 5 rejects a bare `"*"` — hence the named splat. The 404 and error handlers must stay last, and `errorHandler` must keep all four parameters (Express identifies error middleware by arity).

The inbound-email router is the one app router above `requireAuth`, because a mail source has no session — see Ingestion below. It is mounted at `"/api"` with a path (`/inbound-email`) inside it, not pathlessly, so every other `/api/*` request still falls through to the guarded routers and on to `notFoundHandler` — the same trap `requireRole` documents.

Express 5 forwards rejected promises from async handlers to the error handler, so route handlers throw `HttpError.badRequest(…)` / let `ZodError` escape rather than wrapping themselves in try/catch. Every response carries an `x-request-id`, echoed into error bodies.

### Auth

Staff-only console: students never log in. Sessions live in the `session` table (no `cookieCache`, no `secondaryStorage`) specifically so an admin can revoke access with a `DELETE`.

- **HTTP sign-up is closed** via `databaseHooks.user.create.before` in `apps/api/src/auth.ts`, which throws when `ctx.request` exists. `disableSignUp` is deliberately not used because it would also block in-process `auth.api.signUpEmail()`, leaving no way to create the first user. In-process calls have no `ctx.request`, which is the seam `seed.ts` uses.
- **`role` is `input: false`**, so no HTTP payload can grant `admin`. `seed.ts` sets the role with a direct `UPDATE` after sign-up.
- `seed.ts` is idempotent and **never changes an existing account's password** — re-running only corrects the role. There is no password-reset path in the repo.
- **`POST /api/users` is the second door**, and the only one over HTTP: admin-gated, and it reaches Better Auth through the same in-process seam (`auth.api.signUpEmail({ body })` with no `headers`/`request` — forwarding the Express `req` would trip the gate above and answer "Sign up is disabled"). Accounts it creates are always `agent`, because `role` is `input: false`. Two consequences worth knowing before touching it: `emailAndPassword.autoSignIn` must stay on, since turning it off switches Better Auth's duplicate-email reply to a *synthetic* user and the route would report success while creating nothing; and because it is on, sign-up writes a session row for an account nobody has signed into, which the route deletes to keep "a session row means someone is signed in" true.
- **`PATCH /api/users/:id` edits one**, admin-gated the same way. Name and email are plain columns and are written with Drizzle; the password is not, and goes through `auth.$context` (`password.hash` + `internalAdapter.updatePassword`, creating the `credential` row if one is somehow missing). That mirrors what Better Auth's admin plugin does in `setUserPassword` — mirrored rather than adopted, because enabling that plugin to reach one function would also mount `/api/admin/*`: set-role, ban, impersonate. Three things about it are load-bearing. **A blank or whitespace-only password means "leave it alone"**, normalised to `undefined` by `updateUserBodySchema` so the route has one case to branch on. **A password change deletes the target's session rows**, including the admin's own when they edit themselves — otherwise resetting a compromised account leaves the intruder holding a valid multi-day cookie, and no `cookieCache` is exactly what makes deleting rows sufficient. **The two writes are not atomic** (Better Auth's adapter holds its own handle), so the row is written *first*: a failed password write leaves a retryable state, whereas the reverse order could answer a duplicate-email 409 after the password had already changed.
- **`DELETE /api/users/:id` is a soft delete**, admin-gated, and **admin accounts are exempt** — the route answers 403 for a target whose role is `admin`, which is the actual rule; the SPA merely omits the button. The row survives because `session` and `account` cascade from it and because Phase 7's tickets will need to name whoever handled them. Three things enforce what "deleted" means, and all three are load-bearing: every read in `routes/users.ts` carries `isNull(user.deletedAt)` (so a marked row is unlistable *and* uneditable), `databaseHooks.session.create.before` in `auth.ts` refuses the account a new session, and `requireAuth` refuses one that still holds an old one. Guarding `/sign-in/email` instead of the session insert would have left every future credential or social route open by default. The hook throws Better Auth's own `INVALID_EMAIL_OR_PASSWORD` verbatim so a deleted account is indistinguishable from a wrong password. Unlike PATCH's password write, both statements here are Drizzle's, so they share a **transaction** — marking the row without clearing sessions would leave a deleted account signed in until its cookie expired.
- **`deletedAt` is declared in `auth.ts` as a `user.additionalFields` entry, not added to `db/auth-schema.ts`.** That file is generated; a hand-added column disappears the next time anyone regenerates it. Declaring the field is what makes `@better-auth/cli generate` emit it, and it is `input: false` so no payload can set or clear it. The regeneration added exactly one line. It also means `deletedAt` rides along on the session user, which is what lets `requireAuth` check it.
- **A deleted user keeps its email.** `user.email` is still UNIQUE, so the address stays reserved and re-creating that person fails — `emailConflict` in `routes/users.ts` answers "That email belongs to a deleted user" rather than the generic duplicate message, because otherwise an admin is told an address is taken by someone who appears in no list. There is no restore path; adding one is the natural way to make the address reachable again.
- **Email is stored lowercased, and that is load-bearing.** Better Auth lowercases the address at sign-up and its `findUserByEmail` lowercases the address it is *given* before comparing it to the column, so a row whose email carries a capital is unreachable by every sign-in — and a password reset does not recover it, because the lookup fails before a password is checked. Creating a user goes through Better Auth and is normalised for free; `PATCH /api/users/:id` writes the column directly and is not, so the `.toLowerCase()` lives on the shared `email` field in `packages/shared/src/api.ts`, where both routes and both forms pick it up. `packages/shared/src/api.test.ts` pins it. Anything else that writes `user.email` directly must normalise too.
- **A unique-violation from Drizzle is not the driver's error.** Drizzle wraps it in a `DrizzleQueryError` and keeps the original on `cause`, so `isDuplicateEmail` in `routes/users.ts` walks the cause chain to find Bun's `errno` (the SQLSTATE — `code` is Bun's own constant and the same for every failure) and the constraint name. Reading those off the thrown object alone passes a driver-level probe and turns every duplicate email into a 500; `routes/users.test.ts` pins it, since no test with a stubbed database can.
- `apps/api/src/db/auth-schema.ts` is generated by `@better-auth/cli generate` through `auth.cli.ts` — never hand-edit it. Hand-written domain tables live beside it in `ticket-schema.ts`; `db/schema.ts` re-exports both so `drizzle.config.ts` and `drizzle({ schema })` see one file.
- A `better-auth-best-practices` skill is available in `.claude/skills/` (symlinked from `.agents/skills/`).

### Ingestion — email becomes a ticket

`POST /api/inbound-email` is the whole of it. One delivered email becomes one `ticket` row; there is no worker, no queue, no message table, and no classifier.

- **It is the API's only unauthenticated write, and necessarily so.** Whatever delivers the mail — a provider webhook, a forwarding script, `bun run email:send` — holds no session and never will. It is mounted at `/api` *above* `requireAuth` in `app.ts` for that reason, and `INBOUND_EMAIL_SECRET` presented as `x-inbound-secret` stands in for the session. That secret is optional in development (a local `curl` should not need a ceremony) and `env.ts` refuses to boot in production without one, exactly like `BETTER_AUTH_SECRET`. The comparison lives in the exported pure function `isAuthorizedSource` because `env` is parsed once at import — a test cannot configure a secret and then make a request against it, so the guard has to be reachable some other way, and an untested guard on the one open write is not worth having.
- **`inboundEmailBodySchema` is the provider seam, not a provider payload.** It is the small intersection every provider can produce; a Mailgun or SES adapter's entire job becomes mapping its webhook onto this shape and posting it, so nothing downstream ever sees a provider-shaped object. It is `strictObject` for a sharper reason than the user writes: a plain `z.object` strips unknown keys, so an adapter that spelled the body `bodyText` would have the email's contents silently dropped and still be answered 201.
- **`SUPPORT_EMAIL` is enforced, not decorative.** The route answers 422 `wrong_recipient` for mail addressed elsewhere, which is what keeps this from being an open "create a ticket about anything" endpoint. Both sides are lowercased — the schema's `to` field and `env.ts`'s value — or a provider that capitalises the address would have every delivery refused.
- **`source_message_id` is UNIQUE, and that is the idempotency.** Insert is `onConflictDoNothing` on that column, in one statement: a provider retrying a slow webhook is the normal case, and SELECT-then-INSERT would lose that race. A conflicting delivery is answered **200 with the existing ticket** rather than 409 — the mail *was* accepted, the first time. `messageId` is optional because not every source has one, and Postgres treats NULLs as distinct under a unique index, so unidentified mail is simply never deduplicated rather than colliding with the last such row.
- **`student_name` is nullable and is never an identity.** It is the display name half of `From: "Ada Student" <ada@example.com>`, and splitting the header is the *adapter's* job — RFC 5322 allows quoted strings, escapes and RFC 2047 encoded words in there, and a regex over the raw header does not belong in a package the browser also imports. Null for mail that carried a bare address and for every ticket ingested before the column existed, so a renderer must always fall back to `student_email` — which is the column `ticket_student_email_idx` groups by, because two people can share a display name and one person can change theirs between emails.
- **`category` is nullable and nothing infers it.** Only a source that genuinely knows (a category-specific alias, a web form) may state one. A default would be a guess indistinguishable from a decision to everyone downstream; the SPA renders the null as "unclassified".
- **`ticket` timestamps are `timestamptz`**, unlike the generated auth tables, which are not. The list pages on `created_at`/`updated_at` with a keyset cursor, and the driver round-tripping a naive timestamp through the host's local offset would silently skip or repeat rows at every page boundary. `received_at` is separate from `created_at` on purpose: replaying an archive must not make every ticket look like it arrived today.
- **Ticket sorting is server-side, and `routes/ticket-sort.ts` is the whole of it.** One `SORTS` table holds, per `TicketSortKey`, the SQL expression, whether it is nullable, how to read a cursor value off a row, and how to bind one back. The ORDER BY and the keyset predicate are built from the *same* expression — they have to be, or the two queries that make up a page boundary disagree about where it was. Four things there are load-bearing:
  - **`total` rides along on every list response**, counted with the same filters as the page and *without* the cursor. It costs a second query per request, which cursor pagination partly exists to avoid, and it is there because "Page 3 of 10" cannot be derived from a cursor — a cursor knows whether a next page exists, never how many follow. Build the filter predicate once and pass it to both queries: a count that sees different filters than the page is a counter that lies.
  - **The cursor is a `[value, id]` JSON pair, base64url'd**, unlike the user list's single email — no sortable column is unique, and without the `id` tiebreaker two tickets sharing a status come back in whatever order the plan produced, which is how keyset pagination drops and repeats rows. JSON rather than `value|id` because a subject is user-supplied text and may contain the separator.
  - **`sender` sorts on `coalesce(student_name, student_email)`** — the same fallback the cell renders, so the column sorts the way it reads. Sorting the raw `student_name` would gather every nameless sender into one block.
  - **A nullable sort column (`category`, the only one) leads its ORDER BY with `IS NULL`**, so unclassified is the tail in *both* directions rather than flipping to the head on desc, and its keyset predicate carries an explicit `IS NULL` branch. The plain row-value tuple is wrong twice over there and both are silent: a NULL makes the comparison NULL rather than false, so the tail is unreachable and page two just ends early; and once the cursor is *inside* the tail there is no value left to compare.
  - **`ticket` timestamps are `precision: 3`.** Postgres defaults to microseconds and a JS `Date` holds milliseconds, so without it the driver truncates on read and a cursor lands a hair below the row it names — invisible descending, an infinite one-row loop ascending. `routes/ticket-sort.test.ts` pins both the column type and the round-trip.
- **The seeded corpus is 100 committed fixtures, delivered over HTTP.** `dev/ticket-fixtures.ts` holds them and `dev/seed-tickets.ts` posts each one to `POST /api/inbound-email` with a deterministic Message-ID, so a rerun is idempotent by the same unique index a retrying provider hits. It then writes `created_at`, `updated_at` and `status` **directly**, which is the one place anything reaches around the API: ingestion stamps `created_at` with the row default and every ticket is born `open`, and there is no status-change endpoint yet — without the fix-up all hundred tickets would have been created this afternoon and none would ever have been resolved, which makes the date sort and the status filter impossible to check by eye. Move the status half into `PATCH /api/tickets/:id` when that lands.
- **The corpus's spread is load-bearing, and `dev/ticket-fixtures.test.ts` pins it.** Subjects start across the whole alphabet, senders repeat and nine carry no display name, ~18% are unclassified, statuses skew with age, and `daysAgo` is irregular with a few same-day collisions. Each of those exists because a corpus that is uniform in one column makes that column's sort look broken rather than look sorted — the same-day rows, for instance, are the only thing that exercises the cursor's id tiebreaker from the UI.
- **`apps/api/src/dev/send-inbound-email.ts` is the only source there is.** It posts the same normalised payload a real adapter would, to the same endpoint, so it exercises the real path rather than a test double — which is why there is no `EmailSource` interface yet: it would describe an integration nobody has written.

### Web

Routing is defined in one place, `apps/web/src/main.tsx`. `/login` sits outside the layout; **everything else nests under `RequireAuth`** so a new route is protected by default. `RequireAdmin` nests inside that for admin-only screens.

The queue lives at the index route, `/`, and the nav links to it with `end` — there is no separate `/tickets` path, because one screen with two URLs is a thing to keep in sync for no gain. `MainNav` in `AppLayout.tsx` sits on the left with the wordmark; the right-hand group is about the session (environment, identity) rather than the app. `AppLayout.test.tsx` asserts that as *containment*, not document order: the header is `justify-between`, so a nav moved to the right still follows the wordmark and still precedes the sign-out button — an order check passes on both layouts and tests nothing.

`TicketListPage` and `UsersPage` are the same screen twice — a `useInfiniteQuery` over the keyset cursor, a "Load more" button, and a skeleton that renders the real `<thead>` so column widths do not shift — but they no longer share a table layer. `UsersPage` stays hand-rolled markup; `TicketListPage` runs on **TanStack Table v9**, which is where sorting arrived. Port `UsersPage` when it needs one, not before.

The queue shows **one page of 10 at a time**, with Prev/Next and a "Page 3 of 10" counter — not the accumulating "Load more" it started as. `TICKET_PAGE_SIZE` in `packages/shared` is the single source of both the API's default `limit` and the divisor the SPA turns `total` into a page count with; two matching numbers would drift into a page count that is quietly wrong.

It is still `useInfiniteQuery` underneath, and the accumulation is still what makes it work: every page walked stays in `data.pages`, so **Prev is an index change rather than a request**, and only a first visit to a page touches the network. What changed is that the component renders `data.pages[pageIndex]` instead of flattening them all. Anything that changes the ordering or the row set — both filters, and the sort — must also reset `pageIndex` to 0: page 3 of the open tickets is not page 3 of all of them, and a cursor from one ordering names a position the next ordering does not have.

v9 is not v8 with a new version number, and three of its differences bit during that port:

- **`useTable`, not `useReactTable`.** Features are opt-in and passed in: `tableFeatures({ rowSortingFeature })` at module scope, then `useTable({ features, … })`. `useReactTable`/`getCoreRowModel` still exist under `@tanstack/react-table/legacy` as the v8 shim; this app uses the native API.
- **A display column cannot sort** — `column_getCanSort` is gated on `!!column.accessorFn`. Every ticket column is therefore an accessor column, even the ones whose cell renders entirely from `row.original`; the accessor exists only to make the header clickable.
- **Every column's `TValue` must be annotated `unknown`.** Left to inference each column gets its own (`subject` a string, `status` a literal union) and the array becomes a union `useTable` cannot resolve. It has to be the accessor's return annotation, not just the array's type argument: `cell` takes a `CellContext<…, TValue>`, and a function parameter is contravariant, so a cell typed for `string` rejects the `Cell<…, unknown>` that `getAllCells()` returns. (`getAllCells`, not `getVisibleCells` — that one needs `columnVisibilityFeature`.)

**What keeps the browser from re-sorting is the *absent* `sortedRowModel`, not `manualSorting: true`.** With no sorted row model registered, `getRowModel()` is the core model and there is nothing to re-order with — flipping `manualSorting` alone changes nothing, which is worth knowing before trusting a test that claims to cover it. `manualSorting` stays as the declaration of intent, and earns its keep the day someone adds a sorted row model.

These guards hide UI; they are not the security boundary — the API is. Any admin-only endpoint needs its own server-side role check: `requireRole("admin")` from `apps/api/src/middleware/require-role.ts`, attached **to the route** rather than via `router.use` (a pathless `use` on a router mounted at `/api` would turn every unmatched `/api/*` into a 403 and make `notFoundHandler` unreachable — there is a regression test for exactly that).

The auth client sets no `baseURL`, so requests stay same-origin: in dev Vite proxies `/api`, `/healthz`, and `/readyz` to :3000, and in production the API serves the built SPA. The session cookie therefore never needs a cross-site exemption. `inferAdditionalFields` teaches the client about `role`, using values from `@helpdesk/shared` rather than `typeof auth` because `apps/web` must not depend on `apps/api`.

The proxy target is `API_PROXY_TARGET`, defaulting to :3000. Only the E2E suite overrides it — do not hardcode a port back into `vite.config.ts`.

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
