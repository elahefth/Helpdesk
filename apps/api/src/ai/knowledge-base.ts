import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.ts";
import { logger } from "../logger.ts";

/**
 * The support knowledge base: the document the automatic resolver is allowed to
 * answer students out of, and the only source of fact it has.
 *
 * It is one file, read once, and handed to the model whole. Three things about
 * that are deliberate.
 *
 * **Whole, not retrieved.** There is no chunking, no embedding and no search
 * over it, because the document is a few thousand words — well inside any
 * model's context and cheaper to send than to index. Retrieval would also cost
 * the property that makes this safe at all: the escalation rules in section 10
 * are not *about* any particular question, so a similarity search over a
 * student's email would routinely fail to retrieve them and the assistant would
 * answer a chargeback dispute because nothing told it not to. A knowledge base
 * that outgrows the context window is the change that makes retrieval worth its
 * risks; this one has not.
 *
 * **Read once, at startup.** The file is loaded when the resolver is built and
 * held for the life of the process, so an edit takes a restart. That is the
 * honest trade for a document that is policy: re-reading per job would mean two
 * tickets ingested a second apart could be answered from two different refund
 * policies, with nothing on either ticket to say which. A restart is a
 * deployment, which is what changing policy should look like.
 *
 * **Missing means no resolver.** `undefined`, not an empty string — see
 * `createTicketAutoResolver`, which then returns `undefined` itself and leaves
 * every ticket `skipped`. A model handed an empty knowledge base and told to
 * answer from it does not decline; it answers from whatever it remembers about
 * refunds in general, in this helpdesk's voice, to a real student.
 */

/**
 * Where the file is, resolved from the API package rather than the process's
 * cwd.
 *
 * `bun run dev` starts in `apps/api`, the root scripts start in the repo root,
 * and a container starts wherever its entrypoint says — three cwds for one
 * file. Resolving from `import.meta.url` makes the committed default mean the
 * same thing in all of them. An absolute override is taken as given, which is
 * what a deployment mounting its own policy document needs.
 */
export function knowledgeBasePath(
  configured: string = env.KNOWLEDGE_BASE_PATH,
): string {
  if (isAbsolute(configured)) return configured;
  // …/apps/api/src/ai/knowledge-base.ts -> …/apps/api
  const apiRoot = fileURLToPath(new URL("../..", import.meta.url));
  return resolve(apiRoot, configured);
}

/**
 * The knowledge base, or `undefined` if there is not one to read.
 *
 * Blank counts as absent. A file that exists and says nothing is the same
 * situation as no file — nothing to answer from — and the difference between
 * the two is not one anybody downstream can act on differently.
 *
 * Synchronous on purpose: this runs once, during startup, before the port is
 * open, and an async factory here would make every caller of
 * `createTicketAutoResolver` a promise for no benefit.
 */
export function loadKnowledgeBase(
  path: string = knowledgeBasePath(),
): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!text) {
      logger.warn({ path }, "the knowledge base file is empty");
      return undefined;
    }
    logger.info(
      { path, characters: text.length },
      "loaded the support knowledge base",
    );
    return text;
  } catch (error) {
    // Logged at warn rather than thrown: an install without a knowledge base is
    // an install without automatic resolution, which is a feature being off and
    // not the API being broken — the same call `OPENROUTER_API_KEY` makes.
    logger.warn(
      { err: error, path },
      "no support knowledge base — tickets will not be auto-resolved",
    );
    return undefined;
  }
}
