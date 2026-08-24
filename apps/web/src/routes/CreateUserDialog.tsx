import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "lucide-react";
import { createUserBodySchema, type CreateUserBody } from "@helpdesk/shared";
import { ApiRequestError, createUser } from "../lib/api.ts";
import { UserFormField } from "./UserFormField.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * The "New user" button and the modal behind it, kept together so `UsersPage`
 * mounts one component and owns none of the open state.
 *
 * POST /api/users is the only HTTP path that creates an account — sign-up is
 * closed (apps/api/src/auth.ts) — and it is admin-gated on the server, so this
 * living inside `RequireAdmin` hides the button but is not what enforces it.
 */
export function CreateUserDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <PlusIcon />
            New user
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            Creates a staff account with the agent role. The API will not accept
            a role from this form, so promoting someone to admin stays a
            separate, deliberate act.
          </DialogDescription>
        </DialogHeader>

        {/*
         * Mounted only while the dialog is open — the popup unmounts on close —
         * so `useForm` starts over on every open. That is why there is no
         * reset() call anywhere: a half-typed email or a server error from the
         * last attempt cannot survive into the next one.
         */}
        <CreateUserForm onCreated={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserBody>({
    // The same schema the API parses the body with, so the form cannot disagree
    // with the server about what "valid" means.
    resolver: zodResolver(createUserBodySchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const onSubmit = async (values: CreateUserBody) => {
    try {
      await createUser(values);
    } catch (error) {
      // A duplicate email is attached to the field that caused it. Unlike the
      // login form, there is no enumeration concern to weigh: the only person
      // who can reach this endpoint can already list every account.
      if (error instanceof ApiRequestError && error.status === 409) {
        setError("email", { message: error.message });
        return;
      }

      setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "Could not create the user. Please try again.",
      });
      return;
    }

    // Prefix match, so it invalidates every ["users", { role }] entry rather
    // than only the filter currently on screen — the new agent belongs in the
    // unfiltered list and in role=agent, and a stale cached page would
    // otherwise be waiting behind whichever filter the admin picks next.
    //
    // Not awaited: the modal should close as soon as the account exists. The
    // refetch repaints the table underneath it.
    void queryClient.invalidateQueries({ queryKey: ["users"] });
    onCreated();
  };

  return (
    <form
      // noValidate hands validation to Zod, so the messages match the ones the
      // rest of the app renders instead of the browser's own bubbles.
      noValidate
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
      className="space-y-4"
    >
      <UserFormField
        label="Name"
        // The admin is filling in somebody else's details, so the browser
        // offering their own saved name, address or password is always wrong.
        autoComplete="off"
        error={errors.name}
        registration={register("name")}
      />

      <UserFormField
        label="Email"
        type="email"
        autoComplete="off"
        error={errors.email}
        registration={register("email")}
      />

      <UserFormField
        label="Password"
        type="password"
        autoComplete="new-password"
        error={errors.password}
        registration={register("password")}
      />

      {errors.root && (
        <Alert variant="destructive">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <DialogClose
          render={
            <Button type="button" variant="outline" disabled={isSubmitting}>
              Cancel
            </Button>
          }
        />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create user"}
        </Button>
      </DialogFooter>
    </form>
  );
}
