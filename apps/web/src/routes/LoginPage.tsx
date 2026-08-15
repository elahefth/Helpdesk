import { Navigate, useLocation, useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { authClient, useSession } from "../lib/auth-client.ts";

/**
 * Colocated rather than in @helpdesk/shared: that package holds the contracts
 * *this* API builds its responses from, and `/api/auth/*` belongs to Better
 * Auth. This schema only describes what the form collects before handing off.
 */
const loginSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

type LoginValues = z.infer<typeof loginSchema>;

/** Red border on an invalid field — paired with the message, never alone. */
const fieldClasses = (isInvalid: boolean) =>
  `w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm ${
    isInvalid
      ? "border-red-500 dark:border-red-500"
      : "border-neutral-300 dark:border-neutral-700"
  }`;

/**
 * There is no sign-up path by design: `databaseHooks.user.create.before` in
 * apps/api/src/auth.ts rejects any sign-up that arrives over HTTP, so accounts
 * exist only where an admin creates them.
 */
export function LoginPage() {
  const { data: session, isPending: isSessionPending } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  // Where the guard bounced us from, so a deep link survives the detour.
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: LoginValues) => {
    // Better Auth resolves with an `error` field rather than throwing, so the
    // failure has to be moved onto the form by hand.
    const { error } = await authClient.signIn.email(values);

    if (error) {
      // Deliberately not attached to the email field: saying which half of the
      // pair was wrong tells an attacker which addresses have accounts.
      setError("root", {
        message:
          error.status === 401
            ? "Invalid email or password."
            : (error.message ?? "Could not sign in. Please try again."),
      });
      return;
    }

    await navigate(from, { replace: true });
  };

  if (session) return <Navigate to="/" replace />;

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
          // noValidate hands validation to Zod, so the messages match the ones
          // the rest of the app renders instead of the browser's own bubbles.
          noValidate
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
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
              autoFocus
              autoComplete="email"
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? "email-error" : undefined}
              {...register("email")}
              className={fieldClasses(Boolean(errors.email))}
            />
            {errors.email && (
              <p
                id="email-error"
                className="text-sm text-red-700 dark:text-red-300"
              >
                {errors.email.message}
              </p>
            )}
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
              autoComplete="current-password"
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? "password-error" : undefined}
              {...register("password")}
              className={fieldClasses(Boolean(errors.password))}
            />
            {errors.password && (
              <p
                id="password-error"
                className="text-sm text-red-700 dark:text-red-300"
              >
                {errors.password.message}
              </p>
            )}
          </div>

          {errors.root && (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {errors.root.message}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting || isSessionPending}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
          Staff only. Accounts are created by an administrator.
        </p>
      </div>
    </div>
  );
}
