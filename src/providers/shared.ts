// Bits every adapter needs, so none of them grows its own copy.

import type { ModelEvent, ProviderReply, ProviderRequest } from "../types.js";

export interface AdapterOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  envKey?: string;
}

/**
 * `stream` for an adapter that has no streaming endpoint, or whose stream just
 * failed. It waits for the whole turn and then replays it as events: correct,
 * and indistinguishable to a caller that only cares about the events — just not
 * incremental. Better than an interface that is optional on half the providers.
 */
export async function* fallbackStream(
  generate: (req: ProviderRequest) => Promise<ProviderReply>,
  req: ProviderRequest,
): AsyncGenerator<ModelEvent> {
  const reply = await generate(req);
  for (const part of reply.message.parts) {
    if (part.type === "text") yield { type: "text", text: part.text };
    else if (part.type === "tool_call") {
      yield { type: "tool_call", id: part.id, name: part.name, input: part.input };
    }
  }
  yield { type: "done", reply };
}

/** Tool-call arguments arrive as a JSON string, and a model can emit bad JSON. */
export function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // An empty input reaches the tool, which reports what it needed.
    return {};
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
