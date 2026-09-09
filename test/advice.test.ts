// A provider's error says what is wrong and never what to do about it. These
// pin the translation, because the failure they cover is one a first-time user
// hits before Vaan has done anything useful at all.

import { strict as assert } from "node:assert";
import test from "node:test";
import { advice } from "../src/cli/wizard.js";
import { build } from "../src/providers/index.js";

const WORKSPACE_ERROR =
  'api.anthropic.com returned 400: {"type":"error","error":{"type":' +
  '"invalid_request_error","message":"This API key is not scoped to a workspace, so ' +
  'this request must include the anthropic-workspace-id header with the ID of the ' +
  'workspace to use. Add the header, or use an API key that is scoped to a workspace."}}';

test("an org-scoped key is explained, with both ways out", () => {
  const hint = advice(WORKSPACE_ERROR) ?? "";
  assert.match(hint, /console\.anthropic\.com/, "says where to make a workspace key");
  assert.match(hint, /ANTHROPIC_WORKSPACE_ID/, "names the variable that fixes it in place");
});

test("the other failures people actually hit are covered", () => {
  assert.match(advice("returned 401: invalid x-api-key") ?? "", /rejected/);
  assert.match(advice("Your credit balance is too low") ?? "", /credit/);
  assert.match(advice("fetch failed ECONNREFUSED") ?? "", /Nothing answered/);
});

test("an unrecognised failure gets no invented advice", () => {
  assert.equal(advice("returned 500: something we have never seen"), undefined);
});

test("the workspace id is sent as a header when it is configured", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_01abc",
  };
  // Built without throwing is most of it; the header itself is asserted by
  // the fetch stub below.
  const provider = build(
    { name: "anthropic", shape: "anthropic", baseUrl: "https://fake.test", envKey: "ANTHROPIC_API_KEY" },
    env,
  );
  assert.equal(provider.name, "anthropic");
});

test("the header reaches the request", async () => {
  const original = globalThis.fetch;
  let sent: Record<string, string> = {};
  globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    sent = (init.headers ?? {}) as Record<string, string>;
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const provider = build(
      {
        name: "anthropic",
        shape: "anthropic",
        baseUrl: "https://fake.test",
        envKey: "ANTHROPIC_API_KEY",
      },
      { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_WORKSPACE_ID: "wrkspc_01abc" },
    );
    await provider.generate({
      model: "m",
      system: "",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 8,
    });
    assert.equal(sent["anthropic-workspace-id"], "wrkspc_01abc");
  } finally {
    globalThis.fetch = original;
  }
});

test("no workspace id means no header, rather than an empty one", async () => {
  const original = globalThis.fetch;
  let sent: Record<string, string> = {};
  globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    sent = (init.headers ?? {}) as Record<string, string>;
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const provider = build(
      {
        name: "anthropic",
        shape: "anthropic",
        baseUrl: "https://fake.test",
        envKey: "ANTHROPIC_API_KEY",
      },
      { ANTHROPIC_API_KEY: "sk-ant-test" },
    );
    await provider.generate({
      model: "m",
      system: "",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 8,
    });
    assert.equal("anthropic-workspace-id" in sent, false);
  } finally {
    globalThis.fetch = original;
  }
});
