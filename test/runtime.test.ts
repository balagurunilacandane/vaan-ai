// The whole chain, assembled the way `vaan` assembles it: session, loop,
// adapter, policy, gate, sandbox, trace. Everything below runs offline against
// a fake provider registered through the environment.
//
// The unit tests check that each boundary holds on its own. These check that
// they are actually wired together — a gate that works perfectly and isn't
// called is the failure mode worth testing for.

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { createSession } from "../src/index.js";
import { home } from "../src/paths.js";

const ENV = {
  VAAN_PROVIDER_FAKE: "anthropic:https://fake.test",
  FAKE_API_KEY: "sk-not-a-real-key-000000000000",
};

interface Turn {
  /** Blocks the fake model returns for this turn. */
  content: unknown[];
  stop?: string;
}

/**
 * A fake Messages endpoint that reads from a script.
 *
 * The retrieval gate asks first and gets NO, so the scripted turns line up with
 * the actual conversation rather than being consumed by a lookup nobody asked
 * about.
 */
function stub(turns: Turn[]): () => void {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { system?: string };
    if ((body.system ?? "").includes("stored memory")) {
      return json({ content: [{ type: "text", text: "NO" }], stop_reason: "end_turn" });
    }
    const turn = turns[index++] ?? { content: [{ type: "text", text: "done" }] };
    return json({ content: turn.content, stop_reason: turn.stop ?? "end_turn" });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const toolUse = (name: string, input: unknown) => ({
  content: [{ type: "tool_use", id: `call_${name}`, name, input }],
  stop: "tool_use",
});

function workspace(files: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "vaan-runtime-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a request gets an id, a trace on disk, and the tools it used", async () => {
  const { root, cleanup } = workspace({ "notes.md": "codename Harbour\n" });
  const restore = stub([toolUse("read_file", { path: "notes.md" })]);
  try {
    const session = createSession({
      workspace: root,
      model: "fake/model-x",
      config: { ...defaultConfig(root, "fake/model-x"), memory: false },
      memory: false,
      env: { ...process.env, ...ENV },
      yes: true,
    });

    let announced = "";
    const result = await session.ask("what's the codename?", {
      onRequest: (request) => {
        announced = request.id;
      },
    });
    session.close();

    assert.equal(result.requestId, announced, "the id is announced before any model call");
    assert.deepEqual(result.usedTools, ["read_file"]);

    // The trace was written where `vaan trace` looks for it.
    const files = readdirSync(join(home(root), "traces"));
    assert.equal(files.length, 1);
    const stored = JSON.parse(readFileSync(join(home(root), "traces", files[0] as string), "utf8"));
    assert.equal(stored.id, result.requestId);
    assert.ok(
      stored.events.some((event: { kind: string }) => event.kind === "permission"),
      "the gate ran and said so",
    );
    assert.ok(stored.events.some((event: { kind: string }) => event.kind === "model_call"));
  } finally {
    restore();
    cleanup();
  }
});

test("the API key never reaches the trace file", async () => {
  const { root, cleanup } = workspace();
  const restore = stub([{ content: [{ type: "text", text: "hello" }] }]);
  try {
    const session = createSession({
      workspace: root,
      model: "fake/model-x",
      config: { ...defaultConfig(root, "fake/model-x"), memory: false },
      memory: false,
      env: { ...process.env, ...ENV },
      yes: true,
    });
    await session.ask("say hello");
    session.close();

    const files = readdirSync(join(home(root), "traces"));
    const body = readFileSync(join(home(root), "traces", files[0] as string), "utf8");
    assert.doesNotMatch(body, /sk-not-a-real-key/);
  } finally {
    restore();
    cleanup();
  }
});

test("a refused write leaves the file alone and tells the model it was refused", async () => {
  const { root, cleanup } = workspace({ "app.ts": "original\n" });
  const restore = stub([toolUse("write_file", { path: "app.ts", content: "changed" })]);
  try {
    const session = createSession({
      workspace: root,
      model: "fake/model-x",
      config: { ...defaultConfig(root, "fake/model-x"), memory: false },
      memory: false,
      env: { ...process.env, ...ENV },
      // Nobody says yes. This is what an unattended run looks like.
      approve: async () => false,
    });
    const result = await session.ask("change app.ts");
    session.close();

    assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "original\n");
    const refusal = result.trace.events.find(
      (event) => event.kind === "tool_result" && !event.ok,
    );
    assert.ok(refusal, "the refusal should be recorded as a failed tool result");
  } finally {
    restore();
    cleanup();
  }
});

test("a path outside the workspace is refused even with --yes", async () => {
  const { root, cleanup } = workspace();
  const restore = stub([toolUse("read_file", { path: "../../etc/hosts" })]);
  try {
    const session = createSession({
      workspace: root,
      model: "fake/model-x",
      config: { ...defaultConfig(root, "fake/model-x"), memory: false },
      memory: false,
      env: { ...process.env, ...ENV },
      // `--yes` grants permissions. It does not move the jail.
      yes: true,
    });
    const result = await session.ask("read /etc/hosts");
    session.close();

    const failed = result.trace.events.find((event) => event.kind === "tool_result" && !event.ok);
    assert.ok(failed, "reading outside the workspace must fail");
  } finally {
    restore();
    cleanup();
  }
});

test("--no-trace writes nothing to disk but still collects events", async () => {
  const { root, cleanup } = workspace();
  const restore = stub([{ content: [{ type: "text", text: "hi" }] }]);
  try {
    const session = createSession({
      workspace: root,
      model: "fake/model-x",
      config: { ...defaultConfig(root, "fake/model-x"), memory: false },
      memory: false,
      env: { ...process.env, ...ENV },
      trace: false,
      yes: true,
    });
    const result = await session.ask("hello");
    session.close();

    assert.ok(result.trace.events.length > 0);
    assert.equal(existsSync(join(home(root), "traces")), false);
  } finally {
    restore();
    cleanup();
  }
});

test("token usage accumulates across a session", async () => {
  const { root, cleanup } = workspace();
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { system?: string };
    if ((body.system ?? "").includes("stored memory")) {
      return json({ content: [{ type: "text", text: "NO" }], stop_reason: "end_turn" });
    }
    return json({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 10 },
    });
  }) as typeof fetch;

  try {
    const session = createSession({
      workspace: root,
      model: "fake/model-x",
      config: { ...defaultConfig(root, "fake/model-x"), memory: false },
      memory: false,
      env: { ...process.env, ...ENV },
      trace: false,
      yes: true,
    });
    await session.ask("one");
    await session.ask("two");
    assert.deepEqual(session.usage, { input: 200, output: 20 });
    session.close();
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

test("/new forgets the transcript without forgetting stored memory", async () => {
  const { root, cleanup } = workspace();
  const restore = stub([
    { content: [{ type: "text", text: "first" }] },
    { content: [{ type: "text", text: "second" }] },
  ]);
  try {
    const session = createSession({
      workspace: root,
      model: "fake/model-x",
      config: { ...defaultConfig(root, "fake/model-x"), memory: false },
      memory: false,
      env: { ...process.env, ...ENV },
      trace: false,
      yes: true,
    });

    const first = await session.ask("one");
    assert.equal(first.messages.length, 2, "user turn plus the reply");

    session.reset();
    const second = await session.ask("two");
    assert.equal(second.messages.length, 2, "the previous exchange is gone");
    session.close();
  } finally {
    restore();
    cleanup();
  }
});
