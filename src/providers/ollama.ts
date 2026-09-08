// Ollama, and anything else serving an OpenAI-shaped API on this machine.
//
// It is the chat-completions adapter pointed at localhost, with one thing added
// that matters more than it looks: when the daemon isn't running, `fetch` fails
// with `ECONNREFUSED` and a URL, which reads like a bug in Vaan rather than a
// program that isn't started. Local models are the path people try first, so
// the first failure they see should say what to do.

import type { Provider, ProviderReply, ProviderRequest } from "../types.js";
import { openaiProvider } from "./openai.js";
import type { AdapterOptions } from "./shared.js";

export const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export type OllamaOptions = AdapterOptions;

export function ollamaProvider(opts: OllamaOptions): Provider {
  // No key: the header goes out anyway and the daemon ignores it.
  const inner = openaiProvider({ ...opts, apiKey: opts.apiKey || "local" });

  return {
    name: opts.name,
    async generate(req: ProviderRequest): Promise<ProviderReply> {
      try {
        return await inner.generate(req);
      } catch (err) {
        throw explain(err, opts.baseUrl, req.model);
      }
    },
  };
}

function explain(err: unknown, baseUrl: string, model: string): Error {
  const detail = err instanceof Error ? err.message : String(err);

  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(detail)) {
    return new Error(
      `Nothing is answering at ${baseUrl}. Start the daemon with \`ollama serve\`, ` +
        `then \`ollama pull ${model}\` if you haven't already.`,
    );
  }
  if (/404/.test(detail) && /model/i.test(detail)) {
    return new Error(`Ollama doesn't have "${model}". Pull it first: \`ollama pull ${model}\`.`);
  }
  return err instanceof Error ? err : new Error(detail);
}
