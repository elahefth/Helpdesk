import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getReadiness } from "./lib/api.ts";
import { authClient, useSession } from "./lib/auth-client.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function ApiStatusBadge() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["readiness"],
    queryFn: getReadiness,
    refetchInterval: 30_000,
    // /readyz answers 503 when degraded; that is information, not a failure.
    retry: false,
  });

  const label = isPending
    ? "checking…"
    : isError || data?.status !== "ready"
      ? "database down"
      : "ready";

  const variant =
    label === "ready"
      ? "outline"
      : label === "checking…"
        ? "secondary"
        : "destructive";

  return <Badge variant={variant}>API: {label}</Badge>;
}

function UserMenu() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);

  if (!session) return null;

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      // Drop every cached response before the next person signs in — otherwise
      // an agent's queue is briefly visible to whoever logs in after them.
      queryClient.clear();
      await navigate("/login", { replace: true });
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium">{session.user.name}</span>
      <Badge variant="secondary">{session.user.role}</Badge>
      <Button
        variant="outline"
        onClick={() => void handleSignOut()}
        disabled={isSigningOut}
      >
        {isSigningOut ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  isActive
    ? "font-medium text-foreground"
    : "text-muted-foreground hover:text-foreground";

/**
 * The primary destinations, on the left beside the wordmark — the side a
 * reader starts on. What is on the right is about the session rather than the
 * app: which environment you are looking at, and who you are.
 *
 * Admin-only links are hidden here and guarded again by `RequireAdmin` on the
 * route — hiding the link is courtesy, the route guard is the rule. An agent
 * who types /users still gets redirected. Tickets is offered to everyone
 * signed in, which is every role there is.
 */
function MainNav() {
  const { data: session } = useSession();

  // Signed out, there is nowhere to navigate to. This also keeps the login
  // screen's header — which does not render this at all — consistent with the
  // brief moment after sign-out before the redirect lands.
  if (!session) return null;

  return (
    <nav className="flex items-center gap-4 text-sm">
      {/*
       * `end`, because the queue lives at "/" and every other route is nested
       * under it — without it this link is active on /users too. It is not a
       * separate /tickets path: one screen with two URLs is a thing to keep in
       * sync for no gain.
       */}
      <NavLink to="/" end className={navLinkClass}>
        Tickets
      </NavLink>
      {session.user.role === "admin" && (
        <NavLink to="/users" className={navLinkClass}>
          Users
        </NavLink>
      )}
    </nav>
  );
}

export function AppLayout() {
  return (
    <div className="min-h-full bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                <Link
                  to="/"
                  className="rounded-sm outline-none hover:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Helpdesk
                </Link>
              </h1>
            </div>
            <MainNav />
          </div>
          <div className="flex items-center gap-4">
            <ApiStatusBadge />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
