import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { USER_ROLES } from "@helpdesk/shared";

/**
 * No `baseURL`: it defaults to `window.location.origin`, which is exactly what
 * keeps auth requests same-origin. In dev the Vite proxy forwards `/api` to the
 * API on :3000, and in production the API serves the built SPA — either way the
 * session cookie rides along without a cross-site exemption.
 *
 * `role` is a Better Auth `additionalField` on the server, so the client only
 * knows about it if told. The manual form of `inferAdditionalFields` is used
 * (rather than `<typeof auth>`) because `apps/web` does not depend on
 * `apps/api`; the role values come from @helpdesk/shared so the two cannot
 * drift apart silently.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [
    inferAdditionalFields({
      user: { role: { type: [...USER_ROLES] } },
    }),
  ],
});

export const { useSession, signIn, signOut } = authClient;
