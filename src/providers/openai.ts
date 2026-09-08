// Chat-completions adapter. Speaks to OpenAI and to everything that copies its
// shape — Groq, Together, Ollama, vLLM, LM Studio — by pointing at a different
// base URL. Two things differ from the Messages API and both bite:
//
//   1. Tool results are their own `role: "tool"` messages, one per result, not
//      blocks inside a user turn. One Vaan message fans out into several.
//   2. `max_tokens` is deprecated upstream in favour of `max_completion_tokens`,
//      but most compatible servers only accept the old name. We send the name
//      that works everywhere.

import { postJson } from "../http.js";
import type {
  Message,
  Part,
  Provider,
  ProviderReply,
  ProviderRequest,
  StopReason,
  Tool,
} from "../types.js";
import { isRecord, parseArguments, type AdapterOptions } from "./shared.js";

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
