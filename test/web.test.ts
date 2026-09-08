// The keyless search path reads an HTML page that nobody promised us. These
// tests run against a saved copy: when they start failing after a DuckDuckGo
// markup change, that's the signal to fix the regexes — before users hit it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { duckDuckGo, parseDuckDuckGo, webSearch, type SearchProvider } from "../src/tools/web.js";
import type { ToolContext } from "../src/types.js";
import { testContext } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "..", "..", "test", "fixtures", "duckduckgo.html"), "utf8");

const ctx: ToolContext = testContext({ confirm: false });

test("parses titles, URLs and snippets out of the results page", () => {
  const results = parseDuckDuckGo(fixture);
  assert.equal(results.length, 3);

  const [first] = results;
  assert.equal(first?.title, "Building an agent loop from scratch", "tags stripped from the title");
  assert.equal(first?.url, "https://example.com/agent-loop", "redirect unwrapped");
  assert.match(first?.snippet ?? "", /^An agent is a loop/);
  assert.match(first?.snippet ?? "", /results & go again/, "entities decoded");
});

test("handles entities in titles and plain (non-redirect) links", () => {
  const results = parseDuckDuckGo(fixture);
  assert.equal(results[1]?.title, 'Tool use & the "stop reason"');
  assert.equal(results[2]?.url, "https://direct.example.net/loops");
});

test("a page with no results is reported as maybe-throttled, not as nothing found", async () => {
  const tool = webSearch(duckDuckGo(async () => "<html><body>no results here</body></html>"));
  const output = await tool.run({ query: "anything" }, ctx);
  assert.match(output, /throttl/i);
  assert.doesNotMatch(output, /no results found/i);
});

test("a failing backend returns a tool result, never an exception", async () => {
  const broken: SearchProvider = {
    name: "Test",
    search: async () => {
      throw new Error("connection reset");
    },
  };
  const output = await webSearch(broken).run({ query: "anything" }, ctx);
  assert.match(output, /search unavailable/);
  assert.match(output, /connection reset/);
});

test("results are formatted with the URL on its own line", async () => {
  const tool = webSearch(duckDuckGo(async () => fixture));
  const output = await tool.run({ query: "agent loop" }, ctx);
  assert.match(output, /1\. Building an agent loop from scratch\n {3}https:\/\/example\.com\/agent-loop/);
});

test("an empty query doesn't reach the network at all", async () => {
  let called = false;
  const tool = webSearch(duckDuckGo(async () => ((called = true), fixture)));
  assert.match(await tool.run({ query: "   " }, ctx), /No query/);
  assert.equal(called, false);
});
