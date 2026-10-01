# One image, one service: the API serves the built SPA (apps/api/src/spa.ts),
# so the browser talks to a single origin in production exactly as it does
# through Vite's proxy in dev.
#
# Bun pinned to the version bun.lock was written with. The lockfile format and
# the native `SQL` driver both move between Bun releases, and a floating tag is
# how a redeploy of an unchanged commit breaks.
ARG BUN_VERSION=1.3.14

# ---- build: full install, then the SPA bundle -------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app

# Manifests first, so a source-only change reuses the install layer. Every
# workspace's package.json is needed — including e2e's — or
# `--frozen-lockfile` sees a lockfile describing packages that are not there.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
# `build` is `tsc --noEmit && vite build`, so a type error fails the image
# rather than shipping.
RUN bun run --filter=@helpdesk/web build

# ---- runtime: production dependencies, API source, SPA bundle ---------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/
# Only what the API needs at runtime. `--filter` is the half that matters:
# `--production` alone still installs every workspace's dependencies — React,
# Base UI and lucide for a frontend that is already compiled into dist —
# and measured at twice the size. Migrations run through drizzle-orm's own
# migrator (src/migrate.ts), so drizzle-kit is not needed either. A few dev
# packages (vite, vitest) still land in the store as better-auth's optional
# peers; nothing imports them.
RUN bun install --frozen-lockfile --production --ignore-scripts \
      --filter '@helpdesk/api'

# Source, not a bundle: Bun runs TypeScript directly, @helpdesk/shared is
# consumed as source, and apps/api needs its drizzle/ migrations and
# knowledge-base.md on disk beside it.
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY --from=build /app/apps/web/dist apps/web/dist

USER bun
# Railway injects PORT; env.ts reads it. 3000 is only the fallback.
EXPOSE 3000
CMD ["bun", "apps/api/src/index.ts"]
