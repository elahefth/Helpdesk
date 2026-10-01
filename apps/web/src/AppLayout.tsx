import { useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TICKET_HANDLER_LABELS,
  TICKET_HANDLERS,
  ticketHandlerSchema,
  type ListTicketsResponse,
} from "@helpdesk/shared";
import { getReadiness, listTickets } from "./lib/api.ts";
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

  // Quiet when healthy and loud when not: a badge that is always there and
  // always green stops being read, which is the one thing it must not do on
  // the day the database goes away.
  if (label === "database down") {
    return <Badge variant="destructive">API: database down</Badge>;
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${label === "ready" ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
      />
      API: {label}
    </span>
  );
}

/** Up to two initials, for the avatar beside the signed-in name. */
function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
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
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary"
      >
        {initialsOf(session.user.name)}
      </span>
      <span className="text-sm font-medium">{session.user.name}</span>
      <Badge variant="secondary">{session.user.role}</Badge>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleSignOut()}
        disabled={isSigningOut}
      >
        {isSigningOut ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}

/**
 * The queue's three views, as destinations rather than as a select.
 *
 * `handledBy` is the one queue filter whose default hides something, so it
 * earns a place in the navigation rather than a control in a toolbar: each
 * view carries its own count, which is what makes the hidden tickets
 * discoverable at all — "Handled by AI 58" is a row nobody can miss, where a
 * select reading "Needs a human" says nothing about what it is leaving out.
 *
 * The labels are `TICKET_HANDLER_LABELS`, except `all`, whose bare "All" reads
 * as a stray word once it is a link in a list.
 */
const QUEUE_VIEWS = TICKET_HANDLERS.map((handledBy) => ({
  handledBy,
  label: handledBy === "all" ? "All tickets" : TICKET_HANDLER_LABELS[handledBy],
  // The default view is a bare "/", matching what the queue writes when every
  // control is at its default — one view, one address.
  to: handledBy === "human" ? "/" : `/?handled=${handledBy}`,
}));

const navItemClass =
  "flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const activeItemClass =
  "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-[inset_3px_0_0_var(--sidebar-primary)] shadow-xs";

/**
 * How many tickets each view holds, read off the list endpoint's own `total`.
 *
 * Deliberately not a new stats field: `total` is counted with exactly the
 * filters the page uses, so the sidebar and the page counter cannot disagree
 * about what "Needs a human" contains — a second definition of that set would
 * be the counter that lies. `limit: 1` keeps each request to one row plus the
 * count it exists for.
 *
 * Keyed under `["tickets"]` so the prefix invalidate a ticket PATCH already
 * does refreshes these too: resolving a ticket moves the numbers without any
 * extra wiring. The 30s poll is for what nobody on this page caused — mail
 * arriving, the assistant finishing a reply.
 */
function useQueueCounts(enabled: boolean) {
  return useQueries({
    queries: TICKET_HANDLERS.map((handledBy) => ({
      queryKey: ["tickets", "count", handledBy],
      queryFn: () => listTickets({ handledBy, limit: 1 }),
      select: (page: ListTicketsResponse) => page.total,
      enabled,
      refetchInterval: 30_000,
    })),
  });
}

/**
 * Everything a signed-in reader can go to, down the left-hand sidebar with the
 * wordmark. The queue views come first, with counts; the other pages sit
 * beneath them.
 *
 * Admin-only links are hidden here and guarded again by `RequireAdmin` on the
 * route — hiding the link is courtesy, the route guard is the rule. An agent
 * who types /users still gets redirected.
 */
function MainNav() {
  const { data: session } = useSession();
  const location = useLocation();
  const counts = useQueueCounts(Boolean(session));

  // Signed out, there is nowhere to navigate to. This also keeps the login
  // screen's header — which does not render this at all — consistent with the
  // brief moment after sign-out before the redirect lands.
  if (!session) return null;

  /**
   * `NavLink` matches on the pathname alone, and all three views live at "/",
   * so it would mark every one of them current at once. The active view is
   * read the way the queue reads it: off `?handled=`, through the shared
   * schema, falling back to the default. Not current anywhere but "/", so a
   * reader on a ticket sees no view claimed.
   */
  const activeView =
    location.pathname === "/"
      ? (ticketHandlerSchema.safeParse(
          new URLSearchParams(location.search).get("handled"),
        ).data ?? "human")
      : undefined;

  return (
    <nav
      aria-label="Main"
      className="flex gap-1 overflow-x-auto md:flex-1 md:flex-col md:gap-6 md:overflow-visible"
    >
      <div className="flex gap-1 md:flex-col md:gap-0.5">
        <p className="mb-1 hidden px-2.5 text-xs font-medium text-muted-foreground md:block">
          Queue
        </p>
        {QUEUE_VIEWS.map((view, index) => {
          const isActive = activeView === view.handledBy;
          const count = counts[index]?.data;
          return (
            <Link
              key={view.handledBy}
              to={view.to}
              aria-current={isActive ? "page" : undefined}
              className={`${navItemClass} ${isActive ? activeItemClass : ""}`}
            >
              {view.label}
              {count !== undefined && (
                <span
                  className={`text-xs tabular-nums ${isActive ? "font-semibold text-sidebar-primary" : "text-muted-foreground"}`}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      <div className="flex gap-1 md:mt-auto md:flex-col md:gap-0.5">
        {/*
         * No `end`: /dashboard has no children, so there is nothing for the
         * active state to over-match.
         */}
        <NavLink
          to="/dashboard"
          className={({ isActive }) =>
            `${navItemClass} ${isActive ? activeItemClass : ""}`
          }
        >
          Dashboard
        </NavLink>
        {session.user.role === "admin" && (
          <NavLink
            to="/users"
            className={({ isActive }) =>
              `${navItemClass} ${isActive ? activeItemClass : ""}`
            }
          >
            Users
          </NavLink>
        )}
      </div>
    </nav>
  );
}

/**
 * Two columns from `md` up: the sidebar holds where you can go, the top bar
 * holds who you are and whether the API is up. Below `md` the sidebar folds
 * into a strip across the top and its nav scrolls sideways, because a phone
 * has no room for a column of links beside a table.
 */
export function AppLayout() {
  return (
    <div className="min-h-full bg-background text-foreground md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3 border-b border-sidebar-border bg-sidebar px-4 py-3 text-sidebar-foreground md:sticky md:top-0 md:h-dvh md:gap-7 md:border-r md:border-b-0 md:px-3 md:py-5">
        <h1 className="px-2.5 text-base font-semibold tracking-tight text-foreground">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span
              aria-hidden="true"
              className="size-4.5 rounded-[5px] bg-sidebar-primary"
            />
            Helpdesk
          </Link>
        </h1>
        <MainNav />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-center justify-end gap-4 border-b px-6 py-3">
          <ApiStatusBadge />
          <UserMenu />
        </header>
        <main className="mx-auto w-full max-w-6xl px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
