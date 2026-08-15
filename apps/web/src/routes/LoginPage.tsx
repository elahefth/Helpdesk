import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { authClient, useSession } from "../lib/auth-client.ts";

/**
 * There is no sign-up path by design: `databaseHooks.user.create.before` in
 * apps/api/src/auth.ts rejects any sign-up that arrives over HTTP, so accounts
 * exist only where an admin creates them.
 */
export function LoginPage() {
  const { data: session, isPending: isSessionPending } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Where the guard bounced us from, so a deep link survives the detour.
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const signIn = useMutation({
    mutationFn: async () => {
      // Better Auth resolves with an `error` field rather than throwing, so it
      // has to be rethrown for TanStack Query to see a failure.
      const { error } = await authClient.signIn.email({ email, password });
      if (error) {
        throw new Error(
          error.status === 401
            ? "Invalid email or password."
            : (error.message ?? "Could not sign in. Please try again."),
        );
      }
    },
    onSuccess: () => {
      void navigate(from, { replace: true });
    },
  });

  if (session) return <Navigate to="/" replace />;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    signIn.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-6 py-12 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Helpdesk</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            AI drafts. The agent decides.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
        >
          <div className="space-y-1.5">
            <label
              htmlFor="email"
              className="block text-sm text-neutral-500 dark:text-neutral-400"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-neutral-700"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password"
              className="block text-sm text-neutral-500 dark:text-neutral-400"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-neutral-700"
            />
          </div>

          {signIn.isError && (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {signIn.error.message}
            </p>
          )}

          <button
            type="submit"
            disabled={signIn.isPending || isSessionPending}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
          Staff only. Accounts are created by an administrator.
        </p>
      </div>
    </div>
  );
}
