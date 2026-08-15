import { Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { getReadiness } from "./lib/api.ts";

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
          <ApiStatusBadge />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
