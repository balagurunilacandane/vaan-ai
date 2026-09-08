// The registry, and the string that picks a model.
//
// `anthropic/claude-opus-4-8`, `openai/gpt-5`, `google/gemini-2.5-pro`,
// `ollama/qwen3:8b`. The prefix picks an adapter; everything after the first
// slash is the model name and is passed through untouched. There is no
// allowlist of model names anywhere in this codebase, on purpose — a model
// released tomorrow works today.

import type { Provider } from "../types.js";
import { customProvider, isShape, SHAPES, type Shape } from "./custom.js";
import { OLLAMA_BASE_URL } from "./ollama.js";

export interface ProviderSpec {
  name: string;
  shape: Shape;
  baseUrl: string;
  envKey?: string;
  /** Other names for the same key, tried in order. */
  altEnvKeys?: string[];
}

export type Env = Record<string, string | undefined>;

const ENV_PREFIX = "VAAN_PROVIDER_";

const BUILT_IN: ProviderSpec[] = [
  {
    name: "anthropic",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
  },
  {
    name: "openai",
    shape: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
  },
  {
    name: "google",
    shape: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKey: "GOOGLE_API_KEY",
    altEnvKeys: ["GEMINI_API_KEY"],
  },
  { name: "ollama", shape: "openai", baseUrl: OLLAMA_BASE_URL },
  {
    name: "groq",
    shape: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
  },
];

/**
 * Built-ins plus anything registered through the environment:
 *
 *     VAAN_PROVIDER_TOGETHER=openai:https://api.together.xyz/v1
 *
 * which reads its key from `TOGETHER_API_KEY`. A name that collides with a
 * built-in overrides it, which is how you point `openai` at a proxy.
 */
export function registry(env: Env = process.env): ProviderSpec[] {
  const specs = new Map(BUILT_IN.map((spec) => [spec.name, spec]));
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || !value) continue;
    const name = key.slice(ENV_PREFIX.length).toLowerCase();
    specs.set(name, parseSpec(key, name, value));
  }
  return [...specs.values()];
}

function parseSpec(envName: string, name: string, value: string): ProviderSpec {
  const separator = value.indexOf(":");
  const shape = value.slice(0, separator);
  const baseUrl = value.slice(separator + 1).replace(/\/+$/, "");
  if (!isShape(shape) || !baseUrl) {
    // Loudly, rather than silently ignoring a typo and failing much later
    // with a confusing 404 from whatever the default endpoint was.
    throw new Error(
      `${envName} is malformed. Expected "<shape>:<url>" where shape is ` +
        `"anthropic", "openai" or "google", for example "openai:https://api.example.com/v1".`,
    );
  }
  return { name, shape, baseUrl, envKey: `${name.toUpperCase()}_API_KEY` };
}

/** The first of a spec's key names that is actually set. */
export function keyFor(spec: ProviderSpec, env: Env): string | undefined {
  for (const name of [spec.envKey, ...(spec.altEnvKeys ?? [])]) {
    if (name && env[name]) return env[name];
  }
  return undefined;
}

/** Split `provider/model` and build the adapter. Throws if the key is missing. */
export function resolve(
  spec: string,
  env: Env = process.env,
): { provider: Provider; model: string } {
  const slash = spec.indexOf("/");
  const known = registry(env);
  if (slash === -1) {
    const names = known.map((entry) => entry.name).join(", ");
    throw new Error(
      `"${spec}" is missing a provider prefix. Try one of: ${names}. ` +
        `For example "${known[0]?.name ?? "anthropic"}/${spec}".`,
    );
  }

  const name = spec.slice(0, slash).toLowerCase();
  // Everything after the first slash, verbatim: model names contain slashes
  // (meta-llama/Llama-3-70b) and colons (qwen3:8b).
  const model = spec.slice(slash + 1);
  const found = known.find((entry) => entry.name === name);
  if (!found) {
    const names = known.map((entry) => entry.name).join(", ");
    throw new Error(`Unknown provider "${name}". Registered: ${names}.`);
  }
  if (!model) throw new Error(`"${spec}" has a provider but no model name.`);

  return { provider: build(found, env), model };
}

export function build(spec: ProviderSpec, env: Env = process.env): Provider {
  const apiKey = spec.envKey ? (keyFor(spec, env) ?? "") : "";
  if (spec.envKey && !apiKey) {
    const names = [spec.envKey, ...(spec.altEnvKeys ?? [])].join(" or ");
    throw new Error(
      `${spec.name} needs ${names}. Set it in your environment or .env, ` +
        `or run \`vaan init\` to write one.`,
    );
  }
  return customProvider({
    name: spec.name,
    shape: spec.shape,
    baseUrl: spec.baseUrl,
    apiKey,
    ...(spec.envKey ? { envKey: spec.envKey } : {}),
  });
}

export interface ProviderStatus extends ProviderSpec {
  /** Whether this provider could be used right now — no key needed, or key set. */
  ready: boolean;
}

/** What bare `/model` prints: registered prefixes and which keys are set. */
export function statuses(env: Env = process.env): ProviderStatus[] {
  return registry(env).map((spec) => ({
    ...spec,
    ready: !spec.envKey || Boolean(keyFor(spec, env)),
  }));
}

export { isShape, SHAPES };
export type { Shape };
