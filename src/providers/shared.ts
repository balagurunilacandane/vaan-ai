// Bits every adapter needs, so none of them grows its own copy.

export interface AdapterOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  envKey?: string;
  /**
   * Extra headers this endpoint requires, from the environment.
   *
   * Anthropic keys created at the organisation level rather than inside a
   * workspace are rejected without `anthropic-workspace-id`, and the account
   * shape is not something Vaan can infer — so it is configuration, like the
   * base URL, rather than something to guess.
   */
  headers?: Record<string, string>;
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
