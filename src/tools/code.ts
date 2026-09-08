// run_command — the coding sandbox's one entry point.
//
// This is the tool the old design refused to ship, and the objection was right
// as far as it went: a shell resolves its own paths so it can't be jailed, and
// approving `bash -c "…"` is approving an opaque string so it can't be
// meaningfully confirmed. Both of those are properties of the shell.
//
// So there is no shell. src/sandbox/process.ts tokenises the command in-process
// and spawns it with `shell: false`; unquoted metacharacters are rejected rather
// than interpreted. What the user approves is the argv that runs — no pipe, no
// `&&` tail, no command substitution, nothing that resolves to something else
// after they said yes. On top of that, cwd is pinned inside the workspace,
// credentials are stripped from the environment, output is capped and the
// process is killed on a timeout.
//
// Classification decides which permission is asked for: `npm test` is
// `execute`, `rm -rf build` is `destructive`, `npm install` is `network`, and
// `mkfs` is refused without a prompt because there is no good answer to it.

import { classifyCommand } from "../permissions/rules.js";
import { CommandError, DEFAULT_TIMEOUT_MS, runCommand, summarise } from "../sandbox/process.js";
import type { Tool } from "../types.js";

const MAX_TIMEOUT_MS = 600_000;

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run one command inside the workspace and get back its output and exit code. Use it to " +
    "run tests, build, or inspect the project with its own tooling. There is no shell: " +
    "pipes, redirection, `&&` and command substitution are rejected, so run one command at " +
    "a time. The user approves the exact command before it runs.",
  group: "code",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: 'One command with its arguments, e.g. "npm test" or "pytest -k auth".',
      },
      cwd: {
        type: "string",
        description: "Directory to run in, relative to the workspace. Defaults to its root.",
      },
      timeout_seconds: {
        type: "number",
        description: "How long to wait before killing it. Default 120, maximum 600.",
      },
    },
    required: ["command"],
  },
  async run(input, ctx) {
    const command = String(input.command ?? "").trim();
    if (!command) return "No command given.";

    const shape = classifyCommand(command);
    if (shape.forbidden) {
      ctx.trace.record({
        kind: "sandbox",
        op: "refused",
        target: command,
        ok: false,
        detail: shape.reasons.join("; "),
      });
      return (
        `Refused: that command ${shape.reasons.join(", ")}. This one isn't approvable — ` +
        `if it's genuinely what you want, the user should run it themselves.`
      );
    }

    await ctx.gate.require({
      tool: "run_command",
      capability: shape.capability,
      target: command,
      ...(shape.reasons.length ? { detail: shape.reasons.join(", ") } : {}),
    });

    const seconds = Number(input.timeout_seconds);
    const timeoutMs = Number.isFinite(seconds)
      ? Math.min(Math.max(seconds, 1) * 1000, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    try {
      const result = await runCommand({
        command,
        workspace: ctx.workspace,
        ...(input.cwd === undefined ? {} : { cwd: String(input.cwd) }),
        timeoutMs,
        env: ctx.env,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      ctx.trace.record({
        kind: "sandbox",
        op: "exec",
        target: result.argv.join(" "),
        ok: result.code === 0,
        detail: summarise(result),
      });

      return format(result.argv.join(" "), result);
    } catch (err) {
      if (err instanceof CommandError) return err.message;
      throw err;
    }
  },
};

function format(
  command: string,
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; ms: number },
): string {
  const lines: string[] = [`$ ${command}`];

  if (result.timedOut) lines.push(`[killed after ${result.ms}ms]`);
  else lines.push(`[exit ${result.code ?? "signal"} in ${result.ms}ms]`);

  if (result.stdout.trim()) lines.push("", result.stdout.trimEnd());
  if (result.stderr.trim()) lines.push("", "stderr:", result.stderr.trimEnd());
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push("", "(no output)");
  if (result.truncated) lines.push("", "[output truncated]");

  return lines.join("\n");
}
