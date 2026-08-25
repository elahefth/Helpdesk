/**
 * Delivers one email to the running API, standing in for the mail provider
 * this project does not have yet.
 *
 * There is no `EmailSource` interface behind it on purpose. The interface would
 * describe a provider integration nobody has written, and this script is the
 * only source there is — it posts the same normalised payload a Mailgun adapter
 * would, to the same endpoint, so what it exercises is the real ingestion path
 * and not a test double.
 *
 *   bun run email:send -- --from=ada@example.com --from-name="Ada Student" \
 *     --subject="Refund please" \
 *     --text="I dropped the course last week." --category=refund_request
 *
 * Every flag is optional; the defaults produce a plausible ticket. Reads
 * ../../.env for SUPPORT_EMAIL, INBOUND_EMAIL_SECRET and PORT, so it targets
 * the same mailbox the API is enforcing.
 */
import { randomUUID } from "node:crypto";
import {
  inboundEmailBodySchema,
  ticketDetailSchema,
  TICKET_CATEGORIES,
} from "@helpdesk/shared";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

const apiUrl = flag("api") ?? `http://localhost:${process.env.PORT ?? 3000}`;
const supportEmail = process.env.SUPPORT_EMAIL ?? "support@helpdesk.test";

// Parsed here rather than posted raw, so a typo in a flag is a message on this
// terminal instead of a 400 to read out of a log. It is the same schema the
// route parses with, which is the point of keeping it in packages/shared.
const parsed = inboundEmailBodySchema.safeParse({
  from: flag("from") ?? "ada.student@example.com",
  fromName: flag("from-name") ?? "Ada Student",
  to: flag("to") ?? supportEmail,
  subject: flag("subject") ?? "Cannot log in to the course portal",
  text:
    flag("text") ??
    "Hi,\n\nI have been trying to sign in since yesterday and it keeps telling me my password is wrong. I have reset it twice.\n\nThanks,\nAda",
  // A fresh one per send, so repeated runs create distinct tickets. Pass
  // --message-id=<same> twice to watch the idempotency path answer 200.
  messageId: flag("message-id") ?? `<${randomUUID()}@fixture.local>`,
  ...(flag("category") ? { category: flag("category") } : {}),
});

if (!parsed.success) {
  console.error("Invalid email:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(body)"}: ${issue.message}`);
  }
  console.error(`\n--category must be one of: ${TICKET_CATEGORIES.join(", ")}`);
  process.exit(1);
}

const secret = process.env.INBOUND_EMAIL_SECRET;
const response = await fetch(`${apiUrl}/api/inbound-email`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { "x-inbound-secret": secret } : {}),
  },
  body: JSON.stringify(parsed.data),
});

const payload: unknown = await response.json().catch(() => null);

if (!response.ok) {
  console.error(`${response.status} ${response.statusText}`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

// Parsed with the response schema for the same reason the SPA does it: a
// contract drift should be loud here rather than print a plausible-looking
// object that no longer matches what the browser will accept.
const ticket = ticketDetailSchema.parse(payload);

console.log(
  response.status === 201
    ? `Created ticket ${ticket.id}`
    : `Already delivered — existing ticket ${ticket.id}`,
);
console.log(`  ${ticket.subject}`);
console.log(
  `  from ${ticket.studentName ?? "(no name)"} <${ticket.studentEmail}> · ${ticket.status}`,
);
