# Deploying to Railway

One Railway service runs the whole app: the API serves the built SPA, so the
browser talks to a single origin, exactly as it does through Vite's proxy in
dev. A second service is Railway's managed Postgres. pg-boss (the background
job queue) lives inside that same database, so there is nothing else to run.

The repo carries everything Railway needs:

| File | What it does |
|---|---|
| `Dockerfile` | Builds the SPA, then a runtime image with production dependencies, the API source and `apps/web/dist`. |
| `railway.json` | Builds with the Dockerfile, runs migrations before each deploy, health-checks `/healthz`. |
| `apps/api/src/migrate.ts` | The pre-deploy migration (drizzle-orm's migrator; drizzle-kit is not in the image). |

## First deploy

1. **Create a project** and add **PostgreSQL** (New → Database → PostgreSQL).
2. **Add the app**: New → GitHub Repo → this repository. Railway finds
   `railway.json` and builds from the `Dockerfile`. Leave the root directory
   as the repo root; the image needs every workspace.
3. **Generate a domain**: the service → Settings → Networking → Generate
   Domain. The app reads `RAILWAY_PUBLIC_DOMAIN` and uses it for both
   `WEB_ORIGIN` and `BETTER_AUTH_URL`, so there is nothing to copy.
4. **Set the variables** on the app service (Variables → Raw Editor):

   ```bash
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   BETTER_AUTH_SECRET=        # openssl rand -base64 32
   INBOUND_EMAIL_SECRET=      # openssl rand -base64 32
   SUPPORT_EMAIL=support@your-domain.com

   # Optional: Polish, Summarize, the classifier and the auto-resolver.
   # Without a key the buttons answer 503 and tickets are left for a person.
   OPENROUTER_API_KEY=
   OPENROUTER_MODEL=mistralai/mistral-small-3.2-24b-instruct,google/gemini-2.5-flash-lite,google/gemma-4-31b-it:free
   ```

   `NODE_ENV=production` and `PORT` are already handled (the image sets the
   first, Railway injects the second). Do not set `WEB_ORIGIN` or
   `BETTER_AUTH_URL` unless you use a custom domain (see below).
5. **Deploy.** The pre-deploy step applies migrations, and the release goes
   live once `/healthz` answers. If a migration fails, the release stops and
   the previous deployment keeps serving.
6. **Create the first admin.** HTTP sign-up is closed by design, so the first
   account is made in-process, from inside the running container:

   ```bash
   railway ssh
   bun apps/api/src/seed.ts --email=you@example.com --password='…' --name="You" --role=admin
   ```

   After that, admins add colleagues from the Users page. If the last admin
   forgets their password, `bun apps/api/src/dev/reset-password.ts
   --email=… --password=…` from the same shell is the way back in.

## The app refuses to boot when…

…the configuration would produce a deploy that looks up and does not work:

- `BETTER_AUTH_SECRET` or `INBOUND_EMAIL_SECRET` is missing.
- `WEB_ORIGIN` or `BETTER_AUTH_URL` still points at `localhost`, which happens
  when no domain has been generated yet. Otherwise every sign-in would fail
  with `INVALID_ORIGIN`.

The deploy log shows the variable and what to set.

## Custom domain

Add it under Settings → Networking, then set both URLs explicitly. Explicit
values always beat the `RAILWAY_PUBLIC_DOMAIN` default:

```bash
WEB_ORIGIN=https://support.example.com
BETTER_AUTH_URL=https://support.example.com
```

Both compare as exact strings, so use the address people will type, with no
trailing slash.

## Receiving email

Point your mail provider's inbound webhook (or a forwarding script) at
`https://<domain>/api/inbound-email` with the header
`x-inbound-secret: <INBOUND_EMAIL_SECRET>`. Mail must be addressed to
`SUPPORT_EMAIL` or it is refused with 422. There is no provider adapter in the
repo yet: the payload is `inboundEmailBodySchema` in `packages/shared`.
Replies are recorded in the console but not sent.

## Operating notes

- **Health**: `/healthz` is liveness (the deploy gate); `/readyz` reports
  whether the database is reachable.
- **Knowledge base**: `apps/api/knowledge-base.md` ships in the image and is
  read once at boot, so changing it means committing and redeploying. That is
  deliberate: it is policy, and it should have a diff.
- **Replicas**: safe. Job dispatch is a row lock in Postgres, so replicas share
  the classifier and resolver work rather than duplicating it.
- **Shutdown**: on SIGTERM the server drains for up to 10s. Jobs in flight are
  abandoned and picked up again by the next process.
