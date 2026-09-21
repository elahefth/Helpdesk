import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TICKET_REPLY_MAX_LENGTH,
  type ListTicketRepliesResponse,
  type TicketReply,
} from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { TicketThread } from "./TicketThread.tsx";

const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const REPLIES_PATH = `/api/tickets/${TICKET_ID}/replies`;
const POLISH_PATH = `${REPLIES_PATH}/polish`;

/**
 * `useSession` is mocked rather than driven through a stubbed fetch, for the
 * reason the other page tests give: Better Auth's client resolves a session
 * through its own nanostore, and satisfying that machinery would be a test of
 * Better Auth. The form only reads the name, to say whose reply this will be.
 */
const session = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../lib/auth-client.ts", () => ({
  useSession: () => ({ data: session.current }),
}));

/**
 * Stubs `fetch`, not `lib/api.ts`, like every other page test here: the
 * responses then still go through `listTicketRepliesResponseSchema`, so a field
 * the API stops sending fails this file the way it fails the browser.
 *
 * Dispatch is by `METHOD /path`, so the GET and the POST on the same URL are
 * separate handlers.
 */
type Responder = () => Promise<Response>;

const requests: string[] = [];
const posted: unknown[] = [];
let handlers: Record<string, Responder> = {};

function jsonResponse(body: unknown, status = 200): Responder {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

function errorResponse(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

/** A response the test releases by hand, so a pending state is assertable. */
function gatedResponse(body: unknown, status = 200) {
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
  requests.length = 0;
  posted.length = 0;
  handlers = {};
  session.current = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input), "http://localhost").pathname;
      const key = `${method} ${path}`;
      requests.push(key);
      if (method === "POST") posted.push(JSON.parse(String(init?.body)));
      const handler = handlers[key];
      return handler
        ? handler()
        : Promise.reject(new Error(`unstubbed request: ${key}`));
    }),
  );
});

afterEach(cleanup);

const CASS = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Cass Agent",
  email: "cass@helpdesk.test",
  role: "agent",
} as const;

const DANA = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "Dana Admin",
  email: "dana@helpdesk.test",
  role: "admin",
} as const;

function reply(overrides: Partial<TicketReply> = {}): TicketReply {
  return {
    id: "77777777-7777-4777-8777-777777777771",
    ticketId: TICKET_ID,
    body: "Have you tried a password reset?",
    author: CASS,
    createdAt: "2026-08-21T11:00:00.000Z",
    ...overrides,
  };
}

/** The thread as the API would answer it: oldest first. */
function serve(...replies: TicketReply[]) {
  const payload: ListTicketRepliesResponse = { data: replies };
  handlers[`GET ${REPLIES_PATH}`] = jsonResponse(payload);
}

const render = () => renderWithQuery(<TicketThread ticketId={TICKET_ID} />);

const box = () => screen.getByRole("textbox", { name: /your reply/i });
const send = () => screen.getByRole("button", { name: /send reply/i });
const polish = () => screen.getByRole("button", { name: /polish/i });

describe("TicketThread", () => {
  it("lists the ticket's replies with who wrote each one and when", async () => {
    serve(
      reply(),
      reply({
        id: "77777777-7777-4777-8777-777777777772",
        body: "Reset link sent.",
        author: DANA,
        createdAt: "2026-08-21T12:30:00.000Z",
      }),
    );

    render();

    expect(
      await screen.findByText("Have you tried a password reset?"),
    ).toBeDefined();
    expect(screen.getByText("Reset link sent.")).toBeDefined();
    // The byline is the author's name, resolved by the API — the row holds an
    // id, and a thread that showed one would be unreadable.
    expect(screen.getByText("Cass Agent")).toBeDefined();
    expect(screen.getByText("Dana Admin")).toBeDefined();

    // The id in the prop is the id in the request.
    expect(requests).toContain(`GET ${REPLIES_PATH}`);
  });

  /**
   * A thread is read top to bottom, so the order it arrives in is the order it
   * renders in. The API sorts; this asserts the component does not re-sort.
   */
  it("keeps the server's oldest-first order", async () => {
    serve(
      reply({ body: "First" }),
      reply({ id: "77777777-7777-4777-8777-777777777772", body: "Second" }),
    );

    render();
    await screen.findByText("First");

    const shown = screen
      .getAllByText(/^First$|^Second$/)
      .map((node) => node.textContent);
    expect(shown).toEqual(["First", "Second"]);
  });

  it("says so when nothing has been said yet", async () => {
    serve();

    render();

    expect(await screen.findByText(/No replies yet/)).toBeDefined();
  });

  /** The plain-text reply's newlines are the only structure it has. */
  it("renders a reply with its line breaks intact", async () => {
    serve(reply({ body: "Hi Ada,\n\nTry a reset.\n\nCass" }));

    render();

    const rendered = await screen.findByText(/Try a reset/);
    expect(rendered.className).toContain("whitespace-pre-wrap");
    expect(rendered.textContent).toContain("Hi Ada,\n\nTry a reset.");
  });

  it("shows a placeholder while the thread loads", async () => {
    const { responder, release } = gatedResponse({ data: [] });
    handlers[`GET ${REPLIES_PATH}`] = responder;

    render();

    expect(screen.getByText("Loading replies…")).toBeDefined();

    release();
    await screen.findByText(/No replies yet/);
    expect(screen.queryByText("Loading replies…")).toBeNull();
  });

  /**
   * The thread failing is not the ticket failing — the email above it is on
   * screen and still readable — so the form stays usable. An agent who can read
   * the question can answer it, whether or not the history listed.
   */
  it("reports a failed load without taking the form with it", async () => {
    handlers[`GET ${REPLIES_PATH}`] = errorResponse(
      500,
      "internal_error",
      "Something went wrong",
    );

    render();

    expect(await screen.findByText("Could not load the replies")).toBeDefined();
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(box()).toBeDefined();
  });

  describe("the form", () => {
    it("posts what was typed and shows it in the thread", async () => {
      serve();
      handlers[`POST ${REPLIES_PATH}`] = jsonResponse(
        reply({ body: "Try a password reset." }),
        201,
      );

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "Try a password reset.");
      await userEvent.click(send());

      // The body is the only field: the author comes from the session, and a
      // payload that named one would be refused by the API's strict schema.
      await waitFor(() =>
        expect(posted).toEqual([{ body: "Try a password reset." }]),
      );

      expect(await screen.findByText("Try a password reset.")).toBeDefined();

      // Appended from the response rather than refetched: the POST answered
      // with the row, so a second GET would re-ask for something already in
      // hand and blank the conversation while it did.
      expect(requests.filter((r) => r === `GET ${REPLIES_PATH}`)).toHaveLength(
        1,
      );
    });

    it("clears the box once the reply has landed", async () => {
      serve();
      handlers[`POST ${REPLIES_PATH}`] = jsonResponse(reply(), 201);

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "Have you tried a password reset?");
      await userEvent.click(send());

      await waitFor(() => expect(box()).toHaveProperty("value", ""));
    });

    /**
     * The same rule the API enforces, so the two cannot disagree about what an
     * empty reply is — expressed as a disabled button rather than a message
     * after the click, because "write something first" was never news to
     * someone looking at the empty box it is written under.
     *
     * Whitespace counts as empty here because the schema trims: a Send offered
     * on two spaces is one the resolver refuses a moment later.
     */
    it.each([
      ["an empty box", ""],
      ["only whitespace", "   "],
    ])("cannot be sent with %s", async (_label, typed) => {
      serve();

      render();
      await screen.findByText(/No replies yet/);

      if (typed) await userEvent.type(box(), typed);

      expect((send() as HTMLButtonElement).disabled).toBe(true);

      // Belt and braces: a click on a disabled button is inert in a browser,
      // and asserting it here is what would catch the button being re-enabled
      // by some later change without anyone noticing what it guarded.
      await userEvent.click(send());
      expect(requests).not.toContain(`POST ${REPLIES_PATH}`);
    });

    /** The other direction: it comes back the moment there is something to send. */
    it("enables the send once something is typed", async () => {
      serve();

      render();
      await screen.findByText(/No replies yet/);
      expect((send() as HTMLButtonElement).disabled).toBe(true);

      await userEvent.type(box(), "H");
      await waitFor(() =>
        expect((send() as HTMLButtonElement).disabled).toBe(false),
      );
    });

    /**
     * `reset()` empties the box on a successful send, so the button has to go
     * back with it — a live Send over an empty box is how the same reply gets
     * posted twice.
     */
    it("disables the send again once the reply has landed", async () => {
      serve();
      handlers[`POST ${REPLIES_PATH}`] = jsonResponse(reply(), 201);

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "Have you tried a password reset?");
      await userEvent.click(send());

      await waitFor(() =>
        expect((send() as HTMLButtonElement).disabled).toBe(true),
      );
    });

    /**
     * A polished draft is text in the box like any other, so the Send it was
     * disabled for comes back on — the one path to this state that does not go
     * through a keystroke.
     */
    it("enables the send after a polish fills the box", async () => {
      serve();
      handlers[`POST ${POLISH_PATH}`] = jsonResponse({ body: "Polished." });

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "rough");
      await userEvent.click(polish());

      await waitFor(() =>
        expect((box() as HTMLTextAreaElement).value).toBe("Polished."),
      );
      expect((send() as HTMLButtonElement).disabled).toBe(false);
    });

    /**
     * The ceiling is the shared schema's, so the control and the API agree on
     * it. `maxLength` is the half that acts first — a paste is truncated at the
     * cap rather than typed out and then rejected — and the schema behind it is
     * what a caller bypassing this form still meets.
     */
    it("caps a reply at the length the API accepts", async () => {
      serve();

      render();
      await screen.findByText(/No replies yet/);

      // Pasted rather than typed: `userEvent.type` over ten thousand characters
      // one at a time is a test that times out.
      await userEvent.click(box());
      await userEvent.paste("x".repeat(TICKET_REPLY_MAX_LENGTH + 100));

      expect((box() as HTMLTextAreaElement).value).toHaveLength(
        TICKET_REPLY_MAX_LENGTH,
      );
    });

    /**
     * A failed send must not eat what was written. Retyping a paragraph because
     * the network blinked is the worst version of this feature.
     */
    it("keeps the text in the box when the send fails", async () => {
      serve();
      handlers[`POST ${REPLIES_PATH}`] = errorResponse(
        503,
        "service_unavailable",
        "Database unavailable",
      );

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "Have you tried a password reset?");
      await userEvent.click(send());

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Database unavailable");
      expect(box()).toHaveProperty("value", "Have you tried a password reset?");
    });

    it("disables the button while the reply is in flight", async () => {
      serve();
      const { responder, release } = gatedResponse(reply(), 201);
      handlers[`POST ${REPLIES_PATH}`] = responder;

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "Have you tried a password reset?");
      await userEvent.click(send());

      // Two clicks on a slow network is the ordinary way a thread gets the same
      // reply twice, and nothing downstream deduplicates one.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /sending/i })).toHaveProperty(
          "disabled",
          true,
        ),
      );

      release();
      // The in-flight lock lifting is read off the label rather than off
      // `disabled`, which stays true: a successful send empties the box, and an
      // empty box disables the Send on its own. Two different reasons for the
      // same attribute, and only one of them is what this test is about.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /sending/i })).toBeNull(),
      );
      expect(posted).toHaveLength(1);
    });

    /**
     * Whose reply this will be, from the session rather than a picker: the API
     * signs it with the account that is signed in, so offering a choice would be
     * offering one the server ignores.
     */
    it("names the signed-in agent on the form", async () => {
      session.current = { user: CASS };
      serve();

      render();
      await screen.findByText(/No replies yet/);

      expect(
        within(send().closest("form") as HTMLElement).queryByRole("combobox"),
      ).toBeNull();
      expect(screen.getByText("Reply as Cass Agent")).toBeDefined();
    });

    /** No session resolved yet is a heading, not a gap where a name should be. */
    it("still labels the form before the session resolves", async () => {
      serve();

      render();
      await screen.findByText(/No replies yet/);

      expect(screen.getByText("Reply")).toBeDefined();
    });

    /**
     * The list request failing does not make the reply that was just written
     * disappear: there is no cached thread to append to, so the entry is seeded
     * with it rather than the row being dropped on the floor.
     */
    it("shows a reply written while the thread could not be listed", async () => {
      handlers[`GET ${REPLIES_PATH}`] = errorResponse(
        500,
        "internal_error",
        "Something went wrong",
      );
      handlers[`POST ${REPLIES_PATH}`] = jsonResponse(
        reply({ body: "Sent anyway." }),
        201,
      );

      render();
      await screen.findByText("Could not load the replies");

      await userEvent.type(box(), "Sent anyway.");
      await userEvent.click(send());

      expect(await screen.findByText("Sent anyway.")).toBeDefined();
    });
  });

  /**
   * The polisher. It rewrites the box and writes nothing to the thread, so
   * every assertion here is about the textarea and about what did *not* get
   * posted — a polish that reached `POST …/replies` would publish a draft.
   */
  describe("the polish button", () => {
    it("replaces the draft with what the model sent back", async () => {
      serve();
      handlers[`POST ${POLISH_PATH}`] = jsonResponse({
        body: "Hi Ada,\n\nWe cannot issue a refund after 14 days. Sorry.",
      });

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "we cant refund after 14 day sorry");
      await userEvent.click(polish());

      await waitFor(() =>
        expect((box() as HTMLTextAreaElement).value).toBe(
          "Hi Ada,\n\nWe cannot issue a refund after 14 days. Sorry.",
        ),
      );
      expect(posted[0]).toEqual({ body: "we cant refund after 14 day sorry" });
    });

    /**
     * The whole point of the separation: polishing produces text for a box the
     * agent is still typing in. A request to the reply route here would mean a
     * rewrite had been published without anyone pressing Send.
     */
    it("does not send anything", async () => {
      serve();
      handlers[`POST ${POLISH_PATH}`] = jsonResponse({ body: "Polished." });

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "rough draft");
      await userEvent.click(polish());

      await waitFor(() =>
        expect((box() as HTMLTextAreaElement).value).toBe("Polished."),
      );
      expect(requests).not.toContain(`POST ${REPLIES_PATH}`);
      expect(screen.queryByText("Polished.", { selector: "div" })).toBeNull();
    });

    /**
     * `type="button"`. The default inside a form is submit, which would send
     * the unpolished draft with a click on the button meant to improve it.
     */
    it("is not a submit button", () => {
      serve();
      render();
      expect((polish() as HTMLButtonElement).type).toBe("button");
    });

    /**
     * Answered in the box rather than by a round trip: the API would say the
     * same thing, and the agent can be told immediately.
     */
    it("asks for a draft before calling the model", async () => {
      serve();
      render();
      await screen.findByText(/No replies yet/);

      await userEvent.click(polish());

      expect(
        await screen.findByText("Write a draft before polishing it."),
      ).toBeDefined();
      expect(requests).not.toContain(`POST ${POLISH_PATH}`);
    });

    it("locks both buttons while the rewrite is in flight", async () => {
      serve();
      const { responder, release } = gatedResponse({ body: "Polished." });
      handlers[`POST ${POLISH_PATH}`] = responder;

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "rough draft");
      await userEvent.click(polish());

      // A send while the rewrite is in flight would race the response and
      // could publish the very draft the agent asked to have replaced.
      await waitFor(() =>
        expect((send() as HTMLButtonElement).disabled).toBe(true),
      );
      expect(screen.getByRole("button", { name: /polishing/i })).toBeDefined();

      release();
      await waitFor(() =>
        expect((box() as HTMLTextAreaElement).value).toBe("Polished."),
      );
      expect((send() as HTMLButtonElement).disabled).toBe(false);
    });

    /**
     * A server with no model configured answers 503 with a message written to
     * be read. The draft is the agent's own work and must survive it.
     */
    it("keeps the draft when the polisher is unavailable", async () => {
      serve();
      handlers[`POST ${POLISH_PATH}`] = errorResponse(
        503,
        "service_unavailable",
        "Reply polishing is not configured on this server.",
      );

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "rough draft");
      await userEvent.click(polish());

      expect(
        await screen.findByText(
          "Reply polishing is not configured on this server.",
        ),
      ).toBeDefined();
      expect((box() as HTMLTextAreaElement).value).toBe("rough draft");
    });

    it("keeps the draft when the model itself fails", async () => {
      serve();
      handlers[`POST ${POLISH_PATH}`] = errorResponse(
        502,
        "bad_gateway",
        "The model could not be reached. Please try again.",
      );

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "rough draft");
      await userEvent.click(polish());

      expect(
        await screen.findByText(
          "The model could not be reached. Please try again.",
        ),
      ).toBeDefined();
      expect((box() as HTMLTextAreaElement).value).toBe("rough draft");
      expect((send() as HTMLButtonElement).disabled).toBe(false);
    });

    /** A polished draft is still a draft: the send afterwards posts the rewrite. */
    it("sends the rewrite once the agent presses send", async () => {
      serve();
      handlers[`POST ${POLISH_PATH}`] = jsonResponse({ body: "Polished." });
      handlers[`POST ${REPLIES_PATH}`] = jsonResponse(
        reply({ body: "Polished." }),
        201,
      );

      render();
      await screen.findByText(/No replies yet/);

      await userEvent.type(box(), "rough draft");
      await userEvent.click(polish());
      await waitFor(() =>
        expect((box() as HTMLTextAreaElement).value).toBe("Polished."),
      );

      await userEvent.click(send());

      await waitFor(() => expect(posted[1]).toEqual({ body: "Polished." }));
    });
  });
});
