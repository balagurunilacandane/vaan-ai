// Registry resolution, and the wire shape each adapter actually sends. The
// adapters are where GUARD 1 and GUARD 2 are enforced, so they get pinned here
// against a stubbed fetch rather than a live endpoint.

import { strict as assert } from "node:assert";
import test from "node:test";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { openaiProvider } from "../src/providers/openai.js";
import { registry, resolve, statuses } from "../src/providers/index.js";
import type { Message, Tool } from "../src/types.js";

const KEYS = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", GROQ_API_KEY: "k" };

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function stubFetch(response: unknown): { sent: Captured[]; restore: () => void } {
  const original = globalThis.fetch;
  const sent: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init.body ?? "{}")),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const echoTool: Tool = {
  name: "echo",
  description: "echoes",
  group: "files",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: () => "ok",
};

const toolCall = { type: "tool_call", id: "call_1", name: "echo", input: { text: "hi" } } as const;
const results: Message = {
  role: "user",
  parts: [
    { type: "tool_result", id: "call_1", output: "hi", isError: false },
    { type: "tool_result", id: "call_2", output: "nope", isError: true },
  ],
};

/**
 * A transcript already round-tripped once. Each adapter gets its own `raw`,
 * because `raw` is whatever that provider handed back: a content-block array
 * for the Messages API, a message object for chat-completions.
 */
const anthropicRaw = [
  { type: "thinking", thinking: "the user wants an echo", signature: "sig-abc" },
  { type: "tool_use", id: "call_1", name: "echo", input: { text: "hi" } },
];

const anthropicHistory: Message[] = [
  { role: "user", parts: [{ type: "text", text: "hello" }] },
  { role: "assistant", parts: [toolCall], raw: anthropicRaw },
  results,
];

const openaiHistory: Message[] = [
  { role: "user", parts: [{ type: "text", text: "hello" }] },
  {
    role: "assistant",
    parts: [toolCall],
    raw: { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
  },
  results,
];

test("the prefix picks the adapter and the rest is the model, verbatim", () => {
  assert.equal(resolve("ollama/qwen3:8b", {}).model, "qwen3:8b");
  assert.equal(resolve("groq/meta-llama/Llama-3-70b", KEYS).model, "meta-llama/Llama-3-70b");
  assert.equal(resolve("anthropic/claude-opus-4-8", KEYS).provider.name, "anthropic");
});

test("a bare model name explains what was missing", () => {
  assert.throws(() => resolve("claude-opus-4-8", KEYS), /missing a provider prefix/);
  assert.throws(() => resolve("nope/whatever", KEYS), /Unknown provider "nope"/);
});

test("a missing key names the variable to set", () => {
  assert.throws(() => resolve("anthropic/x", {}), /ANTHROPIC_API_KEY/);
  assert.doesNotThrow(() => resolve("ollama/x", {}), "local models need no key");
});

test("providers can be registered from the environment", () => {
  const env = {
    VAAN_PROVIDER_TOGETHER: "openai:https://api.together.xyz/v1/",
    TOGETHER_API_KEY: "k",
  };
  const spec = registry(env).find((entry) => entry.name === "together");
  assert.equal(spec?.shape, "openai");
  assert.equal(spec?.baseUrl, "https://api.together.xyz/v1", "trailing slash trimmed");
  assert.equal(resolve("together/mixtral", env).provider.name, "together");
});

test("a malformed provider variable fails loudly rather than being ignored", () => {
  assert.throws(() => registry({ VAAN_PROVIDER_X: "nonsense" }), /malformed/);
});

test("statuses says which keys are set", () => {
  const report = statuses({ ANTHROPIC_API_KEY: "k" });
  assert.equal(report.find((entry) => entry.name === "anthropic")?.ready, true);
  assert.equal(report.find((entry) => entry.name === "openai")?.ready, false);
  assert.equal(report.find((entry) => entry.name === "ollama")?.ready, true);
});

test("anthropic: blocks, tools and headers are in the shape the API wants", async () => {
  const stub = stubFetch({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
  try {
    const provider = anthropicProvider({ name: "anthropic", baseUrl: "https://x", apiKey: "k" });
    await provider.generate({
      model: "m",
      system: "be brief",
      messages: anthropicHistory,
      tools: [echoTool],
      maxTokens: 100,
    });

    const [sent] = stub.sent;
    assert.equal(sent?.url, "https://x/v1/messages");
    assert.equal(sent?.headers["anthropic-version"], "2023-06-01");
    assert.equal(sent?.headers["x-api-key"], "k");
    assert.equal(sent?.body.system, "be brief");
    assert.deepEqual((sent?.body.tools as unknown[])[0], {
      name: "echo",
      description: "echoes",
      input_schema: echoTool.parameters,
    });

    // GUARD 1: the assistant turn goes back as it arrived — signed thinking
    // block included. Rebuilding it from `parts` would silently drop that.
    const messages = sent?.body.messages as { role: string; content: unknown }[];
    assert.deepEqual(messages[1], { role: "assistant", content: anthropicRaw });

    // GUARD 2: both results ride in the one following message.
    assert.deepEqual(messages[2]?.content, [
      { type: "tool_result", tool_use_id: "call_1", content: "hi", is_error: false },
      { type: "tool_result", tool_use_id: "call_2", content: "nope", is_error: true },
    ]);
  } finally {
    stub.restore();
  }
});

test("anthropic: stop reasons map to what the loop does next", async () => {
  const cases: [string, string][] = [
    ["tool_use", "tool_use"],
    ["pause_turn", "pause"],
    ["max_tokens", "max_tokens"],
    ["end_turn", "done"],
    ["stop_sequence", "done"],
    ["something_invented_later", "done"],
  ];
  for (const [wire, expected] of cases) {
    const stub = stubFetch({ content: [], stop_reason: wire });
    try {
      const provider = anthropicProvider({ name: "a", baseUrl: "https://x", apiKey: "k" });
      const reply = await provider.generate({
        model: "m",
        system: "",
        messages: [],
        tools: [],
        maxTokens: 10,
      });
      assert.equal(reply.stop, expected, `${wire} should map to ${expected}`);
    } finally {
      stub.restore();
    }
  }
});

test("anthropic: a refusal with no content still says something", async () => {
  const stub = stubFetch({ content: [], stop_reason: "refusal" });
  try {
    const provider = anthropicProvider({ name: "a", baseUrl: "https://x", apiKey: "k" });
    const reply = await provider.generate({ model: "m", system: "", messages: [], tools: [], maxTokens: 10 });
    assert.equal(reply.message.parts.length, 1);
    assert.match(reply.message.parts[0]?.type === "text" ? reply.message.parts[0].text : "", /declined/);
  } finally {
    stub.restore();
  }
});

test("anthropic: thinking blocks are left out of parts but kept in raw", async () => {
  const content = [
    { type: "thinking", thinking: "hmm", signature: "sig" },
    { type: "text", text: "answer" },
  ];
  const stub = stubFetch({ content, stop_reason: "end_turn" });
  try {
    const provider = anthropicProvider({ name: "a", baseUrl: "https://x", apiKey: "k" });
    const reply = await provider.generate({ model: "m", system: "", messages: [], tools: [], maxTokens: 10 });
    assert.equal(reply.message.parts.length, 1, "thinking is opaque, not a part");
    assert.deepEqual(reply.message.raw, content, "but it survives verbatim for the next request");
  } finally {
    stub.restore();
  }
});

test("openai: tool results fan out into separate tool messages", async () => {
  const stub = stubFetch({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  });
  try {
    const provider = openaiProvider({ name: "openai", baseUrl: "https://y/v1", apiKey: "k" });
    await provider.generate({
      model: "m",
      system: "be brief",
      messages: openaiHistory,
      tools: [echoTool],
      maxTokens: 100,
    });

    const [sent] = stub.sent;
    assert.equal(sent?.url, "https://y/v1/chat/completions");
    const messages = sent?.body.messages as Record<string, unknown>[];
    assert.equal(messages[0]?.role, "system");
    // GUARD 1 again, different shape: the raw assistant turn goes back whole,
    // so its tool_calls still line up with the tool messages after it.
    assert.deepEqual(messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1" }],
    });
    // One `tool` message per result, not one user turn holding both.
    assert.equal(messages.length, 5);
    assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: "hi" });
    assert.deepEqual(messages[4], { role: "tool", tool_call_id: "call_2", content: "Error: nope" });
  } finally {
    stub.restore();
  }
});

test("a transcript from the other provider is rebuilt rather than sent as-is", async () => {
  // /model can switch provider mid-session, which replays a history whose
  // `raw` is the wrong shape entirely. Each adapter only trusts its own.
  const stub = stubFetch({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
  try {
    const provider = anthropicProvider({ name: "a", baseUrl: "https://x", apiKey: "k" });
    await provider.generate({
      model: "m",
      system: "",
      messages: openaiHistory,
      tools: [],
      maxTokens: 10,
    });
    const messages = stub.sent[0]?.body.messages as { role: string; content: unknown }[];
    assert.deepEqual(messages[1]?.content, [
      { type: "tool_use", id: "call_1", name: "echo", input: { text: "hi" } },
    ]);
  } finally {
    stub.restore();
  }
});

test("openai: tool call arguments are parsed, and bad JSON doesn't throw", async () => {
  const stub = stubFetch({
    choices: [
      {
        message: {
          tool_calls: [
            { id: "1", function: { name: "echo", arguments: '{"text":"hi"}' } },
            { id: "2", function: { name: "echo", arguments: "{not json" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  try {
    const provider = openaiProvider({ name: "openai", baseUrl: "https://y/v1", apiKey: "k" });
    const reply = await provider.generate({ model: "m", system: "", messages: [], tools: [], maxTokens: 10 });
    assert.equal(reply.stop, "tool_use");
    const [first, second] = reply.message.parts;
    assert.deepEqual(first?.type === "tool_call" ? first.input : null, { text: "hi" });
    assert.deepEqual(second?.type === "tool_call" ? second.input : null, {});
  } finally {
    stub.restore();
  }
});

test("openai: length maps to max_tokens so the loop raises the cap", async () => {
  const stub = stubFetch({ choices: [{ message: { content: "cut off" }, finish_reason: "length" }] });
  try {
    const provider = openaiProvider({ name: "openai", baseUrl: "https://y/v1", apiKey: "k" });
    const reply = await provider.generate({ model: "m", system: "", messages: [], tools: [], maxTokens: 10 });
    assert.equal(reply.stop, "max_tokens");
  } finally {
    stub.restore();
  }
});
