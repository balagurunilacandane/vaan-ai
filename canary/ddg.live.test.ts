// The canary. This is the only test in the repo that touches the network, so it
// lives outside test/ — `npm test` runs that directory and would otherwise pick
// this up and fail on an offline machine.
//
// The scheduled workflow runs it against live DuckDuckGo. When their markup
// changes, this goes red on a schedule instead of in a user's terminal.

import { strict as assert } from "node:assert";
import test from "node:test";
import { duckDuckGo } from "../src/tools/web.js";

test("the saved fixture's markup still matches live DuckDuckGo", async () => {
  const results = await duckDuckGo().search("what is an agent loop");

  assert.ok(results.length > 0, "no results parsed — the result markup has probably changed");

  const [first] = results;
  assert.ok(first, "expected at least one result");
  assert.ok(first.title.length > 0, "a result with no title means the title selector broke");
  assert.match(first.url, /^https?:\/\//, "URLs should be unwrapped out of the redirect");
  assert.doesNotMatch(first.url, /duckduckgo\.com\/l\//, "the uddg redirect is still wrapped");
  assert.doesNotMatch(first.title, /<[a-z]/i, "HTML is leaking into the title");
});
