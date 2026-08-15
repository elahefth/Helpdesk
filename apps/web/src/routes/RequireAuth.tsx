import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../lib/auth-client.ts";

/**
 * Pathless layout route wrapping everything that needs a session.
 *
 * This is a convenience, not the security boundary — `requireAuth` on the API
 * is (apps/api/src/middleware/require-auth.ts). Hiding the UI just spares an
 * agent a screen full of 401s.
 */
export function RequireAuth() {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  // The session is resolved by a request, so on a cold load there is a moment
  // where "signed in" is not yet knowable. Rendering the redirect here would
  // bounce an authenticated user to the login screen on every refresh.
  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-sm text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        Loading…
      </div>
    );
  }

  if (!session) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <Outlet />;
}
