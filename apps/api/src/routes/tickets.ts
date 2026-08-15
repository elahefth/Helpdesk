import { Router } from "express";
import {
  listTicketsQuerySchema,
  type ListTicketsResponse,
} from "@helpdesk/shared";
import { HttpError } from "../middleware/errors.ts";

/**
 * Phase 0 placeholder that proves the shared-schema contract end to end: the
 * query string is parsed with the same Zod schema the SPA builds its request
 * from, and the response is typed with the same interface the SPA consumes.
 *
 * Phase 7 swaps the fixture bodies for real Drizzle queries. The signatures
 * do not change.
 */
export const ticketsRouter: Router = Router();

ticketsRouter.get("/tickets", (req, res) => {
  // Throws ZodError on bad input; Express 5 routes that to the error handler.
  const query = listTicketsQuerySchema.parse(req.query);
  req.log.debug({ query }, "listing tickets");

  const body: ListTicketsResponse = { data: [], nextCursor: null };
  res.json(body);
});

ticketsRouter.get("/tickets/:id", (req) => {
  throw HttpError.notFound(`Ticket ${req.params.id} not found`);
});
