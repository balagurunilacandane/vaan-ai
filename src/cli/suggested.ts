// The only file in Vaan that knows any model names.
//
// These are shortcuts for the onboarding, not an allowlist — it accepts any
// string you type and passes it straight through. That means a stale entry here
// is cosmetic: when a new model ships, typing its name works on day one whether
// or not this list has caught up.

export interface ModelSuggestion {
  /** `provider/model`, exactly as it would be typed. */
  spec: string;
  note: string;
}

export const SUGGESTED: ModelSuggestion[] = [
  { spec: "anthropic/claude-opus-5", note: "most capable" },
  { spec: "anthropic/claude-sonnet-5", note: "faster, cheaper" },
  { spec: "anthropic/claude-haiku-4-5", note: "cheapest" },
  { spec: "openai/gpt-5", note: "" },
  { spec: "openai/gpt-5-mini", note: "faster, cheaper" },
  { spec: "google/gemini-2.5-pro", note: "" },
  { spec: "ollama/qwen3:8b", note: "local, no key" },
];

/** What `--yes` picks when a provider's key is present but no model was named. */
export const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "anthropic/claude-opus-5",
  openai: "openai/gpt-5",
  google: "google/gemini-2.5-pro",
  ollama: "ollama/qwen3:8b",
  groq: "groq/llama-3.3-70b-versatile",
};

/** The last option in the model list, which asks for a shape and a URL instead. */
export const CUSTOM_NOTE = "your own endpoint";
