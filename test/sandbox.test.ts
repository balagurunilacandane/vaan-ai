// The three sandbox boundaries: filesystem, process, network.
//
// GUARDRAILS.md is a request. This is enforcement.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { JailError, jail } from "../src/sandbox/filesystem.js";
import { CommandError, runCommand, scrubEnv, tokenize } from "../src/sandbox/process.js";
import { checkUrl, toReadableText } from "../src/sandbox/network.js";

function sandbox(): { root: string; outside: string; cleanup: () => void } {
  // realpath up front: on macOS the temp dir is /var/… which is a symlink to
  // /private/var/…, and the jail resolves it. Comparing raw paths would fail
  // for a reason that has nothing to do with the fence.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vaan-jail-")));
  const root = join(base, "project");
  const outside = join(base, "elsewhere");
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "nested", "file.txt"), "inside", "utf8");
  writeFileSync(join(outside, "secret.txt"), "outside", "utf8");
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("resolves paths relative to the working directory", () => {
  const { root, cleanup } = sandbox();
  try {
    assert.equal(jail(root, "nested/file.txt"), join(resolve(root), "nested", "file.txt"));
    assert.equal(jail(root, "./nested/../nested/file.txt"), join(resolve(root), "nested", "file.txt"));
  } finally {
    cleanup();
  }
});

test("rejects traversal out of the directory", () => {
  const { root, cleanup } = sandbox();
  try {
    assert.throws(() => jail(root, "../elsewhere/secret.txt"), JailError);
    assert.throws(() => jail(root, "nested/../../elsewhere/secret.txt"), JailError);
  } finally {
    cleanup();
  }
});

test("rejects an absolute path that lands outside", () => {
  const { root, outside, cleanup } = sandbox();
  try {
    assert.throws(() => jail(root, join(outside, "secret.txt")), JailError);
  } finally {
    cleanup();
  }
});

test("rejects a symlink that points out of the directory", (t) => {
  const { root, outside, cleanup } = sandbox();
  try {
    try {
      symlinkSync(outside, join(root, "escape"), "dir");
    } catch {
      // Windows needs a privilege for this; nothing to prove if we can't link.
      t.skip("symlinks unavailable");
      return;
    }
    // resolve() alone would say this is inside the root. It isn't.
    assert.throws(() => jail(root, "escape/secret.txt"), JailError);
  } finally {
    cleanup();
  }
});

test("allows a file that doesn't exist yet, so write_file can create one", () => {
  const { root, cleanup } = sandbox();
  try {
    assert.equal(jail(root, "brand/new/file.txt"), join(resolve(root), "brand", "new", "file.txt"));
  } finally {
    cleanup();
  }
});

test("the working directory itself is allowed", () => {
  const { root, cleanup } = sandbox();
  try {
    assert.equal(jail(root, "."), resolve(root));
  } finally {
    cleanup();
  }
});

// --- The process boundary ---------------------------------------------------
//
// There is no shell, and these are the tests that say so. Every metacharacter
// below is a way to turn one approved command into a different one, which is
// exactly the objection an exec tool has to answer.

test("a command is split into argv without a shell", () => {
  assert.deepEqual(tokenize("npm test"), ["npm", "test"]);
  assert.deepEqual(tokenize("pytest -k auth"), ["pytest", "-k", "auth"]);
  assert.deepEqual(tokenize("  git   status  "), ["git", "status"]);
});

test("quotes hold an argument together, metacharacters and all", () => {
  assert.deepEqual(tokenize('grep "a|b" file.txt'), ["grep", "a|b", "file.txt"]);
  assert.deepEqual(tokenize("echo 'one two'"), ["echo", "one two"]);
  assert.deepEqual(tokenize('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
});

test("an unquoted metacharacter is refused, not interpreted", () => {
  for (const command of [
    "npm test && rm -rf build",
    "cat file | sh",
    "echo hi > /etc/passwd",
    "echo $(whoami)",
    "ls; rm -rf .",
    "cat `id`",
  ]) {
    assert.throws(() => tokenize(command), CommandError, `${command} should be refused`);
  }
});

test("an unbalanced quote is an error rather than a guess", () => {
  assert.throws(() => tokenize('echo "unterminated'), CommandError);
});

test("credentials are stripped from the environment a command inherits", () => {
  const scrubbed = scrubEnv({
    PATH: "/usr/bin",
    HOME: "/home/me",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    DB_PASSWORD: "hunter2",
    NODE_ENV: "test",
  });

  assert.equal(scrubbed.PATH, "/usr/bin", "a command still needs its PATH");
  assert.equal(scrubbed.NODE_ENV, "test");
  assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
  assert.equal(scrubbed.OPENAI_API_KEY, undefined);
  assert.equal(scrubbed.GITHUB_TOKEN, undefined);
  assert.equal(scrubbed.DB_PASSWORD, undefined);
  assert.equal(scrubbed.VAAN_SANDBOX, "1");
});

test("a command runs inside the workspace and reports its exit code", async () => {
  const { root, cleanup } = sandbox();
  try {
    const result = await runCommand({ command: "node --version", workspace: root });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^v\d+\./);
  } finally {
    cleanup();
  }
});

test("a working directory outside the workspace is refused", async () => {
  const { root, outside, cleanup } = sandbox();
  try {
    await assert.rejects(
      () => runCommand({ command: "node --version", workspace: root, cwd: outside }),
      CommandError,
    );
  } finally {
    cleanup();
  }
});

test("a command that outlives its timeout is killed", async () => {
  const { root, cleanup } = sandbox();
  try {
    const result = await runCommand({
      command: 'node -e "setTimeout(()=>{}, 10000)"',
      workspace: root,
      timeoutMs: 300,
    });
    assert.equal(result.timedOut, true);
  } finally {
    cleanup();
  }
});

// --- The network boundary ---------------------------------------------------

test("loopback and private addresses are refused by default", () => {
  for (const url of [
    "http://localhost:8080/admin",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/",
    "http://192.168.1.1/",
    "http://db.internal/",
  ]) {
    assert.equal(checkUrl(url).ok, false, `${url} should be refused`);
  }
});

test("public addresses are allowed, and other schemes are not", () => {
  assert.equal(checkUrl("https://example.com/docs").ok, true);
  assert.equal(checkUrl("file:///etc/passwd").ok, false);
  assert.equal(checkUrl("not a url").ok, false);
});

test("a host on the allow list gets through even when it's local", () => {
  const policy = { allow: ["localhost"], deny: [], allowLocal: false };
  assert.equal(checkUrl("http://localhost:11434/v1", policy).ok, true);
});

test("the deny list wins over the allow list", () => {
  const policy = { allow: ["example.com"], deny: ["example.com"], allowLocal: false };
  assert.equal(checkUrl("https://example.com/", policy).ok, false);
});

test("HTML becomes readable text without scripts or markup", () => {
  const html =
    "<html><head><style>body{color:red}</style></head><body>" +
    "<script>alert(1)</script><h1>Title</h1><p>First &amp; second.</p></body></html>";
  const text = toReadableText(html);
  assert.match(text, /Title/);
  assert.match(text, /First & second\./);
  assert.doesNotMatch(text, /alert/);
  assert.doesNotMatch(text, /color:red/);
});
