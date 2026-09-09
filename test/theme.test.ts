// The terminal is the whole product surface, so what it prints is worth
// pinning. The rule these enforce: colour is decoration on a line that already
// reads correctly without it.

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  clip,
  createTheme,
  describeInput,
  duration,
  summariseOutput,
  tokens,
} from "../src/cli/theme.js";
import { diff, diffStat } from "../src/tools/files.js";

test("colour is off when there's no terminal to colour", () => {
  const plain = createTheme({ isTTY: false, env: {} });
  assert.equal(plain.enabled, false);
  assert.equal(plain.lime("read_file"), "read_file", "text must survive unchanged");
});

test("NO_COLOR wins over a terminal, whatever its value", () => {
  // The convention is that the variable being *set* is the signal.
  assert.equal(createTheme({ isTTY: true, env: { NO_COLOR: "" } }).enabled, false);
  assert.equal(createTheme({ isTTY: true, env: { NO_COLOR: "0" } }).enabled, false);
  assert.equal(createTheme({ isTTY: true, env: { TERM: "dumb" } }).enabled, false);
  assert.equal(createTheme({ isTTY: true, env: {} }).enabled, true);
});

test("colour wraps the text rather than replacing it", () => {
  const colour = createTheme({ isTTY: true, env: {} });
  const painted = colour.lime("edit_file");
  assert.match(painted, /edit_file/, "the word still has to be in there");
  assert.notEqual(painted, "edit_file");
});

test("durations read at the magnitude they land in", () => {
  assert.equal(duration(1), "1ms");
  assert.equal(duration(340), "340ms");
  assert.equal(duration(1000), "1.0s");
  assert.equal(duration(18421), "18.4s");
});

test("token counts stay short enough for a status line", () => {
  assert.equal(tokens(0), "0");
  assert.equal(tokens(940), "940");
  assert.equal(tokens(12400), "12.4k");
});

test("a tool call is summarised by its most telling argument", () => {
  assert.equal(describeInput({ path: "src/auth/login.ts" }), "src/auth/login.ts");
  assert.equal(describeInput({ query: "redis" }), "redis");
  assert.equal(describeInput({ command: "npm test" }), "npm test");
  // path wins over a less specific sibling, whatever order the keys arrive in.
  assert.equal(describeInput({ query: "x", path: "a.ts" }), "a.ts");
  assert.equal(describeInput({}), "");
  assert.equal(describeInput(null), "");
});

test("short output speaks for itself; long output gets counted", () => {
  assert.equal(summariseOutput("Wrote notes.md (3 lines)."), "Wrote notes.md (3 lines).");
  assert.equal(summariseOutput("a\nb\nc\nd"), "4 lines");
  assert.equal(summariseOutput("   "), "no output");
});

test("clip never returns more than it was asked for", () => {
  assert.equal(clip("short", 20), "short");
  assert.equal(clip("a".repeat(50), 10).length, 10);
  assert.match(clip("a".repeat(50), 10), /…$/);
});

test("the diff stat counts the same lines the diff shows", () => {
  const before = "one\ntwo\nthree\nfour\n";
  const after = "one\nTWO\nTHREE\nfour\n";

  const stat = diffStat(before, after);
  const rendered = diff(before, after);

  // The prompt says "- 2  + 2"; the diff behind [d] must not disagree.
  assert.equal(stat.removed, rendered.split("\n").filter((l) => l.startsWith("- ")).length);
  assert.equal(stat.added, rendered.split("\n").filter((l) => l.startsWith("+ ")).length);
  assert.deepEqual(stat, { added: 2, removed: 2 });
});

test("creating a file counts as all additions and no removals", () => {
  assert.deepEqual(diffStat("", "a\nb\n"), { added: 2, removed: 0 });
});

test("only the accent is an absolute colour", () => {
  // The regression this guards: fixed greys and a fixed near-white are legible
  // on a dark terminal and invisible on a light one. Emphasis has to be an
  // attribute, which the terminal renders relative to its own foreground.
  const t = createTheme({ isTTY: true, env: {} });
  const escapes = (text: string): string[] => [...text.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1] ?? "");

  assert.deepEqual(escapes(t.bright("x")).slice(0, 1), ["1"], "bright must be bold");
  assert.deepEqual(escapes(t.dim("x")).slice(0, 1), ["2"], "dim must be the dim attribute");
  assert.deepEqual(escapes(t.faint("x")).slice(0, 1), ["2"], "faint must be the dim attribute");

  for (const paint of [t.bright, t.dim, t.faint, t.bold]) {
    assert.doesNotMatch(paint("x"), /38;5;/, "no fixed colour on text you have to read");
  }
  assert.match(t.lime("x"), /38;5;149/, "the accent stays the brand colour");
});
