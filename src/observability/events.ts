// The event taxonomy, and the redactor.
//
// This module is a leaf on purpose: permissions, the sandbox, the providers and
// the loop all emit into it, so it must not import any of them. Events are
// plain data with string discriminants for exactly that reason.
//
// Nothing here is allowed to record a credential. `redact` runs over every
// payload on the way in, not on the way out, so a secret is never written to
// disk in the first place — a trace file that has to be sanitised later is a
// trace file that already leaked.

/** One step in a request's life. `at` and `ms` are stamped by the recorder. */
export type TraceEvent =
  | { kind: "request"; input: string; model: string; workspace: string }
  | { kind: "model_call"; provider: string; model: string; tokensIn?: number; tokensOut?: number }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; ok: boolean; summary: string }
  | { kind: "permission"; tool: string; capability: string; target: string; decision: string; reason: string }
  | { kind: "sandbox"; op: string; target: string; ok: boolean; detail?: string }
  | { kind: "memory"; op: string; detail: string }
  | { kind: "error"; where: string; message: string }
  | { kind: "result"; ok: boolean; summary: string };

export type RecordedEvent = TraceEvent & {
  /** ISO timestamp. */
  at: string;
  /** Milliseconds since the request began. */
  ms: number;
};

/** Field names whose value is a secret whatever it looks like. */
const SECRET_KEYS =
  /^(?:.*_)?(?:api[-_]?key|apikey|authorization|auth|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|credentials|cookie|session|private[-_]?key)$/i;

/** Shapes that are a secret whatever they're called. */
const SECRET_VALUES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

export const REDACTED = "[redacted]";

/** Strip anything that looks like a credential out of a string. */
export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Deep-copy `value` with every secret removed: keys whose *name* marks them
 * secret lose their value entirely, and every remaining string is scanned for
 * secret-shaped substrings. Cycles are cut rather than followed.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? REDACTED : redact(item, seen);
  }
  return out;
}

/** Redact an event's free-form payload. Called once, as the event is recorded. */
export function redactEvent(event: TraceEvent): TraceEvent {
  switch (event.kind) {
    case "tool_call":
      return { ...event, input: redact(event.input) };
    case "request":
      return { ...event, input: redactText(event.input) };
    case "tool_result":
      return { ...event, summary: redactText(event.summary) };
    case "result":
      return { ...event, summary: redactText(event.summary) };
    case "error":
      return { ...event, message: redactText(event.message) };
    case "permission":
      return { ...event, target: redactText(event.target), reason: redactText(event.reason) };
    case "sandbox":
      return {
        ...event,
        target: redactText(event.target),
        ...(event.detail === undefined ? {} : { detail: redactText(event.detail) }),
      };
    case "memory":
      return { ...event, detail: redactText(event.detail) };
    default:
      return event;
  }
}

/** One line per event, for `vaan trace`. */
export function describeEvent(event: RecordedEvent): string {
  switch (event.kind) {
    case "request":
      return `request   ${clip(event.input, 60)}`;
    case "model_call": {
      const tokens =
        event.tokensIn === undefined ? "" : `  ${event.tokensIn} in / ${event.tokensOut ?? 0} out`;
      return `model     ${event.provider}/${event.model}${tokens}`;
    }
    case "tool_call":
      return `tool      ${event.tool}`;
    case "tool_result":
      return `${event.ok ? "result  " : "FAILED  "}  ${event.tool} — ${clip(event.summary, 60)}`;
    case "permission":
      return `permit    ${event.capability} ${clip(event.target, 40)} — ${event.decision.toUpperCase()}`;
    case "sandbox":
      return `sandbox   ${event.op} ${clip(event.target, 50)}${event.ok ? "" : " — failed"}`;
    case "memory":
      return `memory    ${event.op} ${clip(event.detail, 50)}`;
    case "error":
      return `error     ${event.where}: ${clip(event.message, 60)}`;
    case "result":
      return `${event.ok ? "done" : "FAIL"}      ${clip(event.summary, 60)}`;
  }
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max)}…`;
};
