import { Navigate, Outlet } from "react-router";
import { useSession } from "../lib/auth-client.ts";

/**
 * Pathless layout route for admin-only screens. Nests inside `RequireAuth`, so
 * by the time this renders the session is already resolved and non-null — the
 * only question left is the role.
 *
 * Same caveat as RequireAuth: this hides UI, it does not protect data. Any
 * admin-only endpoint these pages call must check the role server-side too.
 */
export function RequireAdmin() {
  const { data: session } = useSession();

  if (session?.user.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
