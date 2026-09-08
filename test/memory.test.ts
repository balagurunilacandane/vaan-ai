// The same contract run against both Memory implementations. That's the whole
// point of keeping the in-memory one: if a change only makes sense for SQLite,
// this file stops compiling or stops passing.

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Memory } from "../src/memory/index.js";
import { openMemory } from "../src/memory/store.js";
import { toMatchQuery } from "../src/memory/search.js";
import { inMemoryStore } from "./store.js";

interface Harness {
  memory: Memory;
  cleanup: () => void;
}

const implementations: [string, () => Harness][] = [
  ["in-memory", () => ({ memory: inMemoryStore(), cleanup: () => {} })],
  [
    "sqlite",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "vaan-"));
      const memory = openMemory({ dir });
      return {
        memory,
        cleanup: () => {
          memory.close?.();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

for (const [name, make] of implementations) {
  test(`${name}: facts round-trip`, async () => {
    const { memory, cleanup } = make();
    try {
      await memory.remember("p", { kind: "fact", text: "Allergic to prawns." });
      const { facts } = await memory.recall("p", "");
      assert.equal(facts.length, 1);
      assert.equal(facts[0]?.text, "Allergic to prawns.");
    } finally {
      cleanup();
    }
  });

  test(`${name}: the same fact twice is stored once`, async () => {
    const { memory, cleanup } = make();
    try {
      await memory.remember("p", { kind: "fact", text: "Lives in Chennai." });
      await memory.remember("p", { kind: "fact", text: "Lives in Chennai." });
      assert.equal((await memory.recall("p", "")).facts.length, 1);
    } finally {
      cleanup();
    }
  });

  test(`${name}: forget removes a fact by id`, async () => {
    const { memory, cleanup } = make();
    try {
      await memory.remember("p", { kind: "fact", text: "Drinks filter coffee." });
      const [fact] = (await memory.recall("p", "")).facts;
      assert.equal(await memory.forget("p", fact?.id ?? -1), 1);
      assert.equal((await memory.recall("p", "")).facts.length, 0);
      assert.equal(await memory.forget("p", 9999), 0, "forgetting nothing is not an error");
    } finally {
      cleanup();
    }
  });

  test(`${name}: scopes don't leak into each other`, async () => {
    const { memory, cleanup } = make();
    try {
      await memory.remember("one", { kind: "fact", text: "Only in one." });
      await memory.remember("two", { kind: "fact", text: "Only in two." });
      assert.equal((await memory.recall("one", "")).facts.length, 1);
      assert.equal((await memory.recall("one", "")).facts[0]?.text, "Only in one.");
    } finally {
      cleanup();
    }
  });

  test(`${name}: turns come back when the query matches`, async () => {
    const { memory, cleanup } = make();
    try {
      await memory.remember("p", {
        kind: "turn",
        userText: "When am I seeing Alex?",
        replyText: "Thursday at the harbour cafe.",
        tools: ["now"],
      });
      await memory.remember("p", {
        kind: "turn",
        userText: "Convert 30 celsius to fahrenheit",
        replyText: "86",
        tools: [],
      });

      const hit = await memory.recall("p", "what did I say about Alex");
      assert.equal(hit.turns.length, 1);
      assert.match(hit.turns[0]?.replyText ?? "", /harbour/);
      assert.deepEqual(hit.turns[0]?.tools, ["now"]);
    } finally {
      cleanup();
    }
  });

  test(`${name}: an empty query returns recent turns instead of searching`, async () => {
    const { memory, cleanup } = make();
    try {
      await memory.remember("p", { kind: "turn", userText: "a", replyText: "b", tools: [] });
      assert.equal((await memory.recall("p", "")).turns.length, 1);
    } finally {
      cleanup();
    }
  });
}

test("sqlite: MEMORY.md mirrors the facts table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vaan-"));
  const memory = openMemory({ dir });
  try {
    await memory.remember(dir, { kind: "fact", text: "Allergic to prawns." });
    const mirror = join(dir, ".vaan", "memory", "MEMORY.md");
    assert.ok(existsSync(mirror));
    assert.match(readFileSync(mirror, "utf8"), /Allergic to prawns\./);

    const [fact] = (await memory.recall(dir, "")).facts;
    await memory.forget(dir, fact?.id ?? -1);
    assert.match(readFileSync(mirror, "utf8"), /Nothing remembered yet/);
  } finally {
    memory.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite: a broken store degrades to no memory instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vaan-"));
  const memory = openMemory({ dir });
  memory.close?.();
  try {
    // Every statement now fails. The agent must still be able to answer.
    assert.deepEqual(await memory.recall(dir, "anything"), { facts: [], turns: [] });
    await memory.remember(dir, { kind: "fact", text: "still fine" });
    assert.equal(await memory.forget(dir, 1), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FTS5 query building survives punctuation that would be syntax", async () => {
  // Raw user text in a MATCH expression is a syntax error waiting to happen:
  // quotes, AND/OR, and * all mean something to FTS5.
  assert.equal(toMatchQuery(`"drop" AND table*`), '"drop" OR "table"');
  assert.equal(toMatchQuery("what is 2 + 2"), undefined, "stopwords only means no search");
  assert.equal(toMatchQuery("café Ångström"), '"café" OR "ångström"');
});
