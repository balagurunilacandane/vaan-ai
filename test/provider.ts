// A Provider that reads from a script instead of the network. Every test in
// this repo runs offline and without an API key; this is how.

import type {
  Message,
  Provider,
  ProviderReply,
  ProviderRequest,
  StopReason,
} from "../src/types.js";

export interface ScriptedProvider extends Provider {
  /** Every request the loop made, in order. Tests assert on the history it sent. */
  readonly requests: ProviderRequest[];
}

export function scripted(replies: ProviderReply[]): ScriptedProvider {
  const requests: ProviderRequest[] = [];
  let index = 0;

  const generate = async (req: ProviderRequest): Promise<ProviderReply> => {
    // Snapshot the history: the loop mutates the array it was handed, so
    // keeping the reference would make every assertion see the final state.
    requests.push({ ...req, messages: structuredClone(req.messages) });
    const reply = replies[index++];
    if (!reply) throw new Error(`scripted provider ran out of replies after ${index - 1}`);
    return reply;
  };

  return {
    name: "scripted",
    requests,
    generate,
  };
}

const assistant = (parts: Message["parts"], raw: unknown): Message => ({
  role: "assistant",
  parts,
  raw,
});

/** A plain answer. */
export const says = (text: string): ProviderReply => ({
  message: assistant([{ type: "text", text }], [{ type: "text", text }]),
  stop: "done",
});

/** One or more tool calls in a single turn. */
export const calls = (
  ...requested: { id: string; name: string; input?: unknown }[]
): ProviderReply => ({
  message: assistant(
    requested.map((call) => ({
      type: "tool_call" as const,
      id: call.id,
      name: call.name,
      input: call.input ?? {},
    })),
    // Stands in for a signed thinking block: opaque, and must survive the trip.
    { opaque: "reasoning", ids: requested.map((call) => call.id) },
  ),
  stop: "tool_use",
});

/** A turn that stopped for some reason other than finishing. */
export const stops = (stop: StopReason, text = ""): ProviderReply => ({
  message: assistant(text ? [{ type: "text", text }] : [], { partial: true }),
  stop,
});
