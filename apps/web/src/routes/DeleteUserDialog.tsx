import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2Icon } from "lucide-react";
import type { UserSummary } from "@helpdesk/shared";
import { deleteUser } from "../lib/api.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * The per-row delete button and its confirmation.
 *
 * `UsersPage` renders this only for non-admin rows, but that is presentation:
 * DELETE /api/users/:id refuses an admin on its own, and that refusal is the
 * actual rule. Anyone who reaches the endpoint another way meets the same 403.
 *
 * Built on AlertDialog rather than Dialog so the confirmation cannot be
 * dismissed by a backdrop click or Escape — see components/ui/alert-dialog.tsx.
 */
export function DeleteUserDialog({ user }: { user: UserSummary }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const onConfirm = async () => {
    setIsDeleting(true);
    try {
      await deleteUser(user.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not delete the user. Please try again.",
      );
      return;
    } finally {
      setIsDeleting(false);
    }

    // Prefix match over ["users", { role }], so every cached filter drops the
    // row rather than only the one on screen.
    void queryClient.invalidateQueries({ queryKey: ["users"] });

    // The ticket detail page's assignee picker is a different cache entry, and
    // it holds this account. `staleTime` there is five minutes — long, because
    // the staff list barely changes and every ticket opened would otherwise
    // re-fetch it — so without this an admin who deletes a colleague and then
    // opens a ticket is still offered them, for as long as it takes the entry
    // to age out. The delete is exactly the event that makes it wrong.
    void queryClient.invalidateQueries({ queryKey: ["assignees"] });

    // DELETE /api/users/:id also unassigns every ticket the account owned, so
    // any cached ticket naming them is stale, and so is the queue: the same
    // UPDATE restamps `updated_at`, which is what the default sort orders by.
    // Both are invalidated by prefix and neither is mounted right now, so they
    // are marked stale and re-fetched when the reader next lands on them.
    void queryClient.invalidateQueries({ queryKey: ["ticket"] });
    void queryClient.invalidateQueries({ queryKey: ["tickets"] });

    setOpen(false);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The dialog stays mounted across opens, unlike the edit form, because
        // it holds no field state worth rebuilding. A failed attempt's message
        // still has to be cleared by hand, or it would greet the next open.
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            // Icon-only, and one renders per row.
            aria-label={`Delete ${user.name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon />
          </Button>
        }
      />

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {user.email} will lose access immediately and any active session
            ends. Tickets assigned to them go back to the unassigned pool. The
            account is kept so past work still shows who did it, and its email
            address stays reserved.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogClose
            render={
              <Button type="button" variant="outline" disabled={isDeleting}>
                Cancel
              </Button>
            }
          />
          <Button
            type="button"
            variant="destructive"
            disabled={isDeleting}
            onClick={() => void onConfirm()}
          >
            {isDeleting ? "Deleting…" : "Delete user"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
