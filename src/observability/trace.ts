// The recorder, and the reader behind `vaan trace`.
//
// One JSON file per request in .vaan/traces. A file rather than a shared log
// because requests can overlap — a scheduled run while you're typing — and
// interleaved appends from two writers is how a log file becomes unparseable.
//
// Nothing here throws. A trace that can't be written is a missing trace, not a
// failed request; observability that can take the agent down with it is worse
// than no observability.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeEvent, redactEvent, type RecordedEvent, type TraceEvent } from "./events.js";
import { elapsedMs, idMatches, type RequestContext } from "./request.js";

/** Traces past this many are pruned oldest-first, so .vaan never grows forever. */
const KEEP = 200;

export interface StoredTrace {
  id: string;
  at: string;
  input: string;
  model: string;
  workspace: string;
  durationMs: number;
  ok: boolean;
  summary: string;
  events: RecordedEvent[];
}

export interface Trace {
  readonly id: string;
  readonly request: RequestContext;
  record(event: TraceEvent): void;
  /** Close the trace and write it out. Safe to call twice. */
  finish(ok: boolean, summary: string): StoredTrace;
  events(): RecordedEvent[];
}

export interface TraceOptions {
  /** Directory holding `traces/`. Usually `<workspace>/.vaan`. */
  home: string;
  request: RequestContext;
  /** Off means events are still collected in memory but never written. */
  persist?: boolean;
}

export function openTrace(opts: TraceOptions): Trace {
  const collected: RecordedEvent[] = [];
  const { request } = opts;
  let closed = false;

  const record = (event: TraceEvent): void => {
    collected.push({
      ...redactEvent(event),
      at: new Date().toISOString(),
      ms: elapsedMs(request),
    } as RecordedEvent);
  };

  record({
    kind: "request",
    input: request.input,
    model: request.model,
    workspace: request.workspace,
  });

  return {
    id: request.id,
    request,
    record,
    events: () => [...collected],
    finish(ok, summary) {
      if (!closed) {
        closed = true;
        record({ kind: "result", ok, summary });
      }
      const stored: StoredTrace = {
        id: request.id,
        at: request.at,
        input: collected[0]?.kind === "request" ? collected[0].input : request.input,
        model: request.model,
        workspace: request.workspace,
        durationMs: elapsedMs(request),
        ok,
        summary,
        events: collected,
      };
      if (opts.persist !== false) write(opts.home, stored);
      return stored;
    },
  };
}

/** A trace that records nothing, for tests and for `--no-trace`. */
export const noTrace = (request: RequestContext): Trace => ({
  id: request.id,
  request,
  record() {},
  events: () => [],
  finish: (ok, summary) => ({
    id: request.id,
    at: request.at,
    input: request.input,
    model: request.model,
    workspace: request.workspace,
    durationMs: elapsedMs(request),
    ok,
    summary,
    events: [],
  }),
});

const dirOf = (home: string): string => join(home, "traces");

function write(home: string, trace: StoredTrace): void {
  try {
    const dir = dirOf(home);
    mkdirSync(dir, { recursive: true });
    // Timestamp first so a lexical sort is a chronological sort, which is what
    // both the pruner and the listing rely on.
    const stamp = trace.at.replace(/[:.]/g, "-");
    writeFileSync(join(dir, `${stamp}__${trace.id}.json`), JSON.stringify(trace, null, 2), "utf8");
    prune(dir);
  } catch {
    // A trace is a record of work, not the work.
  }
}

function prune(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP))) {
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    // Nothing to prune, or nothing we may prune.
  }
}

/** Newest first. Reads only what `vaan trace` prints, not every event. */
export function listTraces(home: string, limit = 20): StoredTrace[] {
  try {
    return readdirSync(dirOf(home))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((name) => parse(join(dirOf(home), name)))
      .filter((trace): trace is StoredTrace => trace !== undefined);
  } catch {
    return [];
  }
}

/** Look one up by full id or by any prefix, which is what people type. */
export function readTrace(home: string, query: string): StoredTrace | undefined {
  try {
    const match = readdirSync(dirOf(home))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse()
      .find((name) => idMatches(name.split("__")[1]?.replace(/\.json$/, "") ?? "", query));
    return match ? parse(join(dirOf(home), match)) : undefined;
  } catch {
    return undefined;
  }
}

function parse(path: string): StoredTrace | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isTrace(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const isTrace = (value: unknown): value is StoredTrace =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredTrace).id === "string" &&
  Array.isArray((value as StoredTrace).events);

export { describeEvent };
export type { RecordedEvent, TraceEvent };
