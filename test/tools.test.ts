// The tools, exercised through the same context the loop hands them — gate
// included. A tool tested with the gate stubbed open is a tool whose permission
// check nobody has ever run.

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGate } from "../src/permissions/approval.js";
import { createPolicy } from "../src/permissions/policy.js";
import { runCommandTool } from "../src/tools/code.js";
import { diff, editFile, readFile, writeFile } from "../src/tools/files.js";
import { searchWorkspace } from "../src/tools/grep.js";
import { builtinTools, GROUPS } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";
import { testContext, testTrace } from "./harness.js";

function project(files: Record<string, string> = {}): {
  root: string;
  ctx: (approve?: boolean, confirm?: boolean) => ToolContext;
  cleanup: () => void;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vaan-tools-")));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, "utf8");

  return {
    root,
    ctx(approve = true, confirm = true) {
      const policy = createPolicy({ workspace: root });
      const trace = testTrace();
      return {
        ...testContext({ workspace: root, trace }),
        policy,
        gate: createGate({ policy, approve: async () => approve, trace: () => trace }),
        confirm: async () => confirm,
      };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("edit_file replaces an exact string and leaves the rest alone", async () => {
  const { ctx, root, cleanup } = project({
    "app.ts": "const port = 3000;\nconst host = 'localhost';\n",
  });
  try {
    const out = await editFile.run(
      { path: "app.ts", old_text: "const port = 3000;", new_text: "const port = 8080;" },
      ctx(),
    );
    assert.match(out, /Wrote app\.ts/);
    assert.equal(
      readFileSync(join(root, "app.ts"), "utf8"),
      "const port = 8080;\nconst host = 'localhost';\n",
    );
  } finally {
    cleanup();
  }
});

test("edit_file refuses an ambiguous match rather than picking one", async () => {
  const { ctx, cleanup } = project({ "app.ts": "let x = 1;\nlet x = 1;\n" });
  try {
    const out = await editFile.run(
      { path: "app.ts", old_text: "let x = 1;", new_text: "let x = 2;" },
      ctx(),
    );
    assert.match(out, /appears 2 times/);
  } finally {
    cleanup();
  }
});

test("edit_file says so when the text isn't there, instead of writing anything", async () => {
  const { ctx, root, cleanup } = project({ "app.ts": "let x = 1;\n" });
  try {
    const out = await editFile.run(
      { path: "app.ts", old_text: "let y = 1;", new_text: "let y = 2;" },
      ctx(),
    );
    assert.match(out, /isn't in app\.ts/);
    assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "let x = 1;\n");
  } finally {
    cleanup();
  }
});

test("replace_all changes every occurrence when asked", async () => {
  const { ctx, root, cleanup } = project({ "app.ts": "a\nb\na\n" });
  try {
    await editFile.run({ path: "app.ts", old_text: "a", new_text: "c", replace_all: true }, ctx());
    assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "c\nb\nc\n");
  } finally {
    cleanup();
  }
});

test("a declined permission stops the write before the diff is even shown", async () => {
  const { ctx, root, cleanup } = project({ "app.ts": "original\n" });
  try {
    // confirm: true would approve the diff — the point is that the gate ran
    // first and the tool never got that far.
    await assert.rejects(
      () => Promise.resolve(writeFile.run({ path: "app.ts", content: "changed" }, ctx(false, true))),
      /Not permitted/,
    );
    assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "original\n");
  } finally {
    cleanup();
  }
});

test("a declined diff stops the write after permission was granted", async () => {
  const { ctx, root, cleanup } = project({ "app.ts": "original\n" });
  try {
    const out = await writeFile.run({ path: "app.ts", content: "changed" }, ctx(true, false));
    assert.match(out, /declined/);
    assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "original\n");
  } finally {
    cleanup();
  }
});

test("read_file refuses a credential file inside the workspace", async () => {
  const { ctx, cleanup } = project({ ".env": "API_KEY=secret\n" });
  try {
    await assert.rejects(
      () => Promise.resolve(readFile.run({ path: ".env" }, ctx(true, true))),
      /Not permitted/,
      "an approving user must not be able to approve this one",
    );
  } finally {
    cleanup();
  }
});

test("search finds text with the file and line, and skips generated directories", async () => {
  const { ctx, cleanup } = project({
    "app.ts": "import { rateLimit } from './limit';\n",
    "readme.md": "no match here\n",
  });
  try {
    const out = await searchWorkspace.run({ query: "rateLimit" }, ctx());
    assert.match(out, /app\.ts:1/);
    assert.doesNotMatch(out, /readme\.md/);
  } finally {
    cleanup();
  }
});

test("run_command runs a real command and reports the exit code", async () => {
  const { ctx, cleanup } = project();
  try {
    const out = await runCommandTool.run({ command: "node --version" }, ctx());
    assert.match(out, /\$ node --version/);
    assert.match(out, /\[exit 0 in \d+ms\]/);
    assert.match(out, /v\d+\./);
  } finally {
    cleanup();
  }
});

test("run_command refuses an unapprovable command without asking anyone", async () => {
  const { ctx, cleanup } = project();
  try {
    // approve: true — a user holding down `y` still doesn't get this to run.
    const out = await runCommandTool.run({ command: "rm -rf /" }, ctx(true, true));
    assert.match(out, /Refused/);
    assert.doesNotMatch(out, /exit/);
  } finally {
    cleanup();
  }
});

test("run_command explains the missing shell instead of silently failing", async () => {
  const { ctx, cleanup } = project();
  try {
    const out = await runCommandTool.run({ command: "node --version | wc -l" }, ctx());
    assert.match(out, /metacharacter/);
  } finally {
    cleanup();
  }
});

test("a declined command never spawns anything", async () => {
  const { ctx, cleanup } = project();
  try {
    await assert.rejects(
      () => Promise.resolve(runCommandTool.run({ command: "node --version" }, ctx(false))),
      /Not permitted/,
    );
  } finally {
    cleanup();
  }
});

test("turning a group off removes its tools rather than refusing them later", () => {
  const withCode = builtinTools().map((tool) => tool.name);
  assert.ok(withCode.includes("run_command"));

  const withoutCode = builtinTools({ groups: ["files", "search"] }).map((tool) => tool.name);
  assert.equal(withoutCode.includes("run_command"), false);
  assert.equal(withoutCode.includes("web_search"), false);
  assert.ok(withoutCode.includes("read_file"));
});

test("groups that ship no tools say so rather than pretending", () => {
  const declared = GROUPS.filter((group) => !group.available).map((group) => group.group);
  assert.deepEqual(declared, ["browser", "integrations"]);
  const names = builtinTools({ groups: declared });
  assert.equal(names.length, 0, "an unavailable group contributes nothing");
});

test("the diff shows what moved and trims what didn't", () => {
  const before = "a\nb\nc\nd\n";
  const after = "a\nB\nc\nd\n";
  const rendered = diff(before, after);
  assert.match(rendered, /- b/);
  assert.match(rendered, /\+ B/);
  assert.match(rendered, /1 unchanged line above/);
  assert.doesNotMatch(rendered, /- d/);
});
