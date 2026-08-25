import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { USER_ROLES, type UserRole } from "@helpdesk/shared";
import { listUsers } from "../lib/api.ts";
import { CreateUserDialog } from "./CreateUserDialog.tsx";
import { DeleteUserDialog } from "./DeleteUserDialog.tsx";
import { EditUserDialog } from "./EditUserDialog.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

/** Base UI's Select renders labels from `items` rather than the raw value. */
const ROLE_ITEMS = [
  { label: "All", value: "all" },
  ...USER_ROLES.map((value) => ({ label: value, value })),
];

/**
 * Admin-only staff list. `RequireAdmin` keeps a non-admin from rendering this,
 * but the real boundary is GET /api/users, which answers 403 on its own.
 *
 * The table is hand-rolled rather than a `components/ui/table` primitive: four
 * columns of static markup do not need eight wrapper components. `TicketListPage`
 * is deliberately the same shape — when a screen finally needs sorting or column
 * control, that is the one that picks the table layer, and both move together.
 */
export function UsersPage() {
  const [role, setRole] = useState<UserRole | "all">("all");

  const {
    data,
    isPending,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["users", { role }],
    queryFn: ({ pageParam }) =>
      listUsers({
        ...(role === "all" ? {} : { role }),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    // `nextCursor` is null on the last page; undefined is what switches
    // hasNextPage off.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const users = data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">Users</h2>
        <CreateUserDialog />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="role" className="text-muted-foreground">
          Role
        </Label>
        <Select
          items={ROLE_ITEMS}
          value={role}
          onValueChange={(value) => setRole(value as UserRole | "all")}
        >
          <SelectTrigger id="role" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {ROLE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {isPending && <UsersTableSkeleton />}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load users</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {data && users.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <p className="font-medium">No users match that filter</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Staff accounts are created here or by the seed script; there is no
              sign-up.
            </p>
          </CardContent>
        </Card>
      )}

      {data && users.length > 0 && (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <UsersTableHead />
              <tbody className="divide-y">
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="py-3 pr-4 font-medium">{user.name}</td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {user.email}
                    </td>
                    <td className="py-3 pr-4">
                      <Badge
                        variant={
                          user.role === "admin" ? "default" : "secondary"
                        }
                      >
                        {user.role}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <EditUserDialog user={user} />
                        {/*
                         * Admins have no delete button rather than a disabled
                         * one: a control that can never become enabled is
                         * noise, and the API refuses an admin regardless — the
                         * button's absence is a hint, not the rule.
                         */}
                        {user.role !== "admin" && (
                          <DeleteUserDialog user={user} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function UsersTableHead() {
  return (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th scope="col" className="py-2 pr-4 font-medium">
          Name
        </th>
        <th scope="col" className="py-2 pr-4 font-medium">
          Email
        </th>
        <th scope="col" className="py-2 pr-4 font-medium">
          Role
        </th>
        <th scope="col" className="py-2 pr-4 font-medium">
          Added
        </th>
        {/*
         * A column of icon buttons has no useful heading, but an empty <th>
         * leaves the row-header count out of step with the cells for a screen
         * reader walking the table. The label is there and hidden.
         */}
        <th scope="col" className="py-2 font-medium">
          <span className="sr-only">Actions</span>
        </th>
      </tr>
    </thead>
  );
}

/**
 * Placeholder rows shaped like the real table so the header and column widths
 * do not shift when the first page arrives. The row count is arbitrary — the
 * API page size is 20, but five rows is enough to read as "a list is coming"
 * without a screenful of grey bars.
 */
function UsersTableSkeleton() {
  return (
    <div className="overflow-x-auto" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading users…</span>
      <table className="w-full text-sm">
        <UsersTableHead />
        <tbody className="divide-y">
          {Array.from({ length: 5 }, (_, i) => (
            <tr key={i}>
              <td className="py-3 pr-4">
                <Skeleton className="h-4 w-32" />
              </td>
              <td className="py-3 pr-4">
                <Skeleton className="h-4 w-48" />
              </td>
              <td className="py-3 pr-4">
                <Skeleton className="h-5 w-16 rounded-full" />
              </td>
              <td className="py-3 pr-4">
                <Skeleton className="h-4 w-20" />
              </td>
              <td className="py-3">
                <div className="flex justify-end gap-1">
                  <Skeleton className="size-8 rounded-md" />
                  <Skeleton className="size-8 rounded-md" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
