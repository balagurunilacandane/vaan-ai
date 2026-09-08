// Traces are written to disk and read back later, which makes redaction the
// interesting part: a key that reaches a trace file has leaked into something
// people copy into bug reports. Everything else here is a round-trip check.

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redact, redactText, REDACTED } from "../src/observability/events.js";
import { newRequest, shortId } from "../src/observability/request.js";
import { listTraces, openTrace, readTrace } from "../src/observability/trace.js";

const scratch = (): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "vaan-trace-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("keys are redacted by the name of the field they're in", () => {
  const redacted = redact({
    model: "claude-opus-5",
    api_key: "whatever-this-is",
    nested: { Authorization: "Bearer abc", password: "hunter2" },
  }) as Record<string, unknown>;

  assert.equal(redacted.model, "claude-opus-5");
  assert.equal(redacted.api_key, REDACTED);
  const nested = redacted.nested as Record<string, unknown>;
  assert.equal(nested.Authorization, REDACTED);
  assert.equal(nested.password, REDACTED);
});

test("keys are redacted by shape even in a field nobody flagged", () => {
  // The realistic case: a model repeats a key back inside ordinary prose.
  const text = redactText("I found sk-ant-api03-abcdefghijklmnopqrstuvwxyz in the config");
  assert.doesNotMatch(text, /sk-ant/);
  assert.match(text, /\[redacted\]/);

  assert.doesNotMatch(redactText("token ghp_abcdefghijklmnopqrstuvwxyz0123"), /ghp_/);
  assert.doesNotMatch(redactText("AKIAIOSFODNN7EXAMPLE"), /AKIA/);
  assert.doesNotMatch(redactText("Authorization: Bearer eyJhbGciOi.abcdefghij.klmnopqrst"), /eyJhbG/);
});

test("ordinary text survives redaction unchanged", () => {
  const text = "The task is to fix the login handler in src/auth/login.ts";
  assert.equal(redactText(text), text);
});

test("a cycle is cut rather than followed", () => {
  const looped: Record<string, unknown> = { name: "x" };
  looped.self = looped;
  const redacted = redact(looped) as Record<string, unknown>;
  assert.equal(redacted.self, "[circular]");
});

test("a trace round-trips to disk and back, findable by id prefix", () => {
  const { dir, cleanup } = scratch();
  try {
    const request = newRequest("fix the login handler", "anthropic/claude-opus-5", dir);
    const trace = openTrace({ home: dir, request });
    trace.record({ kind: "tool_call", tool: "read_file", input: { path: "src/auth/login.ts" } });
    trace.record({ kind: "tool_result", tool: "read_file", ok: true, summary: "read 40 lines" });
    trace.record({
      kind: "permission",
      tool: "write_file",
      capability: "write",
      target: "src/auth/login.ts",
      decision: "allow",
      reason: "approved by user",
    });
    trace.finish(true, "done");

    const found = readTrace(dir, shortId(request.id));
    assert.ok(found, "a trace should be findable by the id prefix people type");
    assert.equal(found.id, request.id);
    assert.equal(found.ok, true);
    // request + three recorded + result
    assert.equal(found.events.length, 5);
    assert.equal(found.events[0]?.kind, "request");
    assert.equal(found.events.at(-1)?.kind, "result");

    const listed = listTraces(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, request.id);
  } finally {
    cleanup();
  }
});

test("a secret in a tool input never reaches the file on disk", () => {
  const { dir, cleanup } = scratch();
  try {
    const request = newRequest("write the config", "test/model", dir);
    const trace = openTrace({ home: dir, request });
    trace.record({
      kind: "tool_call",
      tool: "write_file",
      input: { path: ".env", api_key: "sk-ant-secret-value-here-0123456789" },
    });
    trace.finish(true, "wrote it");

    const files = readdirSync(join(dir, "traces"));
    const body = readFileSync(join(dir, "traces", files[0] as string), "utf8");
    assert.doesNotMatch(body, /sk-ant-secret/);
    assert.match(body, /redacted/);
  } finally {
    cleanup();
  }
});

test("persist: false collects events without writing anything", () => {
  const { dir, cleanup } = scratch();
  try {
    const request = newRequest("no disk", "test/model", dir);
    const trace = openTrace({ home: dir, request, persist: false });
    trace.record({ kind: "tool_call", tool: "now", input: {} });
    const stored = trace.finish(true, "ok");

    // The graders read these in memory, so they still have to be there.
    assert.equal(stored.events.length, 3);
    assert.equal(listTraces(dir).length, 0, "nothing should have been written");
  } finally {
    cleanup();
  }
});

test("finishing twice does not append a second result event", () => {
  const { dir, cleanup } = scratch();
  try {
    const request = newRequest("x", "test/model", dir);
    const trace = openTrace({ home: dir, request, persist: false });
    const first = trace.finish(true, "done");
    const second = trace.finish(true, "done");
    assert.equal(first.events.length, second.events.length);
  } finally {
    cleanup();
  }
});
