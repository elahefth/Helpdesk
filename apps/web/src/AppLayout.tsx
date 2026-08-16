import { useState } from "react";
import { Outlet, useNavigate } from "react-router";
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

export function AppLayout() {
  return (
    <div className="min-h-full bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Helpdesk</h1>
            <p className="text-sm text-muted-foreground">
              AI drafts. The agent decides.
            </p>
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
