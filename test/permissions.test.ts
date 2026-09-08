// The gate is the thing that has to hold. These tests are written from the
// attacker's side: every one of them is a way an agent might get somewhere it
// shouldn't, and the assertion is that it doesn't.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGate, PermissionDenied, type Approver } from "../src/permissions/approval.js";
import { createPolicy } from "../src/permissions/policy.js";
import {
  ALL_APPROVALS,
  classifyCommand,
  defaultRules,
  evaluate,
  isSensitiveFile,
  matchesGlob,
  type PermissionRequest,
} from "../src/permissions/rules.js";

function workspace(): { root: string; outside: string; cleanup: () => void } {
  // realpath up front: on macOS the temp dir is /var/… which is a symlink to
  // /private/var/…, and the policy resolves it. Comparing raw paths would fail
  // for a reason that has nothing to do with permissions.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vaan-perm-")));
  const root = join(base, "project");
  const outside = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "outside", "utf8");
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ask = (answer: boolean): Approver => async () => answer;

test("reading inside the workspace is allowed; writing asks", () => {
  const { root, cleanup } = workspace();
  try {
    const policy = createPolicy({ workspace: root });
    assert.equal(policy.check(policy.forPath("read_file", "notes.md", "read")).decision, "allow");
    assert.equal(policy.check(policy.forPath("write_file", "notes.md", "write")).decision, "ask");
  } finally {
    cleanup();
  }
});

test("a path outside the workspace is classified as outside, not as a plain write", () => {
  const { root, outside, cleanup } = workspace();
  try {
    const policy = createPolicy({ workspace: root });
    const request = policy.forPath("write_file", join(outside, "secret.txt"), "write");
    assert.equal(request.capability, "outside");
  } finally {
    cleanup();
  }
});

test("a symlink out of the workspace is classified by where it lands", () => {
  const { root, outside, cleanup } = workspace();
  try {
    // The whole trick: an in-bounds name pointing at an out-of-bounds file.
    symlinkSync(outside, join(root, "escape"));
    const policy = createPolicy({ workspace: root });
    const request = policy.forPath("read_file", "escape/secret.txt", "read");
    assert.equal(request.capability, "outside", "resolving must follow the symlink");
  } finally {
    cleanup();
  }
});

test("a file that doesn't exist yet is classified by its parent's real location", () => {
  const { root, outside, cleanup } = workspace();
  try {
    symlinkSync(outside, join(root, "escape"));
    const policy = createPolicy({ workspace: root });
    // Nothing at this path yet, so only the deepest existing ancestor can say
    // where it will land. Without that, creating a file would always look local.
    const request = policy.forPath("write_file", "escape/new-file.txt", "write");
    assert.equal(request.capability, "outside");
  } finally {
    cleanup();
  }
});

test("credential files are credentials wherever they sit", () => {
  const { root, cleanup } = workspace();
  try {
    const policy = createPolicy({ workspace: root });
    for (const path of [".env", "config/.env.local", ".ssh/id_rsa", ".aws/credentials"]) {
      assert.equal(
        policy.forPath("read_file", path, "read").capability,
        "credentials",
        `${path} should classify as credentials`,
      );
    }
    assert.equal(policy.forPath("read_file", "src/env.ts", "read").capability, "read");
  } finally {
    cleanup();
  }
});

test("the floor cannot be turned off by config", () => {
  // Every approval flag cleared: the most permissive policy the onboarding can
  // produce. Credentials and system changes are still denied.
  const permissive = defaultRules({
    destructive: false,
    network: false,
    credentials: false,
    outside: false,
    system: false,
  });
  const request = (capability: PermissionRequest["capability"]): PermissionRequest => ({
    tool: "t",
    capability,
    target: "/anything",
  });

  assert.equal(evaluate(permissive, request("credentials")).decision, "deny");
  assert.equal(evaluate(permissive, request("credentials")).fixed, true);
  assert.equal(evaluate(permissive, request("system")).decision, "deny");
  // And the ones the flags legitimately control did loosen.
  assert.equal(evaluate(permissive, request("network")).decision, "allow");
});

test("an unknown capability is denied rather than allowed by omission", () => {
  assert.equal(
    evaluate([], { tool: "t", capability: "execute", target: "x" }).decision,
    "deny",
    "no matching rule must mean no",
  );
});

test("glob matching handles segments and crossing them", () => {
  assert.equal(matchesGlob("/etc/**", "/etc/hosts"), true);
  assert.equal(matchesGlob("/etc/**", "/etc/ssl/certs/x.pem"), true);
  assert.equal(matchesGlob("/etc/**", "/etcetera/file"), false);
  assert.equal(matchesGlob("*.ts", "index.ts"), true);
  assert.equal(matchesGlob("*.ts", "src/index.ts"), false, "* stays within a segment");
  assert.equal(matchesGlob("**", "anything/at/all"), true);
});

test("commands are classified by the worst thing they do", () => {
  assert.equal(classifyCommand("npm test").capability, "execute");
  assert.equal(classifyCommand("rm -rf build").capability, "destructive");
  assert.equal(classifyCommand("npm install").capability, "network");
  assert.equal(classifyCommand("sudo npm test").capability, "system");
  assert.equal(classifyCommand("printenv").capability, "credentials");
  assert.equal(classifyCommand("git push --force origin main").capability, "destructive");
});

test("some commands are refused rather than offered for approval", () => {
  for (const command of ["mkfs.ext4 /dev/sda1", "rm -rf /", "shutdown -h now"]) {
    assert.equal(classifyCommand(command).forbidden, true, `${command} should be unapprovable`);
  }
  assert.equal(classifyCommand("rm -rf ./build").forbidden, false, "a scoped delete is approvable");
});

test("sensitive files are recognised by name", () => {
  assert.equal(isSensitiveFile("/home/me/project/.env"), true);
  assert.equal(isSensitiveFile("/home/me/.ssh/id_ed25519"), true);
  assert.equal(isSensitiveFile("/home/me/project/src/environment.ts"), false);
});

test("the gate throws PermissionDenied when the human says no", async () => {
  const { root, cleanup } = workspace();
  try {
    const policy = createPolicy({ workspace: root });
    const gate = createGate({ policy, approve: ask(false) });
    await assert.rejects(
      () => gate.require(policy.forPath("write_file", "notes.md", "write")),
      PermissionDenied,
    );
  } finally {
    cleanup();
  }
});

test("a denied capability never reaches the approver at all", async () => {
  const { root, cleanup } = workspace();
  try {
    let asked = 0;
    const policy = createPolicy({ workspace: root, approvals: ALL_APPROVALS });
    const gate = createGate({
      policy,
      approve: async () => {
        asked++;
        return true;
      },
    });
    // Approving this would be the bug: a fixed denial must not be promptable,
    // because a user who is holding down `y` would grant it.
    await assert.rejects(() => gate.require(policy.forPath("read_file", ".env", "read")));
    assert.equal(asked, 0, "a fixed deny must not be offered to the user");
  } finally {
    cleanup();
  }
});

test("approving a command once covers the identical command again, and nothing else", async () => {
  const { root, cleanup } = workspace();
  try {
    let asked = 0;
    const policy = createPolicy({ workspace: root });
    const gate = createGate({
      policy,
      approve: async () => {
        asked++;
        return true;
      },
    });
    const run = (command: string) =>
      gate.require({ tool: "run_command", capability: "execute", target: command });

    await run("npm test");
    await run("npm test");
    assert.equal(asked, 1, "the same command shouldn't ask twice");

    await run("npm run build");
    assert.equal(asked, 2, "a different command is a different question");
  } finally {
    cleanup();
  }
});

test("writes are never memoised, because the path is the same and the content isn't", async () => {
  const { root, cleanup } = workspace();
  try {
    let asked = 0;
    const policy = createPolicy({ workspace: root });
    const gate = createGate({
      policy,
      approve: async () => {
        asked++;
        return true;
      },
    });
    await gate.require(policy.forPath("write_file", "notes.md", "write"));
    await gate.require(policy.forPath("write_file", "notes.md", "write"));
    assert.equal(asked, 2, "every write asks");
  } finally {
    cleanup();
  }
});

test("confirmEveryCommand turns the memo off", async () => {
  const { root, cleanup } = workspace();
  try {
    let asked = 0;
    const policy = createPolicy({ workspace: root });
    const gate = createGate({
      policy,
      memoise: false,
      approve: async () => {
        asked++;
        return true;
      },
    });
    await gate.require({ tool: "run_command", capability: "execute", target: "npm test" });
    await gate.require({ tool: "run_command", capability: "execute", target: "npm test" });
    assert.equal(asked, 2);
  } finally {
    cleanup();
  }
});
