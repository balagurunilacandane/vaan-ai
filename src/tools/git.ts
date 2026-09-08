// git_status, git_diff, git_log — read-only, and that is the whole design.
//
// These three answer "what has changed and why", which is what an agent needs
// before touching a repository. Committing, pushing and branching are not here:
// they go through run_command, where the exact command is shown and approved.
// A tool called `git_commit` would be a second, quieter path to the same effect
// with a friendlier name, and the friendlier name is exactly the problem.

import { runCommand, summarise } from "../sandbox/process.js";
import type { Tool, ToolContext } from "../types.js";

const MAX_LINES = 400;

async function git(ctx: ToolContext, args: string, label: string): Promise<string> {
  // Reading a repository is reading the workspace, so it asks for `read` rather
  // than `execute`: no side effects, nothing to approve.
  await ctx.gate.require(ctx.policy.forPath(label, ".", "read"));

  const result = await runCommand({
    command: `git ${args}`,
    workspace: ctx.workspace,
    env: ctx.env,
    timeoutMs: 30_000,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  ctx.trace.record({
    kind: "sandbox",
    op: "git",
    target: args,
    ok: result.code === 0,
    detail: summarise(result),
  });

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    if (/not a git repository/i.test(detail)) return "This workspace isn't a git repository.";
    if (/command not found|ENOENT/i.test(detail)) return "git isn't installed on this machine.";
    return `git ${args} failed: ${detail || `exit ${result.code}`}`;
  }

  const output = result.stdout.trim();
  if (!output) return "(nothing to report)";
  const lines = output.split("\n");
  return lines.length <= MAX_LINES
    ? output
    : `${lines.slice(0, MAX_LINES).join("\n")}\n[${lines.length - MAX_LINES} more lines]`;
}

export const gitStatus: Tool = {
  name: "git_status",
  description:
    "Show which files in the workspace have been modified, staged or left untracked. " +
    "Read-only. Use it before changing anything, to see what was already in flight.",
  group: "git",
  parameters: { type: "object", properties: {} },
  run: (_input, ctx) => git(ctx, "status --short --branch", "git_status"),
};

export const gitDiff: Tool = {
  name: "git_diff",
  description:
    "Show the diff of uncommitted changes in the workspace. Read-only. " +
    "Pass staged to see what is already staged instead.",
  group: "git",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes instead of unstaged ones." },
      path: { type: "string", description: "Limit the diff to one path." },
    },
  },
  run(input, ctx) {
    const staged = input.staged === true ? " --staged" : "";
    // Quoted so a path with a space stays one argument; there is no shell to
    // re-split it, so this is the only escaping that has to happen.
    const path = input.path === undefined ? "" : ` -- "${String(input.path).replace(/"/g, "")}"`;
    return git(ctx, `diff${staged}${path}`, "git_diff");
  },
};

export const gitLog: Tool = {
  name: "git_log",
  description:
    "Show recent commits in the workspace, newest first. Read-only. " +
    "Use it to find out why something is the way it is.",
  group: "git",
  parameters: {
    type: "object",
    properties: {
      count: { type: "number", description: "How many commits. Default 15, maximum 100." },
      path: { type: "string", description: "Only commits touching this path." },
    },
  },
  run(input, ctx) {
    const asked = Number(input.count);
    const count = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 100) : 15;
    const path = input.path === undefined ? "" : ` -- "${String(input.path).replace(/"/g, "")}"`;
    return git(ctx, `log --oneline --no-decorate -n ${count}${path}`, "git_log");
  },
};
