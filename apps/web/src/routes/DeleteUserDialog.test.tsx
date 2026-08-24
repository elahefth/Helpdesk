import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserSummary } from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { DeleteUserDialog } from "./DeleteUserDialog.tsx";

/**
 * Stubs `fetch`, not `lib/api.ts`, so the response still goes through
 * `deleteUserResponseSchema` — a contract drift fails here the way it fails in
 * the browser.
 *
 * The recorded method matters more than usual: a confirmation dialog that sends
 * its request before the admin confirms is the exact failure this screen must
 * not have, so several tests assert on `calls` being empty.
 */
interface RecordedCall {
  url: string;
  method: string | undefined;
}

type Responder = () => Promise<Response>;

const calls: RecordedCall[] = [];
let responders: Responder[] = [];

function jsonResponse(body: unknown, status = 200): Responder {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

/** A response the test releases by hand, so the in-flight state is assertable. */
function gatedResponse(body: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responder: Responder = async () => {
    await gate;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { responder, release };
}

beforeEach(() => {
  calls.length = 0;
  responders = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      const next = responders.shift();
      return next
        ? next()
        : Promise.reject(new Error(`unstubbed request: ${String(input)}`));
    }),
  );
});

afterEach(cleanup);

const BEN: UserSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "ben@helpdesk.test",
  name: "Ben Agent",
  role: "agent",
  createdAt: "2026-02-11T09:00:00.000Z",
};

const DELETED = {
  id: BEN.id,
  deletedAt: "2026-08-24T09:00:00.000Z",
};

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  renderWithQuery(<DeleteUserDialog user={BEN} />);
  await user.click(screen.getByRole("button", { name: "Delete Ben Agent" }));
  return screen.findByRole("alertdialog");
}

const confirm = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Delete user" }));

describe("DeleteUserDialog", () => {
  it("asks before it deletes anything", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DeleteUserDialog user={BEN} />);

    expect(screen.queryByRole("alertdialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete Ben Agent" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete Ben Agent?")).toBeDefined();
    // Opening the confirmation must not itself be the destructive act.
    expect(calls).toHaveLength(0);
  });

  // role=alertdialog, not role=dialog: assistive technology announces it more
  // insistently, and Base UI will not let it close on Escape or a backdrop
  // click. A confirmation a stray click can dismiss is fine; one a stray click
  // can accept is not.
  it("is an alert dialog, not an ordinary one", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  it("names the account it is about to remove", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    // Both the name and the address, because two staff can share a first name
    // and the row underneath is hidden by the backdrop.
    expect(within(dialog).getByText("Delete Ben Agent?")).toBeDefined();
    expect(within(dialog).getByText(/ben@helpdesk\.test/)).toBeDefined();
  });

  it("sends a DELETE for the row's id once confirmed, and closes", async () => {
    responders.push(jsonResponse(DELETED));

    const user = userEvent.setup();
    await openDialog(user);
    await confirm(user);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe(`/api/users/${BEN.id}`);
    expect(calls[0]?.method).toBe("DELETE");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("sends nothing when the admin cancels", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls).toHaveLength(0);
  });

  // The server-side rule, seen from the client: the button is not rendered for
  // an admin row, but if the request is made anyway the refusal is shown rather
  // than swallowed.
  it("surfaces the API's refusal to delete an admin", async () => {
    responders.push(
      jsonResponse(
        {
          error: {
            code: "forbidden",
            message: "Admin accounts cannot be deleted.",
          },
        },
        403,
      ),
    );

    const user = userEvent.setup();
    await openDialog(user);
    await confirm(user);

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("Admin accounts cannot be deleted."),
    ).toBeDefined();
    // Still open: the admin has to acknowledge that nothing happened.
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  it("keeps the dialog open and reports any other failure", async () => {
    responders.push(
      jsonResponse(
        { error: { code: "not_found", message: "User not found" } },
        404,
      ),
    );

    const user = userEvent.setup();
    await openDialog(user);
    await confirm(user);

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  it("does not greet the next open with the last attempt's error", async () => {
    responders.push(
      jsonResponse(
        { error: { code: "not_found", message: "User not found" } },
        404,
      ),
      jsonResponse(DELETED),
    );

    const user = userEvent.setup();
    await openDialog(user);
    await confirm(user);
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Delete Ben Agent" }));
    await screen.findByRole("alertdialog");

    // This dialog stays mounted across opens, so the message is cleared by
    // hand — nothing unmounts it for us the way the edit form's popup does.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables both buttons while the request is in flight", async () => {
    const { responder, release } = gatedResponse(DELETED);
    responders.push(responder);

    const user = userEvent.setup();
    await openDialog(user);
    await confirm(user);

    const button = await screen.findByRole("button", { name: "Deleting…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);

    release();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // A second confirm would be a second DELETE; the guard is the disabled
    // button, not de-duplication downstream.
    expect(calls).toHaveLength(1);
  });
});
