import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PencilIcon } from "lucide-react";
import {
  updateUserBodySchema,
  type UpdateUserBody,
  type UpdateUserFormValues,
  type UserSummary,
} from "@helpdesk/shared";
import { ApiRequestError, updateUser } from "../lib/api.ts";
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
 * The per-row edit button and the modal behind it, shaped like
 * `CreateUserDialog` and sharing its fields through `UserFormField`.
 *
 * One of these is rendered per table row rather than one per page driven by a
 * "which user is being edited" state: a `DialogTrigger` is what gives Base UI
 * the element to return focus to when the modal closes, so keyboard focus lands
 * back on the row the admin came from instead of the top of the document.
 * Closed dialogs render only the button — the popup is not mounted.
 */
export function EditUserDialog({ user }: { user: UserSummary }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            // The button's only content is an icon, so without this it is
            // announced as "button" — and there is one per row.
            aria-label={`Edit ${user.name}`}
          >
            <PencilIcon />
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>
            Changes apply to {user.email}. A role cannot be changed here — the
            API refuses one from this form, so promoting someone stays a
            separate, deliberate act.
          </DialogDescription>
        </DialogHeader>

        {/*
         * Mounted only while the dialog is open, as in CreateUserDialog, so
         * `useForm` re-reads `user` on every open. That is what keeps the
         * fields showing the current row after a previous edit rather than the
         * values this component first mounted with, and why nothing here calls
         * reset().
         */}
        <EditUserForm user={user} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function EditUserForm({
  user,
  onSaved,
}: {
  user: UserSummary;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UpdateUserFormValues, unknown, UpdateUserBody>({
    // The same schema the API parses the body with, so the form cannot disagree
    // with the server about what "valid" means — including the rule that a
    // blank password means "unchanged".
    resolver: zodResolver(updateUserBodySchema),
    // Populated from the row, which is what makes this an edit rather than a
    // second create. The password starts blank *and means blank*: the current
    // one is a hash the API will not return, so there is nothing to prefill.
    defaultValues: { name: user.name, email: user.email, password: "" },
  });

  const onSubmit = async (values: UpdateUserBody) => {
    try {
      // `values` is the schema's output, so a blank password is already
      // undefined here and never reaches the wire.
      await updateUser(user.id, values);
    } catch (error) {
      // A duplicate email is attached to the field that caused it, as on
      // create. The only person who can reach this endpoint can already list
      // every account, so there is no enumeration concern to weigh.
      if (error instanceof ApiRequestError && error.status === 409) {
        setError("email", { message: error.message });
        return;
      }

      setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "Could not save the changes. Please try again.",
      });
      return;
    }

    // Prefix match over ["users", { role }], so every cached filter refetches
    // rather than only the one on screen — an edit can move a row into or out
    // of a filter the admin is not currently looking at.
    //
    // Not awaited: the modal should close as soon as the write lands. The
    // refetch repaints the table underneath it.
    void queryClient.invalidateQueries({ queryKey: ["users"] });
    onSaved();
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
        // The admin is editing somebody else's details, so the browser offering
        // their own saved name or password is always wrong.
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
        hint="Leave blank to keep the current password."
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
          {isSubmitting ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
