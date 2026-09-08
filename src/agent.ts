// The loop. Read this first.
//
// A language model can't do anything. It only produces text. When it "reads a
// file" it emits a request saying *please run read_file on agent.ts*. This
// function runs the read, hands the result back, and asks again.
//
// Five things it guards, marked GUARD below. Each one is a bug you only find in
// production: reasoning must round-trip, tool calls arrive in parallel, tool
// errors are data, not every stop is a stop, and a refused permission is an
// answer rather than a crash.
//
// What the loop does *not* do is decide anything about safety. It doesn't know
// what a workspace is, whether a path is allowed, or who approves a command.
// Tools ask the gate; the gate asks a human. Keeping that out of here is why
// this file stays readable.

import type { Trace } from "./observability/trace.js";
import { PermissionDenied } from "./permissions/approval.js";
import type { Message, ModelEvent, Part, Provider, ProviderReply, Tool, ToolContext, Usage } from "./types.js";

type ToolCall = Extract<Part, { type: "tool_call" }>;
type ToolResult = Extract<Part, { type: "tool_result" }>;

export interface AgentOptions {
  provider: Provider;
  model: string;
  system: string;
  tools: Tool[];
  ctx: ToolContext;
  /** Cap on model round-trips, so a confused model can't loop forever. */
  maxSteps?: number;
  maxTokens?: number;
  /** Read the reply incrementally. The REPL does; evals and the gate don't. */
  stream?: boolean;
  trace?: Trace;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/** Progress as it happens, so the REPL can print instead of sitting silent. */
export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean };

export interface AgentResult {
  text: string;
  /** The full transcript, tool traffic included. Memory stores this. */
  messages: Message[];
  /** Which tools actually ran, in order. The headline eval grader reads this. */
  usedTools: string[];
  /** Summed over every round-trip this turn took. Undefined if nobody reported. */
  usage?: Usage;
  /** Model round-trips actually spent. */
  steps: number;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_TOKENS = 4096;

/** Answer one prompt. */
export function runAgent(prompt: string, opts: AgentOptions): Promise<AgentResult> {
  const first: Message = { role: "user", parts: [{ type: "text", text: prompt }] };
  return continueAgent([first], opts);
}

/** The same loop, resuming a transcript. The REPL uses this from turn two on. */
export async function continueAgent(
  messages: Message[],
  opts: AgentOptions,
): Promise<AgentResult> {
  const { model, system, tools, ctx, signal, trace } = opts;
  const usedTools: string[] = [];
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  let maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  let raisedCap = false;
  let usage: Usage | undefined;
  let steps = 0;

  for (let step = 0; step < maxSteps; step++) {
    steps = step + 1;
    const request = { model, system, tools, messages, maxTokens, ...(signal ? { signal } : {}) };
    const reply = opts.stream
      ? await consume(opts.provider.stream(request), opts.onEvent)
      : await opts.provider.generate(request);

    if (reply.usage) {
      usage = {
        input: (usage?.input ?? 0) + reply.usage.input,
        output: (usage?.output ?? 0) + reply.usage.output,
      };
    }
    trace?.record({
      kind: "model_call",
      provider: opts.provider.name,
      model,
      ...(reply.usage ? { tokensIn: reply.usage.input, tokensOut: reply.usage.output } : {}),
    });

    // GUARD 4a. Truncated mid-turn. Whatever we got is half-written — a tool
    // call with an unparseable input, a sentence that stops dead — so throw it
    // away rather than append it, raise the cap, and ask again unchanged.
    if (reply.stop === "max_tokens" && !raisedCap) {
      raisedCap = true;
      maxTokens *= 2;
      continue;
    }

    // GUARD 1. Push the provider's own message object, never one we rebuilt
    // from `parts`. `raw` rides along inside it, so signed reasoning blocks go
    // back byte-for-byte on the next request instead of being dropped.
    messages.push(reply.message);

    // GUARD 4b. `pause_turn` is neither an answer nor an error. The provider
    // is asking for the same history back so it can pick up where it stopped.
    if (reply.stop === "pause") continue;

    const text = textOf(reply.message);
    if (text && !opts.stream) opts.onEvent?.({ type: "text", text });

    const calls = reply.message.parts.filter(isToolCall);
    if (calls.length === 0) return { text, messages, usedTools, steps, ...(usage ? { usage } : {}) };

    // GUARD 2. One turn can carry several calls. Run them together, then put
    // every result in the *single* next message, each keyed by its call id.
    // Split them across two messages and the provider rejects the turn.
    const results = await Promise.all(
      calls.map(async (call): Promise<ToolResult> => {
        // Recorded before it runs: the trajectory grader asks what the model
        // reached for, and a tool that failed was still a tool it reached for.
        usedTools.push(call.name);
        opts.onEvent?.({ type: "tool_call", name: call.name, input: call.input });
        trace?.record({ kind: "tool_call", tool: call.name, input: call.input });

        const part = await runTool(call, tools, ctx);
        const { output, isError } = part;
        opts.onEvent?.({ type: "tool_result", name: call.name, output, isError });
        trace?.record({
          kind: "tool_result",
          tool: call.name,
          ok: !isError,
          summary: output.split("\n")[0] ?? "",
        });
        return part;
      }),
    );
    messages.push({ role: "user", parts: results });
  }

  const text = `Stopped after ${maxSteps} steps without reaching an answer.`;
  trace?.record({ kind: "error", where: "agent", message: text });
  return { text, messages, usedTools, steps, ...(usage ? { usage } : {}) };
}

/** Drain a streamed turn, forwarding deltas, and hand back the assembled reply. */
async function consume(
  events: AsyncIterable<ModelEvent>,
  onEvent: ((event: AgentEvent) => void) | undefined,
): Promise<ProviderReply> {
  let reply: ProviderReply | undefined;
  for await (const event of events) {
    if (event.type === "text") onEvent?.({ type: "delta", text: event.text });
    else if (event.type === "done") reply = event.reply;
  }
  if (!reply) throw new Error("The provider's stream ended without finishing the turn.");
  return reply;
}

/**
 * GUARD 3. A tool that throws is information, not a crash. The failure goes
 * back to the model flagged as an error so it can recover — a missing file
 * usually means it should try a different path, not that the run is over.
 *
 * GUARD 5. A refused permission is the same kind of information, and the
 * wording matters: the model has to understand that the answer was no and that
 * asking again the same way will get the same no. It is not a transient error
 * to retry, and it is not a reason to look for another route to the same place.
 */
async function runTool(call: ToolCall, tools: Tool[], ctx: ToolContext): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return toolResult(call.id, `No tool named "${call.name}".`, true);
  try {
    return toolResult(call.id, await tool.run(asRecord(call.input), ctx), false);
  } catch (err) {
    if (err instanceof PermissionDenied) {
      return toolResult(
        call.id,
        `${err.message}. The user was asked and the answer was no — don't retry this or ` +
          `look for another way to do it. Tell them what you needed and why.`,
        true,
      );
    }
    return toolResult(call.id, `${call.name} failed: ${describe(err)}`, true);
  }
}

const toolResult = (id: string, output: string, isError: boolean): ToolResult => ({
  type: "tool_result",
  id,
  output,
  isError,
});

const isToolCall = (part: Part): part is ToolCall => part.type === "tool_call";

const textOf = (message: Message): string =>
  message.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

const asRecord = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
