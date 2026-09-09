// Messages API adapter. https://docs.claude.com/en/api/messages
//
// Note what this does *not* send: a `thinking` parameter. Vaan passes any model
// string through untouched, and the right thinking config differs per model —
// `{type:"adaptive"}` is rejected by older models, `budget_tokens` is rejected
// by newer ones. So we send the minimal valid body and handle whatever comes
// back. Thinking blocks still arrive unrequested on models where reasoning is
// always on, which is exactly why GUARD 1 exists.

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
import type { AdapterOptions } from "./shared.js";

const API_VERSION = "2023-06-01";

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
  data?: string;
}

interface Response {
  content?: Block[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type AnthropicOptions = AdapterOptions;

export function anthropicProvider(opts: AnthropicOptions): Provider {
  const generate = async (req: ProviderRequest): Promise<ProviderReply> => {
    const json = (await postJson(`${opts.baseUrl}/v1/messages`, {
      headers: headers(opts),
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

const headers = (opts: AnthropicOptions): Record<string, string> => ({
  "x-api-key": opts.apiKey,
  "anthropic-version": API_VERSION,
  ...opts.headers,
});

function wireBody(req: ProviderRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(req.system ? { system: req.system } : {}),
    messages: req.messages.map(toWireMessage),
    ...(req.tools.length ? { tools: req.tools.map(toWireTool) } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function toWireMessage(message: Message): { role: string; content: unknown } {
  // GUARD 1. An assistant turn goes back exactly as it arrived. `thinking`
  // blocks carry a signature over their own contents; rebuilding the turn from
  // `parts` drops both the block and the signature, and the API rejects it.
  if (message.role === "assistant" && Array.isArray(message.raw)) {
    return { role: "assistant", content: message.raw };
  }
  return { role: message.role, content: message.parts.map(toWireBlock) };
}

function toWireBlock(part: Part): unknown {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_call":
      return { type: "tool_use", id: part.id, name: part.name, input: part.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.id,
        content: part.output,
        is_error: part.isError,
      };
  }
}

const toWireTool = (tool: Tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
});

function fromWire(res: Response): ProviderReply {
  const blocks = res.content ?? [];
  const parts = partsOf(blocks);
  const stop = toStopReason(res.stop_reason);

  if (res.stop_reason === "refusal" && !parts.some((part) => part.type === "text")) {
    // A refusal can arrive with an empty content array. Say so rather than
    // handing the REPL a blank answer it can't explain.
    parts.push({ type: "text", text: "The model declined to answer that." });
  }

  const message: Message = { role: "assistant", parts, raw: blocks };
  const usage = res.usage
    ? { input: res.usage.input_tokens ?? 0, output: res.usage.output_tokens ?? 0 }
    : undefined;
  return { message, stop, ...(usage ? { usage } : {}) };
}

function partsOf(blocks: Block[]): Part[] {
  const parts: Part[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && block.id && block.name) {
      parts.push({ type: "tool_call", id: block.id, name: block.name, input: block.input ?? {} });
    }
    // `thinking` and `redacted_thinking` are deliberately not mapped. They are
    // opaque to us and survive untouched in `raw` — see toWireMessage above.
  }
  return parts;
}

function toStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "pause_turn":
      return "pause";
    case "max_tokens":
      return "max_tokens";
    default:
      // end_turn, stop_sequence, refusal, model_context_window_exceeded, and
      // anything added after this was written: the turn is over either way.
      return "done";
  }
}
