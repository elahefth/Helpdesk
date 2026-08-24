import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserSummary } from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { CreateUserDialog } from "./CreateUserDialog.tsx";

/**
 * Stubs `fetch` rather than `lib/api.ts`, for the reason spelled out in
 * UsersPage.test.tsx: the response still goes through `createUserResponseSchema`,
 * so a contract drift fails here the way it fails in the browser.
 *
 * The recorded calls carry the parsed body as well as the URL, because what this
 * form must get right is *what it sends* — the API cannot be trusted to catch a
 * field the form never included.
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
function gatedResponse(body: unknown, status = 201) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responder: Responder = async () => {
    await gate;
    return new Response(JSON.stringify(body), {
      status,
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

const CREATED: UserSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Cass Agent",
  email: "cass@helpdesk.test",
  role: "agent",
  createdAt: "2026-08-17T09:00:00.000Z",
};

/** Clicks "New user" and returns the open dialog. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  renderWithQuery(<CreateUserDialog />);
  await user.click(screen.getByRole("button", { name: /New user/ }));
  return screen.findByRole("dialog");
}

/** Fills all three fields, overriding any of them. */
async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  overrides: Partial<{ name: string; email: string; password: string }> = {},
) {
  const values = {
    name: "Cass Agent",
    email: "cass@helpdesk.test",
    password: "correct-horse",
    ...overrides,
  };
  if (values.name) await user.type(screen.getByLabelText("Name"), values.name);
  if (values.email)
    await user.type(screen.getByLabelText("Email"), values.email);
  if (values.password)
    await user.type(screen.getByLabelText("Password"), values.password);
  return values;
}

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Create user" }));

describe("CreateUserDialog", () => {
  it("keeps the modal closed until the button is clicked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CreateUserDialog />);

    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: /New user/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toBeDefined();
    expect(within(dialog).getByLabelText("Email")).toBeDefined();
    expect(within(dialog).getByLabelText("Password")).toBeDefined();
  });

  it("posts the form and closes on success", async () => {
    responders.push(jsonResponse(CREATED, 201));

    const user = userEvent.setup();
    await openDialog(user);
    const values = await fillForm(user);
    await submit(user);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe("/api/users");
    expect(calls[0]?.method).toBe("POST");
    // Exact equality, not a subset match: `role` must not be in the body. The
    // API rejects unknown keys, so a form that grew one would 400 in production.
    expect(calls[0]?.body).toEqual(values);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("rejects a name shorter than three characters without a request", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user, { name: "Al" });
    await submit(user);

    expect(
      await screen.findByText("Name must be at least 3 characters."),
    ).toBeDefined();
    // The point of validating client-side: nothing was sent.
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  // The schema trims before measuring, so padding cannot buy the third
  // character. Same assertion as the API's, on the same schema.
  it("does not count padding towards the name minimum", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user, { name: " Al " });
    await submit(user);

    expect(
      await screen.findByText("Name must be at least 3 characters."),
    ).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects a password shorter than eight characters without a request", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user, { password: "1234567" });
    await submit(user);

    expect(
      await screen.findByText("Password must be at least 8 characters."),
    ).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed email without a request", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user, { email: "not-an-email" });
    await submit(user);

    expect(
      await screen.findByText("Enter a valid email address."),
    ).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("reports every empty field at once", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await submit(user);

    expect(
      await screen.findByText("Name must be at least 3 characters."),
    ).toBeDefined();
    expect(screen.getByText("Enter a valid email address.")).toBeDefined();
    expect(
      screen.getByText("Password must be at least 8 characters."),
    ).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("marks the offending field invalid so it is styled and announced", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user, { password: "short" });
    await submit(user);

    const password = screen.getByLabelText("Password");
    await waitFor(() =>
      expect(password.getAttribute("aria-invalid")).toBe("true"),
    );
    // The message is wired to the input, not merely nearby.
    const describedBy = password.getAttribute("aria-describedby");
    expect(describedBy).toBe("create-user-password-error");
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "Password must be at least 8 characters.",
    );
    expect(
      screen.getByLabelText("Email").getAttribute("aria-invalid"),
    ).toBeNull();
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
    await fillForm(user);
    await submit(user);

    expect(
      await screen.findByText("A user with that email already exists."),
    ).toBeDefined();
    expect(
      screen.getByLabelText("Email").getAttribute("aria-describedby"),
    ).toBe("create-user-email-error");
    // Still open, with the values intact, so the admin can fix the one field.
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Cass Agent",
    );
  });

  it("surfaces a non-conflict failure as a form-level alert", async () => {
    responders.push(
      jsonResponse(
        { error: { code: "forbidden", message: "Admin role required" } },
        403,
      ),
    );

    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user);
    await submit(user);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Admin role required")).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("disables both buttons while the request is in flight", async () => {
    const { responder, release } = gatedResponse(CREATED);
    responders.push(responder);

    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user);
    await submit(user);

    // A second submit would create a second account, so the guard is the button
    // going disabled rather than any de-duplication downstream.
    const submitButton = await screen.findByRole("button", {
      name: "Creating…",
    });
    expect(submitButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);

    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toHaveLength(1);
  });

  it("starts from a clean form after a cancelled attempt", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillForm(user, { name: "Al" });
    await submit(user);
    await screen.findByText("Name must be at least 3 characters.");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: /New user/ }));
    await screen.findByRole("dialog");

    // Neither the value nor the error it produced survived the close — the form
    // unmounts with the popup, which is what makes a reset() call unnecessary.
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("");
    expect(
      screen.queryByText("Name must be at least 3 characters."),
    ).toBeNull();
  });
});
