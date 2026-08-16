# E2E tests

Empty on purpose — this directory is the setup's deliverable, not its content.

Everything a spec needs is already wired up:

```ts
import { expect, test } from "@playwright/test";
import { SIGNED_OUT, STORAGE_STATE } from "../auth-state.ts";
import { E2E_USERS } from "../credentials.ts";
import { resetDomainData } from "../fixtures/db.ts";

// Tests run as `admin` unless the file says otherwise:
//   test.use({ storageState: STORAGE_STATE.agent })  // as an agent
//   test.use({ storageState: SIGNED_OUT })           // signed out

test.beforeEach(async () => {
  await resetDomainData(); // clears app data, keeps the session
});
```

Two things to know before adding files here:

- **Name them `*.spec.ts`.** `*.setup.ts` is claimed by the `setup` project, which
  mints the session cookies (`../auth.setup.ts`).
- The root `bun run test` is scoped to `apps` and `packages` precisely so Bun's
  runner does not try to collect these. Run them with `bun run test:e2e`.
