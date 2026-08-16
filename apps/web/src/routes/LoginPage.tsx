import { Navigate, useLocation, useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { authClient, useSession } from "../lib/auth-client.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl tracking-tight">Helpdesk</CardTitle>
            <CardDescription>AI drafts. The agent decides.</CardDescription>
          </CardHeader>

          <CardContent>
            <form
              // noValidate hands validation to Zod, so the messages match the
              // ones the rest of the app renders instead of the browser's own
              // bubbles.
              noValidate
              onSubmit={(event) => void handleSubmit(onSubmit)(event)}
              className="space-y-4"
            >
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoFocus
                  autoComplete="email"
                  // Input styles its own invalid state off aria-invalid, so the
                  // red border and the message stay in lockstep.
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  {...register("email")}
                />
                <FieldError id="email-error" errors={[errors.email]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={
                    errors.password ? "password-error" : undefined
                  }
                  {...register("password")}
                />
                <FieldError id="password-error" errors={[errors.password]} />
              </Field>

              {errors.root && (
                <Alert variant="destructive">
                  <AlertDescription>{errors.root.message}</AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                size="lg"
                disabled={isSubmitting || isSessionPending}
                className="w-full"
              >
                {isSubmitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Staff only. Accounts are created by an administrator.
        </p>
      </div>
    </div>
  );
}
