// Chat-completions adapter. Speaks to OpenAI and to everything that copies its
// shape — Groq, Together, Ollama, vLLM, LM Studio — by pointing at a different
// base URL. Two things differ from the Messages API and both bite:
//
//   1. Tool results are their own `role: "tool"` messages, one per result, not
//      blocks inside a user turn. One Vaan message fans out into several.
//   2. `max_tokens` is deprecated upstream in favour of `max_completion_tokens`,
//      but most compatible servers only accept the old name. We send the name
//      that works everywhere.

import { parseFrameData, postJson, postSse } from "../http.js";
import type {
  Message,
  ModelEvent,
  Part,
  Provider,
  ProviderReply,
  ProviderRequest,
  StopReason,
  Tool,
} from "../types.js";
import { fallbackStream, isRecord, parseArguments, type AdapterOptions } from "./shared.js";

interface WireToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  content?: string | null;
  tool_calls?: WireToolCall[];
}

interface Response {
  choices?: { message?: WireMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export type OpenAIOptions = AdapterOptions;

export function openaiProvider(opts: OpenAIOptions): Provider {
  const generate = async (req: ProviderRequest): Promise<ProviderReply> => {
    const json = (await postJson(`${opts.baseUrl}/chat/completions`, {
      // Ollama and friends ignore the header; sending it unconditionally is
      // simpler than teaching the adapter which servers want auth.
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: wireBody(req, false),
      ...(req.signal ? { signal: req.signal } : {}),
    })) as Response;
    return fromWire(json);
  };

  return {
    name: opts.name,
    ...(opts.envKey ? { envKey: opts.envKey } : {}),
    generate,
    stream(req) {
      return streamCompletions(opts, req, generate);
    },
  };
}

function wireBody(req: ProviderRequest, stream: boolean): Record<string, unknown> {
  const messages: unknown[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const message of req.messages) messages.push(...toWireMessages(message));

  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages,
    ...(req.tools.length ? { tools: req.tools.map(toWireTool) } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

function toWireMessages(message: Message): unknown[] {
  // GUARD 1. Echo the assistant turn exactly as it arrived. Reasoning models
  // return fields we don't model (`reasoning_content` and friends) that have to
  // come back unmodified, and the turn's `tool_calls` must match the `tool`
  // messages that follow it.
  if (message.role === "assistant" && isRecord(message.raw)) return [message.raw];

  const results = message.parts.filter((part) => part.type === "tool_result");
  if (results.length > 0) {
    // Fan out: one `tool` message per result. Unlike the Messages API these
    // are siblings, not blocks inside a single user turn.
    return results.map((part) => ({
      role: "tool",
      tool_call_id: part.id,
      content: part.isError ? `Error: ${part.output}` : part.output,
    }));
  }

  const text = message.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  return [{ role: message.role, content: text }];
}

const toWireTool = (tool: Tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
});

function fromWire(res: Response): ProviderReply {
  const choice = res.choices?.[0];
  const wire = choice?.message ?? {};
  const message: Message = { role: "assistant", parts: partsOf(wire), raw: wire };
  const usage = res.usage
    ? { input: res.usage.prompt_tokens ?? 0, output: res.usage.completion_tokens ?? 0 }
    : undefined;
  return { message, stop: toStopReason(choice?.finish_reason), ...(usage ? { usage } : {}) };
}

function partsOf(wire: WireMessage): Part[] {
  const parts: Part[] = [];
  if (wire.content) parts.push({ type: "text", text: wire.content });
  for (const call of wire.tool_calls ?? []) {
    if (!call.id || !call.function?.name) continue;
    parts.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }
  return parts;
}

function toStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      // There is no `pause_turn` equivalent in this shape.
      return "done";
  }
}

// ---------------------------------------------------------------------------
// Streaming.

interface Delta {
  content?: string | null;
  tool_calls?: WireToolCall[];
}

interface StreamChunk {
  choices?: { delta?: Delta; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Reassemble a streamed completion into the same message `generate` returns.
 *
 * Tool calls arrive as fragments keyed by `index`, not by id — the id itself
 * only appears in the first fragment — so they're accumulated positionally and
 * only announced once the stream is done and the arguments are complete JSON.
 */
async function* streamCompletions(
  opts: OpenAIOptions,
  req: ProviderRequest,
  generate: (req: ProviderRequest) => Promise<ProviderReply>,
): AsyncGenerator<ModelEvent> {
  const calls: WireToolCall[] = [];
  let text = "";
  let finish: string | undefined;
  let usage: { input: number; output: number } | undefined;
  let yielded = false;

  try {
    const frames = postSse(`${opts.baseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: wireBody(req, true),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    for await (const frame of frames) {
      const chunk = parseFrameData(frame.data) as StreamChunk | undefined;
      if (!chunk) continue;

      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;

      const content = choice.delta?.content;
      if (content) {
        text += content;
        yielded = true;
        yield { type: "text", text: content };
      }

      for (const fragment of choice.delta?.tool_calls ?? []) {
        const index = fragment.index ?? calls.length;
        const existing = calls[index] ?? { function: { name: "", arguments: "" } };
        calls[index] = {
          id: fragment.id ?? existing.id,
          index,
          function: {
            name: fragment.function?.name ?? existing.function?.name,
            arguments: (existing.function?.arguments ?? "") + (fragment.function?.arguments ?? ""),
          },
        };
      }
    }
  } catch (err) {
    if (!yielded) {
      yield* fallbackStream(generate, req);
      return;
    }
    throw err;
  }

  const assembled: WireMessage = {
    ...(text ? { content: text } : {}),
    ...(calls.length ? { tool_calls: calls.filter((call) => call !== undefined) } : {}),
  };
  for (const part of partsOf(assembled)) {
    if (part.type === "tool_call") {
      yield { type: "tool_call", id: part.id, name: part.name, input: part.input };
    }
  }

  yield {
    type: "done",
    reply: {
      message: { role: "assistant", parts: partsOf(assembled), raw: assembled },
      stop: toStopReason(finish),
      ...(usage ? { usage } : {}),
    },
  };
}
