// Messages API adapter. https://docs.claude.com/en/api/messages
//
// Note what this does *not* send: a `thinking` parameter. Vaan passes any model
// string through untouched, and the right thinking config differs per model —
// `{type:"adaptive"}` is rejected by older models, `budget_tokens` is rejected
// by newer ones. So we send the minimal valid body and handle whatever comes
// back. Thinking blocks still arrive unrequested on models where reasoning is
// always on, which is exactly why GUARD 1 exists.

import { postJson, postSse, parseFrameData } from "../http.js";
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
import { fallbackStream, type AdapterOptions } from "./shared.js";

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
  // Flipped off the first time an endpoint turns out not to speak SSE, so a
  // gateway without streaming costs one wasted request rather than one per
  // turn for the life of the session.
  const streaming = { on: true };

  const generate = async (req: ProviderRequest): Promise<ProviderReply> => {
    const json = (await postJson(`${opts.baseUrl}/v1/messages`, {
      headers: headers(opts.apiKey),
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
      if (!streaming.on) return fallbackStream(generate, req);
      return streamMessages(opts, req, generate, streaming);
    },
  };
}

const headers = (apiKey: string): Record<string, string> => ({
  "x-api-key": apiKey,
  "anthropic-version": API_VERSION,
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

// ---------------------------------------------------------------------------
// Streaming.

interface Building extends Block {
  /** tool_use inputs arrive as JSON fragments and are parsed at block_stop. */
  json?: string;
}

/**
 * Reassemble a streamed turn into exactly the shape `generate` returns.
 *
 * The reassembled block list becomes `raw`, so GUARD 1 holds for streamed turns
 * too: thinking blocks go back with their signatures intact. If the stream
 * fails before the first event we fall back to the non-streaming call, because
 * an error at that point cost the caller nothing.
 */
async function* streamMessages(
  opts: AnthropicOptions,
  req: ProviderRequest,
  generate: (req: ProviderRequest) => Promise<ProviderReply>,
  streaming: { on: boolean },
): AsyncGenerator<ModelEvent> {
  const blocks: Building[] = [];
  let stopReason: string | undefined;
  let usage: { input: number; output: number } | undefined;
  let yielded = false;

  let frames;
  try {
    frames = postSse(`${opts.baseUrl}/v1/messages`, {
      headers: headers(opts.apiKey),
      body: wireBody(req, true),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch {
    streaming.on = false;
    yield* fallbackStream(generate, req);
    return;
  }

  try {
    for await (const frame of frames) {
      const payload = parseFrameData(frame.data) as StreamEvent | undefined;
      if (!payload) continue;

      switch (payload.type) {
        case "message_start":
          if (payload.message?.usage) {
            usage = {
              input: payload.message.usage.input_tokens ?? 0,
              output: payload.message.usage.output_tokens ?? 0,
            };
          }
          break;

        case "content_block_start":
          if (payload.index !== undefined && payload.content_block) {
            blocks[payload.index] = { ...payload.content_block, json: "" };
          }
          break;

        case "content_block_delta": {
          const block = payload.index === undefined ? undefined : blocks[payload.index];
          if (!block || !payload.delta) break;
          const delta = payload.delta;
          if (delta.type === "text_delta" && delta.text) {
            block.text = (block.text ?? "") + delta.text;
            yielded = true;
            yield { type: "text", text: delta.text };
          } else if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
            block.json = (block.json ?? "") + delta.partial_json;
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            block.thinking = (block.thinking ?? "") + delta.thinking;
          } else if (delta.type === "signature_delta" && delta.signature) {
            block.signature = (block.signature ?? "") + delta.signature;
          }
          break;
        }

        case "content_block_stop": {
          const block = payload.index === undefined ? undefined : blocks[payload.index];
          if (block?.type === "tool_use" && block.id && block.name) {
            block.input = block.json ? safeJson(block.json) : {};
            yielded = true;
            yield { type: "tool_call", id: block.id, name: block.name, input: block.input };
          }
          break;
        }

        case "message_delta":
          if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
          if (payload.usage?.output_tokens !== undefined && usage) {
            usage.output = payload.usage.output_tokens;
          }
          break;

        default:
          break; // ping, message_stop, and anything added later.
      }
    }
  } catch (err) {
    // Nothing has been handed over yet, so starting again is safe and invisible.
    if (!yielded) {
      // Nothing has been handed over yet, so starting again is invisible.
      streaming.on = false;
      yield* fallbackStream(generate, req);
      return;
    }
    throw err;
  }

  const finished = blocks.filter((block): block is Building => block !== undefined).map(strip);

  // A 200 that isn't actually an event stream — a proxy that buffered it into
  // plain JSON, a gateway that ignored `stream: true` — parses to no frames and
  // throws nothing. Falling back only on a thrown error would hand the caller a
  // silently empty turn, which is worse than a slow one.
  if (!yielded && finished.length === 0) {
    streaming.on = false;
    yield* fallbackStream(generate, req);
    return;
  }

  yield {
    type: "done",
    reply: {
      message: { role: "assistant", parts: partsOf(finished), raw: finished },
      stop: toStopReason(stopReason),
      ...(usage ? { usage } : {}),
    },
  };
}

/** Drop the accumulator before the block goes back to the API as `raw`. */
function strip(block: Building): Block {
  const { json: _json, ...rest } = block;
  return rest;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: Block;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
}
