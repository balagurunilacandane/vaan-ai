// The guards in src/agent.ts, one describe block each. These are the bugs
// that only show up against a real provider, so they get pinned here instead.

import { strict as assert } from "node:assert";
import test from "node:test";
import { runAgent, type AgentOptions } from "../src/agent.js";
import type { Message, Part, ProviderReply, Tool } from "../src/types.js";
import { PermissionDenied } from "../src/permissions/approval.js";
import { calls, says, scripted, stops, type ScriptedProvider } from "./provider.js";
import { testContext, testTool as tool } from "./harness.js";

const ctx = testContext();

const echo = tool("echo", (input) => `echo ${JSON.stringify(input)}`);
const boom = tool("boom", () => {
  throw new Error("kaboom");
});
const slow = tool("slow", async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return "slow done";
});

function run(replies: ProviderReply[], tools: Tool[] = [echo], extra: Partial<AgentOptions> = {}) {
  const provider: ScriptedProvider = scripted(replies);
  const options: AgentOptions = {
    provider,
    model: "test",
    system: "system",
    tools,
    ctx,
    ...extra,
  };
  return { provider, result: runAgent("hello", options) };
}

const resultParts = (message: Message | undefined): Part[] => message?.parts ?? [];

test("no tool calls means that's the answer", async () => {
  const { result } = run([says("42")]);
  assert.equal((await result).text, "42");
});

test("GUARD 1: the provider's own message goes back untouched", async () => {
  const { provider, result } = run([calls({ id: "a1", name: "echo" }), says("done")]);
  await result;

  const secondRequest = provider.requests[1];
  assert.ok(secondRequest, "expected a second request");
  const echoed = secondRequest.messages[1];
  assert.equal(echoed?.role, "assistant");
  // `raw` stands in for a signed thinking block. Rebuilding the turn from
  // `parts` would drop it and the real API would reject the next request.
  assert.deepEqual(echoed?.raw, { opaque: "reasoning", ids: ["a1"] });
});

test("GUARD 2: parallel calls all run, and return in one message keyed by id", async () => {
  const { provider, result } = run(
    [calls({ id: "a", name: "echo" }, { id: "b", name: "slow" }, { id: "c", name: "echo" }), says("ok")],
    [echo, slow],
  );
  await result;

  const followUp = provider.requests[1]?.messages[2];
  assert.equal(followUp?.role, "user", "results must be a single user message, not several");
  const parts = resultParts(followUp);
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((part) => (part.type === "tool_result" ? part.id : undefined)),
    ["a", "b", "c"],
    "each result must carry the id of the call it answers",
  );
});

test("GUARD 3: a throwing tool becomes a flagged result, not a crash", async () => {
  const { provider, result } = run([calls({ id: "x", name: "boom" }), says("recovered")], [boom]);
  assert.equal((await result).text, "recovered");

  const part = resultParts(provider.requests[1]?.messages[2])[0];
  assert.equal(part?.type, "tool_result");
  assert.equal(part.type === "tool_result" && part.isError, true);
  assert.match(part.type === "tool_result" ? part.output : "", /kaboom/);
});

test("GUARD 3: an unknown tool is reported back rather than thrown", async () => {
  const { provider, result } = run([calls({ id: "x", name: "nope" }), says("ok")]);
  await result;

  const part = resultParts(provider.requests[1]?.messages[2])[0];
  assert.equal(part?.type === "tool_result" && part.isError, true);
  assert.match(part?.type === "tool_result" ? part.output : "", /No tool named "nope"/);
});

test("GUARD 4a: hitting the cap raises it and resends the same history", async () => {
  const { provider, result } = run([stops("max_tokens", "half a sen"), says("whole answer")]);
  assert.equal((await result).text, "whole answer");

  const [first, second] = provider.requests;
  assert.ok(first && second);
  assert.equal(second.maxTokens, first.maxTokens * 2, "the cap should go up");
  assert.equal(second.messages.length, 1, "the truncated turn must not be kept");
});

test("GUARD 4a: the cap is only raised once, so a stuck model still terminates", async () => {
  const { provider, result } = run([
    stops("max_tokens", "first half"),
    stops("max_tokens", "second half"),
    says("never reached"),
  ]);
  const { text } = await result;
  // A model that truncates no matter how much room it gets would otherwise
  // double the budget forever. One retry, then take what it managed to say.
  assert.equal(provider.requests.length, 2, "one retry, not an endless doubling");
  assert.equal(text, "second half");
});

test("GUARD 4b: pause resends the history as-is, including the paused turn", async () => {
  const { provider, result } = run([stops("pause"), says("resumed")]);
  assert.equal((await result).text, "resumed");

  const second = provider.requests[1];
  assert.equal(second?.messages.length, 2, "the paused assistant turn stays in the history");
  assert.equal(second?.messages[1]?.role, "assistant");
});

test("GUARD 5: a refused permission comes back as an answer, not a crash", async () => {
  const refused = tool("guarded", () => {
    throw new PermissionDenied(
      { tool: "guarded", capability: "write", target: "/work/app.ts" },
      "changing a file in the workspace",
    );
  });
  const { provider, result } = run(
    [calls({ id: "x", name: "guarded" }), says("I couldn't, and here's why")],
    [refused],
  );
  assert.equal((await result).text, "I couldn't, and here's why");

  const part = resultParts(provider.requests[1]?.messages[2])[0];
  assert.equal(part?.type === "tool_result" && part.isError, true);
  const output = part?.type === "tool_result" ? part.output : "";
  assert.match(output, /Not permitted/);
  // The wording matters as much as the flag: a model that reads this as a
  // transient error will retry, and one that reads it as a closed door will
  // say so instead.
  assert.match(output, /don't retry this or\s+look for another way/);
});

test("maxSteps stops a runaway loop", async () => {
  const { result } = run(
    [calls({ id: "1", name: "echo" }), calls({ id: "2", name: "echo" }), calls({ id: "3", name: "echo" })],
    [echo],
    { maxSteps: 3 },
  );
  assert.match((await result).text, /Stopped after 3 steps/);
});

test("usedTools records the trajectory, failures included", async () => {
  const { result } = run(
    [calls({ id: "a", name: "echo" }, { id: "b", name: "boom" }), says("done")],
    [echo, boom],
  );
  assert.deepEqual((await result).usedTools, ["echo", "boom"]);
});

test("events are emitted for text and for every tool call", async () => {
  const seen: string[] = [];
  const { result } = run([calls({ id: "a", name: "echo" }), says("done")], [echo], {
    onEvent: (event) => seen.push(event.type),
  });
  await result;
  assert.deepEqual(seen, ["tool_call", "tool_result", "text"]);
});
