import { useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getReadiness } from "./lib/api.ts";
import { authClient, useSession } from "./lib/auth-client.ts";

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

  const tone =
    label === "ready"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : label === "checking…"
        ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200";

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      API: {label}
    </span>
  );
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
      <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {session.user.role}
      </span>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={isSigningOut}
        className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
      >
        {isSigningOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

export function AppLayout() {
  return (
    <div className="min-h-full bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Helpdesk</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
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
