// Your own endpoint.
//
// There is no fourth adapter here, and that's the point: a custom provider is a
// declared API shape plus a URL, so pointing Vaan at a self-hosted vLLM, an
// internal gateway or a proxy in front of a frontier model is configuration
// rather than code. The onboarding writes one environment variable:
//
//     VAAN_PROVIDER_TOGETHER=openai:https://api.together.xyz/v1
//
// and the key comes from TOGETHER_API_KEY.

import type { Provider } from "../types.js";
import { anthropicProvider } from "./anthropic.js";
import { googleProvider } from "./google.js";
import { ollamaProvider, OLLAMA_BASE_URL } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import type { AdapterOptions } from "./shared.js";

/** The API shapes Vaan knows how to speak. */
export type Shape = "anthropic" | "openai" | "google";

export const SHAPES: { shape: Shape; endpoint: string; note: string }[] = [
  { shape: "anthropic", endpoint: "/v1/messages", note: "Anthropic" },
  { shape: "openai", endpoint: "/v1/chat/completions", note: "OpenAI, and most gateways" },
  { shape: "google", endpoint: "/v1beta/models/…:generateContent", note: "Google" },
];

export const isShape = (value: string): value is Shape =>
  SHAPES.some((entry) => entry.shape === value);

export interface CustomOptions extends AdapterOptions {
  shape: Shape;
}

/** Build the adapter for a declared shape. The only place shape becomes code. */
export function customProvider(opts: CustomOptions): Provider {
  const { shape, ...rest } = opts;
  switch (shape) {
    case "anthropic":
      return anthropicProvider(rest);
    case "google":
      return googleProvider(rest);
    case "openai":
      // A local endpoint gets the friendlier "is the daemon running" errors;
      // a remote one has a real server behind it that can speak for itself.
      return isLocal(rest.baseUrl) ? ollamaProvider(rest) : openaiProvider(rest);
  }
}

const isLocal = (baseUrl: string): boolean => {
  if (baseUrl === OLLAMA_BASE_URL) return true;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
};
