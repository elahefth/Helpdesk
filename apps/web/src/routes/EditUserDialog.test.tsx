import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserSummary } from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { EditUserDialog } from "./EditUserDialog.tsx";

/**
 * Stubs `fetch` rather than `lib/api.ts`, for the reason spelled out in
 * UsersPage.test.tsx: the response still goes through `updateUserResponseSchema`.
 *
 * The recorded calls carry the parsed body, because the whole point of this
 * form is *what it sends* — specifically whether `password` is on the wire at
 * all. The API cannot catch a key the form wrongly omits or wrongly includes.
 */
interface RecordedCall {
  url: string;
  method: string | undefined;
  body: unknown;
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
      calls.push({
        url: String(input),
        method: init?.method,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : init?.body,
      });
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

const URL_FOR_BEN = `/api/users/${BEN.id}`;

/** Clicks this row's edit button and returns the open dialog. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  renderWithQuery(<EditUserDialog user={BEN} />);
  await user.click(screen.getByRole("button", { name: "Edit Ben Agent" }));
  return screen.findByRole("dialog");
}

/** Replaces a prefilled field, which needs the clear that a create form does not. */
async function retype(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
) {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  if (value) await user.type(input, value);
}

const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Save changes" }));

describe("EditUserDialog", () => {
  it("labels the row's icon button with the user it edits", async () => {
    renderWithQuery(<EditUserDialog user={BEN} />);

    // One of these renders per row, so "button" alone would be ambiguous to
    // anyone not looking at the table.
    const trigger = screen.getByRole("button", { name: "Edit Ben Agent" });
    expect(trigger).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens populated with the user's data and a blank password", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Ben Agent",
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>("Email").value).toBe(
      "ben@helpdesk.test",
    );
    // The stored password is a hash the API will not return, so there is
    // nothing to prefill and blank has to mean "unchanged".
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Password").value,
    ).toBe("");
  });

  it("tells the admin what a blank password does, in the field's own description", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    const password = screen.getByLabelText("Password");
    const describedBy = password.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "Leave blank to keep the current password.",
    );
  });

  it("PATCHes the row's id and omits the password when it is left blank", async () => {
    responders.push(jsonResponse({ ...BEN, name: "Ben Renamed" }));

    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Name", "Ben Renamed");
    await save(user);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe(URL_FOR_BEN);
    expect(calls[0]?.method).toBe("PATCH");
    // The load-bearing assertion of this whole feature: no `password` key on
    // the wire at all. Sending "" would ask the API to hash an empty string.
    expect(calls[0]?.body).not.toHaveProperty("password");
    expect(calls[0]?.body).toEqual({
      name: "Ben Renamed",
      email: "ben@helpdesk.test",
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends the password when one is typed", async () => {
    responders.push(jsonResponse(BEN));

    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await save(user);

    await waitFor(() => expect(calls).toHaveLength(1));
    // Exact equality, not a subset: `role` must not appear, or the API's strict
    // schema would 400 the whole edit.
    expect(calls[0]?.body).toEqual({
      name: "Ben Agent",
      email: "ben@helpdesk.test",
      password: "correct-horse",
    });
  });

  it("treats a whitespace-only password as leaving it unchanged", async () => {
    responders.push(jsonResponse(BEN));

    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText("Password"), "    ");
    await save(user);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).not.toHaveProperty("password");
  });

  /**
   * Regression guard. Better Auth looks a user up by the lowercased address, so
   * storing "Elmira@..." makes the account unreachable by every sign-in, and no
   * password reset recovers it — the lookup fails before a password is checked.
   * Create is normalised by Better Auth on the way past; edit writes the column
   * directly, so the form is what has to send a normalised address.
   */
  it("lowercases the email before sending it", async () => {
    responders.push(jsonResponse(BEN));

    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Email", "Elmira@Helpdesk.TEST");
    await save(user);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({
      name: "Ben Agent",
      email: "elmira@helpdesk.test",
    });
  });

  it("rejects a password shorter than eight characters without a request", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText("Password"), "1234567");
    await save(user);

    expect(
      await screen.findByText("Password must be at least 8 characters."),
    ).toBeDefined();
    // "Unchanged" is the empty string, not any short string.
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("rejects a name shorter than three characters without a request", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Name", "Al");
    await save(user);

    expect(
      await screen.findByText("Name must be at least 3 characters."),
    ).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects a cleared email without a request", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Email", "");
    await save(user);

    expect(
      await screen.findByText("Enter a valid email address."),
    ).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("attaches a duplicate email to the email field and stays open", async () => {
    responders.push(
      jsonResponse(
        {
          error: {
            code: "conflict",
            message: "A user with that email already exists.",
          },
        },
        409,
      ),
    );

    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Email", "ada@helpdesk.test");
    await save(user);

    expect(
      await screen.findByText("A user with that email already exists."),
    ).toBeDefined();
    const describedBy = screen
      .getByLabelText("Email")
      .getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "A user with that email already exists.",
    );
    // Still open, with the edits intact, so the admin can fix the one field.
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(
      "ada@helpdesk.test",
    );
  });

  it("surfaces a non-conflict failure as a form-level alert", async () => {
    responders.push(
      jsonResponse(
        { error: { code: "not_found", message: "User not found" } },
        404,
      ),
    );

    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Name", "Ben Renamed");
    await save(user);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("User not found")).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("disables both buttons while the request is in flight", async () => {
    const { responder, release } = gatedResponse(BEN);
    responders.push(responder);

    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Name", "Ben Renamed");
    await save(user);

    // A second submit would send a second write, so the guard is the button
    // going disabled rather than any de-duplication downstream.
    const saveButton = await screen.findByRole("button", { name: "Saving…" });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);

    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toHaveLength(1);
  });

  it("re-reads the row after an abandoned edit", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await retype(user, "Name", "Discarded");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Edit Ben Agent" }));
    await screen.findByRole("dialog");

    // The form unmounts with the popup and rebuilds its defaults from `user`,
    // which is what makes a reset() call unnecessary — and what stops a
    // half-typed edit from being presented as the account's current state.
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Ben Agent",
    );
    expect(calls).toHaveLength(0);
  });
});
