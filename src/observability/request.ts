// A request is one complete agent flow: what the user asked, through to the
// answer. Everything the runtime does carries this id, which is the only thing
// that makes a trace reconstructable after the fact.

import { randomUUID } from "node:crypto";

export interface RequestContext {
  /** The id printed to the user and used as the trace filename. */
  id: string;
  input: string;
  model: string;
  workspace: string;
  startedAt: number;
  /** ISO timestamp, for the stored trace. */
  at: string;
}

export function newRequest(input: string, model: string, workspace: string): RequestContext {
  return {
    id: randomUUID(),
    input,
    model,
    workspace,
    startedAt: Date.now(),
    at: new Date().toISOString(),
  };
}

/** Enough of an id to say out loud, and to disambiguate in `vaan trace`. */
export const shortId = (id: string): string => id.slice(0, 8);

export const elapsedMs = (ctx: RequestContext): number => Date.now() - ctx.startedAt;

/** Accepts a full uuid or any unambiguous prefix, which is what people type. */
export const idMatches = (id: string, query: string): boolean =>
  id === query || id.startsWith(query.toLowerCase());
