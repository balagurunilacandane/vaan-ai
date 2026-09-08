// Gemini adapter. https://ai.google.dev/api/generate-content
//
// Three things differ from the other two shapes:
//
//   1. The assistant role is called `model`, and the system prompt is its own
//      `systemInstruction` field rather than a message.
//   2. Function calls have no ids. The loop needs one to pair a result with its
//      call, so we synthesise `name::index` and recover the name from it on the
//      way back — Gemini matches a `functionResponse` by name, not by id.
//   3. An OBJECT schema with no properties is rejected, so a no-argument tool
//      ships without a `parameters` field at all.

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

/** Separator for synthesised call ids. Not legal in a tool name, so it round-trips. */
const ID_SEPARATOR = "::";

interface WirePart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name: string; response: unknown };
}

interface Candidate {
  content?: { parts?: WirePart[]; role?: string };
  finishReason?: string;
}

interface Response {
  candidates?: Candidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export type GoogleOptions = AdapterOptions;

export function googleProvider(opts: GoogleOptions): Provider {
  const generate = async (req: ProviderRequest): Promise<ProviderReply> => {
    const json = (await postJson(endpoint(opts, req.model, "generateContent"), {
      headers: keyHeader(opts.apiKey),
      body: wireBody(req),
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

// The key goes in a header rather than the query string: a URL ends up in
// proxy logs and in error messages, and a key that has been logged is spent.
const keyHeader = (apiKey: string): Record<string, string> => ({ "x-goog-api-key": apiKey });

const endpoint = (opts: GoogleOptions, model: string, method: string): string =>
  `${opts.baseUrl}/models/${encodeURIComponent(model)}:${method}${
    method === "streamGenerateContent" ? "?alt=sse" : ""
  }`;

function wireBody(req: ProviderRequest): Record<string, unknown> {
  const declarations = req.tools.map(toWireTool);
  return {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: req.messages.map(toWireMessage),
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    generationConfig: { maxOutputTokens: req.maxTokens },
  };
}

function toWireTool(tool: Tool): Record<string, unknown> {
  const hasArgs = Object.keys(tool.parameters.properties).length > 0;
  return {
    name: tool.name,
    description: tool.description,
    ...(hasArgs ? { parameters: tool.parameters } : {}),
  };
}

function toWireMessage(message: Message): { role: string; parts: WirePart[] } {
  // GUARD 1. Gemini's own representation goes back verbatim when we have it.
  if (message.role === "assistant" && isWireContent(message.raw)) {
    return { role: "model", parts: message.raw.parts ?? [] };
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: message.parts.map(toWirePart),
  };
}

function toWirePart(part: Part): WirePart {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "tool_call":
      return { functionCall: { name: part.name, args: part.input ?? {} } };
    case "tool_result":
      return {
        functionResponse: {
          name: nameOf(part.id),
          // Gemini wants an object here; a bare string is rejected.
          response: part.isError ? { error: part.output } : { result: part.output },
        },
      };
  }
}

const nameOf = (id: string): string => id.split(ID_SEPARATOR)[0] ?? id;

function fromWire(res: Response): ProviderReply {
  const candidate = res.candidates?.[0];
  const wireParts = candidate?.content?.parts ?? [];
  const parts = partsOf(wireParts);
  const message: Message = {
    role: "assistant",
    parts,
    raw: { parts: wireParts, role: "model" },
  };
  const usage = res.usageMetadata
    ? {
        input: res.usageMetadata.promptTokenCount ?? 0,
        output: res.usageMetadata.candidatesTokenCount ?? 0,
      }
    : undefined;
  return {
    message,
    stop: toStopReason(candidate?.finishReason, parts),
    ...(usage ? { usage } : {}),
  };
}

function partsOf(wireParts: WirePart[]): Part[] {
  const parts: Part[] = [];
  wireParts.forEach((wire, index) => {
    if (wire.text) parts.push({ type: "text", text: wire.text });
    else if (wire.functionCall?.name) {
      parts.push({
        type: "tool_call",
        id: `${wire.functionCall.name}${ID_SEPARATOR}${index}`,
        name: wire.functionCall.name,
        input: wire.functionCall.args ?? {},
      });
    }
  });
  return parts;
}

function toStopReason(reason: string | undefined, parts: Part[]): StopReason {
  if (parts.some((part) => part.type === "tool_call")) return "tool_use";
  switch (reason) {
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      // STOP, SAFETY, RECITATION, and anything added later: the turn is over.
      return "done";
  }
}

const isWireContent = (value: unknown): value is { parts?: WirePart[] } =>
  typeof value === "object" && value !== null && "parts" in value;
