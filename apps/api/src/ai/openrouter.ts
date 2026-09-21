import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText, RetryError } from "ai";
import { env } from "../env.ts";

/**
 * One call to a language model, and everything that goes wrong on the way.
 *
 * Extracted when a second feature needed it. It was all inline in
 * `polish-reply.ts` while polishing was the only place a model ran; the ticket
 * summariser needs the identical machinery — the fallback chain, the shared
 * deadline, the translation of a provider's failure into a sentence an agent
 * can act on — and none of the prompt. Copying eighty lines of that would mean
 * two places to fix the day OpenRouter changes its ceiling, and the copy that
 * got missed would fail exactly the way this file's comments say these
 * failures fail: silently, or as a button that has never worked.
 *
 * What is *not* here is anything about a particular task: no instructions, no
 * temperature, no length policy. Those belong to the feature, because they are
 * the feature — see `polish-reply.ts` and `summarize-ticket.ts`.
 */

/**
 * How long to wait before giving up on the model.
 *
 * A free-tier model queues, and a request that queues forever holds an Express
 * handler and a browser spinner with it — so there has to be a ceiling.
 *
 * Sixty seconds rather than a snappier number, because this budget covers the
 * whole fallback chain and not one call. Measured against the live free tier: a
 * throttled model refuses in well under a second, but one that *accepts* can
 * take twenty, so a chain that walks past three refusals into a slow answer
 * needs room that a 30s ceiling did not leave — it turned a request that was
 * about to succeed into a 502. The ordinary case finishes in a few seconds;
 * this bound is for the bad one, where the alternative is failing work the
 * agent would rather wait for.
 */
const TIMEOUT_MS = 60_000;

/**
 * How many model ids OpenRouter will accept in one `models` array.
 *
 * Their hard limit, not a tuning choice: a fourth entry is rejected outright
 * with `'models' array must have 3 items or fewer`, which fails *every*
 * request rather than degrading — and it arrives as a generic call error, so
 * the symptom is a button that has never worked on a chain that looks
 * perfectly reasonable in `.env`. Hence `modelBatches`, which keeps
 * `OPENROUTER_MODEL` free to name as many models as an install likes.
 */
const OPENROUTER_MODELS_PER_REQUEST = 3;

/**
 * Thrown for anything the caller can be told about — the model timed out, the
 * provider refused, the answer came back unusable. The routes turn it into a
 * 502; keeping the HTTP vocabulary out of here is what lets these modules be
 * tested without an Express request.
 *
 * Its `message` is written to be rendered to an agent as-is, which is the rule
 * every thrower has to keep: the provider's own error text carries the URL, the
 * model id and sometimes the key's prefix, and belongs on `cause` for the log
 * line rather than in the browser.
 */
export class ModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelError";
  }
}

/**
 * What to tell the agent about a provider failure.
 *
 * One message per thing they might actually do about it, which is the only
 * reason to tell them apart: a rate limit means press the button again in a
 * minute, a rejected key means fetch an admin, and a timeout means the model is
 * slow today. A single "could not be reached" for all three sends an agent
 * looking for a network problem while a free tier is simply busy — which is the
 * ordinary case on `:free` models, not the rare one.
 *
 * The AI SDK wraps its attempts in a `RetryError` once `maxRetries` is spent,
 * so the status lives one level down on `lastError`; reading the outer error
 * alone finds no `statusCode` and reports every failure as the generic one.
 *
 * Exported for its test: every branch here is reachable only from a provider
 * this suite does not call, and getting one wrong is silent — a plausible
 * sentence that sends the reader somewhere useless.
 */
export function describeProviderFailure(error: unknown): string {
  // An abort is our own timeout firing, not the provider's answer, and it
  // arrives as a DOMException rather than anything the SDK defines.
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The model took too long to answer. Please try again.";
  }

  const call = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(call)) {
    return "The model could not be reached. Please try again.";
  }

  switch (call.statusCode) {
    case 429:
      // The common one on a free model: OpenRouter's upstream pool is shared,
      // so this says nothing about this install's own usage.
      return "The model is rate-limited right now. Please try again in a minute.";
    case 401:
    case 403:
      // Worth naming the variable: an agent cannot fix this, and the message is
      // what tells them who can.
      return "The model provider rejected this server's credentials. Check OPENROUTER_API_KEY.";
    case 402:
      return "The model provider reports this account is out of credit.";
    case 404:
      // A model id that no longer exists — the failure `OPENROUTER_MODEL` being
      // configurable exists to make fixable.
      return "The configured model is unavailable. Check OPENROUTER_MODEL.";
    default:
      return "The model could not be reached. Please try again.";
  }
}

/**
 * Cuts the preference order into groups OpenRouter will accept, preserving
 * order so the primary stays first.
 *
 * Exported for its test: the off-by-one that sends four ids is invisible in
 * review and fatal at runtime.
 */
export function modelBatches(
  ids: readonly string[],
  size = OPENROUTER_MODELS_PER_REQUEST,
): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    batches.push(ids.slice(i, i + size));
  }
  return batches;
}

/**
 * Strips the wrappers a small instruction-tuned model adds despite being asked
 * not to.
 *
 * Only the ones that are unambiguous: a fenced code block around the whole
 * answer, and — when the caller names one — the prompt's own tags echoed back.
 * A leading "Here is your improved reply:" is deliberately *not* stripped:
 * there is no way to tell that line from a first sentence the agent actually
 * wrote, and deleting a real one is worse than leaving a stray one for them to
 * select and remove.
 *
 * `tag` is the caller's because only the caller knows which tags its prompt
 * used; a summary has no `<draft>` to echo, and stripping one it never sent
 * would be a rule guarding nothing.
 *
 * Exported for its test: every branch here fails silently, by handing back text
 * that looks plausible until someone reads it.
 */
export function unwrapModelText(text: string, tag?: string): string {
  let out = text.trim();

  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(out);
  if (fenced?.[1] !== undefined) out = fenced[1].trim();

  if (tag) {
    const tagged = new RegExp(`^<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>$`).exec(
      out,
    );
    if (tagged?.[1] !== undefined) out = tagged[1].trim();
  }

  return out;
}

/** One request to the model, as the features describe theirs. */
export interface ModelRequest {
  /** The task, sent as the system turn. */
  instructions: string;
  /** The material, sent as the user turn. */
  prompt: string;
  /**
   * How much variation the task wants. It is per-feature because it *is* the
   * feature: composing prose and extracting facts want different settings, and
   * a shared default would be wrong for one of them.
   */
  temperature: number;
  /** A runaway guard, not a length policy — the policy is the caller's ceiling. */
  maxOutputTokens: number;
}

/** Text in, text out, with everything about the provider already handled. */
export type TextGenerator = (request: ModelRequest) => Promise<string>;

/**
 * A factory over the credentials, returning `undefined` when there are none —
 * the same shape `getDb()` and `createAuth(db)` have, and for the same reason:
 * the API boots without this configured, and the routes answer for its absence
 * rather than the process refusing to start. See `OPENROUTER_API_KEY` in
 * `env.ts` for why this one is optional even in production.
 */
export function createTextGenerator(): TextGenerator | undefined {
  if (!env.OPENROUTER_API_KEY) return undefined;

  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  const batches = modelBatches(env.OPENROUTER_MODEL);

  return async ({ instructions, prompt, temperature, maxOutputTokens }) => {
    // One deadline for the whole walk rather than one per batch, which is the
    // only way the ceiling means anything: a per-batch timeout would multiply
    // by the number of batches, so a long chain could hold the request for
    // minutes while every individual call looked well-behaved.
    const deadline = AbortSignal.timeout(TIMEOUT_MS);

    let text: string | undefined;
    let lastError: unknown;

    for (const batch of batches) {
      const [primary, ...rest] = batch;

      try {
        const result = await generateText({
          model: openrouter.chat(primary!),
          // `instructions` rather than the deprecated `system`, which is the v7
          // spelling. OpenRouter maps it onto whatever the model's own template
          // wants, which matters for a Gemma: its chat template has no system
          // turn of its own.
          instructions,
          prompt,
          // OpenRouter's own fallback routing *within* this batch: it serves
          // the first model here that will take the request, so a throttled
          // primary costs a few hundred milliseconds rather than a 502. Sent
          // only when there is somewhere to fall back to, so a single-model
          // install's requests stay exactly what they were.
          ...(rest.length > 0
            ? { providerOptions: { openrouter: { models: batch } } }
            : {}),
          temperature,
          maxOutputTokens,
          // Zero, because the chain *is* the retry strategy and a retry here
          // would re-ask the same throttled pool that just refused. The shared
          // deadline above is what bounds the walk.
          maxRetries: 0,
          abortSignal: deadline,
        });
        text = result.text;
        break;
      } catch (error) {
        lastError = error;
        // A spent deadline means every remaining batch would abort instantly
        // and bury the real reason under a timeout, so stop here and report
        // what actually happened.
        if (deadline.aborted) break;
      }
    }

    if (text === undefined) {
      // Wrapped rather than rethrown: the provider's errors carry the URL, the
      // model id and sometimes the key's prefix, and the SPA renders an error
      // message verbatim. The original stays on `cause` for the log line.
      throw new ModelError(describeProviderFailure(lastError), {
        cause: lastError,
      });
    }

    return text;
  };
}
