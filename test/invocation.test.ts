// Telling someone to run `vaan init` when `vaan` isn't on their PATH is the
// first thing a new user hits after `npx vaan-ai`. These pin the detection.

import { strict as assert } from "node:assert";
import { join } from "node:path";
import test from "node:test";
import { INSTALL_HINT, launchCommand, viaNpx } from "../src/invocation.js";

const npxScript = join("/Users/me/.npm/_npx/2f3a1b/node_modules/.bin", "vaan");
const globalScript = "/usr/local/lib/node_modules/vaan-ai/dist/src/cli/main.js";

test("a bin resolved out of the npx cache is recognised as npx", () => {
  assert.equal(viaNpx(["node", npxScript], {}), true);
  assert.equal(launchCommand(["node", npxScript], {}), "npx vaan-ai");
});

test("npm exec is recognised even when the path doesn't say so", () => {
  assert.equal(viaNpx(["node", "/somewhere/else/vaan"], { npm_command: "exec" }), true);
});

test("a global or linked install reports the bare command", () => {
  assert.equal(viaNpx(["node", globalScript], {}), false);
  assert.equal(launchCommand(["node", globalScript], {}), "vaan");
  // `npm run` sets npm_command too, but to something other than exec.
  assert.equal(viaNpx(["node", globalScript], { npm_command: "run-script" }), false);
});

test("a missing argv entry doesn't throw", () => {
  assert.equal(viaNpx(["node"], {}), false);
  assert.equal(launchCommand([], {}), "vaan");
});

test("the install hint names the package, not the command", () => {
  // `npm install -g vaan` would install someone else's package.
  assert.match(INSTALL_HINT, /npm install -g vaan-ai/);
});
