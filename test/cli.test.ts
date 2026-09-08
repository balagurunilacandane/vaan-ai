// Argument parsing, and the .env reader.
//
// The first test here is a regression: `vaan memory` used to be parsed as
// `vaan`, fall through to the REPL, hit the not-a-terminal check and exit.
// Every subcommand was broken and nothing caught it, because the parsing was
// inline in main().

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli/args.js";
import { loadEnv, parseEnv, updateEnvFile } from "../src/cli/dotenv.js";

test("a subcommand with no flags is still the subcommand", () => {
  for (const command of ["memory", "eval", "init"]) {
    assert.equal(parseArgs([command]).command, command);
  }
});

test("bare vaan is the REPL", () => {
  assert.equal(parseArgs([]).command, "repl");
  assert.equal(parseArgs(["--no-memory"]).command, "repl");
});

test("the value after --model is not mistaken for the command", () => {
  assert.deepEqual(parseArgs(["--model", "anthropic/claude-opus-5"]), {
    command: "repl",
    rest: [],
    model: "anthropic/claude-opus-5",
    yes: false,
    memory: true,
    trace: true,
    help: false,
    version: false,
  });

  const withCommand = parseArgs(["eval", "--model", "openai/gpt-5"]);
  assert.equal(withCommand.command, "eval");
  assert.equal(withCommand.model, "openai/gpt-5");

  // …in either order.
  const flagFirst = parseArgs(["--model", "openai/gpt-5", "eval"]);
  assert.equal(flagFirst.command, "eval");
  assert.equal(flagFirst.model, "openai/gpt-5");
});

test("a command that happens to equal the model string still parses", () => {
  // Comparing by value rather than position would drop this command.
  const args = parseArgs(["--model", "eval", "eval"]);
  assert.equal(args.model, "eval");
  assert.equal(args.command, "eval");
});

test("flags are recognised in long and short form", () => {
  assert.equal(parseArgs(["-y"]).yes, true);
  assert.equal(parseArgs(["--yes"]).yes, true);
  assert.equal(parseArgs([]).yes, false);
  assert.equal(parseArgs(["--no-memory"]).memory, false);
  assert.equal(parseArgs([]).memory, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["help"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test(".env parsing handles quotes, comments and blank lines", () => {
  const parsed = parseEnv(
    ['# a comment', '', 'VAAN_MODEL=anthropic/claude-opus-5', 'QUOTED="sk-with=equals"', "SINGLE='x'", 'BARE = spaced'].join("\n"),
  );
  assert.equal(parsed.VAAN_MODEL, "anthropic/claude-opus-5");
  assert.equal(parsed.QUOTED, "sk-with=equals", "only the first = splits");
  assert.equal(parsed.SINGLE, "x");
  assert.equal(parsed.BARE, "spaced");
  assert.equal(Object.keys(parsed).length, 4, "comments and blanks contribute nothing");
});

test("the real environment beats a stale .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaan-env-"));
  try {
    writeFileSync(join(dir, ".env"), "A=from-file\nB=from-file\n", "utf8");
    const env: NodeJS.ProcessEnv = { A: "from-shell" };
    loadEnv(dir, env);
    assert.equal(env.A, "from-shell", "an exported key wins");
    assert.equal(env.B, "from-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writing to .env updates keys in place and leaves the rest alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaan-env-"));
  try {
    writeFileSync(join(dir, ".env"), "# keep me\nOTHER=untouched\nVAAN_MODEL=old\n", "utf8");
    updateEnvFile(dir, { VAAN_MODEL: "new", ANTHROPIC_API_KEY: "sk-test" });

    const written = readFileSync(join(dir, ".env"), "utf8");
    assert.match(written, /# keep me/);
    assert.match(written, /OTHER=untouched/);
    assert.match(written, /VAAN_MODEL=new/);
    assert.doesNotMatch(written, /VAAN_MODEL=old/);
    assert.match(written, /ANTHROPIC_API_KEY=sk-test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
