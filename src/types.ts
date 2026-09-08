// The vocabulary every other file speaks. Nothing here knows about a
// particular provider; the adapters in src/providers translate to and from
// these shapes at the edge.

import type { Gate } from "./permissions/approval.js";
import type { Policy } from "./permissions/policy.js";
import type { Trace } from "./observability/trace.js";
import type { NetworkPolicy } from "./sandbox/network.js";

/** One piece of a turn. A turn is a list of these. */
export type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean };

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  parts: Part[];
  /**
   * The provider's own representation of this turn, kept verbatim.
   *
   * Reasoning content — Claude `thinking` blocks, OpenAI reasoning fields — is
   * opaque, signed, and must be echoed back byte-for-byte on the last assistant
   * turn or the next request is rejected. `parts` is lossy by design, so
   * adapters stash the original here and re-send that instead of rebuilding.
   * The loop never touches it; it just carries the message along.
   */
  raw?: unknown;
}

/** JSON Schema for a tool's input. Deliberately loose — providers pass it through. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * What a tool is handed when it runs.
 *
 * Note what a tool gets and what it does not. It gets `gate`, which it must ask
 * before touching anything. It does not get the approver behind the gate — that
 * function is closed over the terminal and is unreachable from here, which is
 * the mechanical reason the model cannot approve its own actions.
 */
export interface ToolContext {
  /** The directory Vaan was pointed at. Every file tool is jailed to it. */
  workspace: string;
  /** Ask permission. Throws `PermissionDenied` when the answer is no. */
  gate: Gate;
  /** Classifies an action into the capability the gate is asked about. */
  policy: Policy;
  /** Where this tool's work is recorded. */
  trace: Trace;
  /** What the agent may reach over the network. */
  network: NetworkPolicy;
  /** Show the user a diff and wait. Separate from `gate`: what, not whether. */
  confirm(message: string): Promise<boolean>;
  /** Store a fact about the user. Never throws — memory is not load-bearing. */
  remember(fact: string): Promise<void>;
  /** The environment sandboxed processes inherit, credentials already stripped. */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Which tool group this belongs to, for the onboarding toggles. */
  group: ToolGroup;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

/** The groups the onboarding turns on and off, and `/status` reports. */
export type ToolGroup =
  | "files"
  | "search"
  | "git"
  | "web"
  | "browser"
  | "code"
  | "memory"
  | "integrations";

export const TOOL_GROUPS: ToolGroup[] = [
  "files",
  "search",
  "git",
  "web",
  "browser",
  "code",
  "memory",
  "integrations",
];

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: Tool[];
  maxTokens: number;
  signal?: AbortSignal;
}

/**
 * Why the model stopped. Not every stop is a stop:
 * `pause` means send the same history back, `max_tokens` means raise the cap.
 */
export type StopReason = "done" | "tool_use" | "pause" | "max_tokens";

export interface Usage {
  input: number;
  output: number;
}

export interface ProviderReply {
  message: Message;
  stop: StopReason;
  usage?: Usage;
}

/** What `stream` yields. `done` always arrives last, and carries the whole reply. */
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; reply: ProviderReply };

export interface Provider {
  /** Registry prefix, e.g. "anthropic" in `anthropic/claude-opus-4-8`. */
  name: string;
  /** Env var holding this provider's key, if it needs one. `/model` reports it. */
  envKey?: string;
  generate(req: ProviderRequest): Promise<ProviderReply>;
  /**
   * The same turn, incrementally. Adapters without a streaming endpoint satisfy
   * this with `fallbackStream`, which yields one text event and then `done` —
   * correct, just not incremental.
   */
  stream(req: ProviderRequest): AsyncIterable<ModelEvent>;
}
