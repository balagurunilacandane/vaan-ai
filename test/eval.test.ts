// Graders, and the gate that decides the exit code.
//
// This is also the pattern for any test that needs the whole chain — session,
// loop, adapter — without a network or an API key: register a fake provider
// through the environment and answer its requests from a stubbed fetch.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentResult } from "../src/agent.js";
import { avoidedTools, contains, judge, matches, usedTools } from "../src/eval/graders.js";
import { gradeContext } from "./harness.js";
import { runEvals } from "../src/eval/runner.js";
import type { Suite } from "../src/eval/suites.js";

const result = (text: string, tools: string[] = []): AgentResult => ({
  text,
  messages: [],
  usedTools: tools,
  steps: 1,
});

const ctx = (agentResult: AgentResult) => gradeContext(agentResult);

test("usedTools checks the trajectory, not the prose", async () => {
  // The failure this exists to catch: right answer, tool never called.
  const looksRight = ctx(result("It is Tuesday the 3rd.", []));
  assert.equal((await usedTools("now")(looksRight)).pass, false);
  assert.match((await usedTools("now")(looksRight)).detail, /never called now/);

  const actuallyRight = ctx(result("It is Tuesday the 3rd.", ["now"]));
  assert.equal((await usedTools("now")(actuallyRight)).pass, true);
});

test("avoidedTools catches reaching for a tool it didn't need", async () => {
  assert.equal((await avoidedTools("web_search")(ctx(result("4", ["web_search"])))).pass, false);
  assert.equal((await avoidedTools("web_search")(ctx(result("4", ["now"])))).pass, true);
});

test("contains and matches are case-insensitive and regex respectively", async () => {
  assert.equal((await contains("harbour")(ctx(result("The codename is Harbour.")))).pass, true);
  assert.equal((await matches(/\b4\b/)(ctx(result("2 + 2 = 4")))).pass, true);
  assert.equal((await matches(/\b5\b/)(ctx(result("2 + 2 = 4")))).pass, false);
});

test("a judge that can't be reached fails the case rather than passing it", async () => {
  // scripted([]) throws on the first call: an unreachable judge must not be
  // read as approval.
  const grade = await judge("anything")(ctx(result("some answer")));
  assert.equal(grade.pass, false);
  assert.match(grade.detail, /judge unavailable/);
});

/** Answers every request from the fake endpoint, branching on the system prompt. */
function stubModel(answer: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { system?: string };
    const system = body.system ?? "";
    const text = system.includes("grading") ? "PASS" : system.includes("stored memory") ? "NO" : answer;
    return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const suites: Suite[] = [
  {
    name: "deterministic-demo",
    kind: "deterministic",
    threshold: 1,
    cases: [
      { name: "passes", prompt: "what is 2+2", graders: [contains("4")] },
      { name: "fails", prompt: "what day is it", graders: [usedTools("now")] },
    ],
  },
  {
    name: "judged-demo",
    kind: "judged",
    threshold: 0.5,
    cases: [
      { name: "judged pass", prompt: "explain", graders: [judge("is an explanation")] },
      { name: "judged fail", prompt: "explain", graders: [usedTools("read_file")] },
    ],
  },
];

test("the gate: deterministic suites must pass completely, judged ones clear a threshold", async () => {
  const restore = stubModel("4");
  const dir = mkdtempSync(join(tmpdir(), "vaan-eval-"));
  try {
    const report = await runEvals({
      workspace: dir,
      model: "fake/model-x",
      env: { VAAN_PROVIDER_FAKE: "anthropic:https://fake.test", FAKE_API_KEY: "k" },
      suites,
    });

    const [deterministic, judged] = report.suites;
    assert.equal(deterministic?.rate, 0.5);
    assert.equal(deterministic?.passed, false, "50% is not 100%");

    assert.equal(judged?.rate, 0.5);
    assert.equal(judged?.passed, true, "50% clears a 0.5 threshold");

    assert.equal(report.passed, false, "one failed suite fails the run");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run where everything passes reports passed", async () => {
  const restore = stubModel("4");
  const dir = mkdtempSync(join(tmpdir(), "vaan-eval-"));
  try {
    const report = await runEvals({
      workspace: dir,
      model: "fake/model-x",
      env: { VAAN_PROVIDER_FAKE: "anthropic:https://fake.test", FAKE_API_KEY: "k" },
      suites: [suites[0] as Suite].map((suite) => ({ ...suite, cases: [suite.cases[0] as never] })),
    });
    assert.equal(report.passed, true);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a case that throws is a failed case, not a crashed run", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("boom", { status: 400 })) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "vaan-eval-"));
  try {
    const report = await runEvals({
      workspace: dir,
      model: "fake/model-x",
      env: { VAAN_PROVIDER_FAKE: "anthropic:https://fake.test", FAKE_API_KEY: "k" },
      suites: [{ ...(suites[0] as Suite), cases: [suites[0]?.cases[0] as never] }],
    });
    assert.equal(report.passed, false);
    assert.match(report.suites[0]?.cases[0]?.error ?? "", /400/);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
