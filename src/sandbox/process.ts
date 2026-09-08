// Running a command, without handing the model a shell.
//
// The old objection to an exec tool was sound: a shell resolves its own paths,
// so it can't be jailed, and approving `bash -c "…"` is approving an opaque
// string, so it can't be meaningfully confirmed either. Both problems come from
// the shell, not from execution.
//
// So there is no shell. The command is tokenised here, in-process, and spawned
// with `shell: false`. Metacharacters outside quotes are rejected rather than
// interpreted, which means the argv a human approves is exactly the argv that
// runs: no pipes, no redirection, no command substitution, no `&&` tail that
// nobody read. What's left is `npm test`, `git status`, `pytest -k auth` — the
// things a coding agent actually needs.
//
// On top of that: cwd is pinned to the workspace, credentials are stripped from
// the environment, output is capped, and the whole thing is killed on a timeout.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/** Rejected outside quotes. Each one is a way to run something else entirely. */
const METACHARACTERS = new Set([";", "&", "|", "<", ">", "`", "$", "(", ")", "{", "}", "\n", "\r"]);

/**
 * Split a command line into argv, or throw.
 *
 * Quoted segments may contain anything — `--grep "a|b"` is a legitimate
 * argument, not a pipe. Unquoted metacharacters are refused with a message the
 * model can act on, because "run these as two commands" is a fix it can make.
 */
export function tokenize(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string;

    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[++index] as string;
      } else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    if (METACHARACTERS.has(char)) {
      throw new CommandError(
        `"${char}" is a shell metacharacter and Vaan does not run commands through a shell. ` +
          `Run one command at a time, and quote arguments that need it.`,
      );
    }
    current += char;
    started = true;
  }

  if (quote) throw new CommandError("Unbalanced quote in the command.");
  if (started) argv.push(current);
  if (argv.length === 0) throw new CommandError("No command given.");
  return argv;
}

/** Environment names whose value never enters the sandbox. */
const SECRET_ENV =
  /(?:^|_)(?:API[-_]?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[-_]?KEY|SESSION|COOKIE|AUTH)(?:$|_)/i;

/**
 * The parent environment minus anything that looks like a credential.
 *
 * A test run genuinely needs PATH, HOME and the rest of the ambient
 * environment, so this is a denylist rather than an allowlist — but the model's
 * own provider keys are exactly the shape this matches, so they never reach a
 * process the model asked for.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_ENV.test(key)) continue;
    out[key] = value;
  }
  out.VAAN_SANDBOX = "1";
  return out;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 60_000;

export interface RunOptions {
  command: string;
  workspace: string;
  /** Subdirectory of the workspace to run in. Jailed like any other path. */
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RunResult {
  argv: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

/**
 * Run `command` inside the workspace and come back with what it printed.
 *
 * `async` rather than a plain Promise-returning function so that a refused
 * command — a metacharacter, a cwd outside the workspace — arrives as a
 * rejection like every other failure, instead of throwing synchronously past a
 * caller that was only expecting `.catch()`.
 */
export async function runCommand(opts: RunOptions): Promise<RunResult> {
  const argv = tokenize(opts.command);
  const [program, ...args] = argv as [string, ...string[]];
  const cwd = jailCwd(opts.workspace, opts.cwd);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<RunResult>((settle) => {
    const child = spawn(program, args, {
      cwd,
      env: scrubEnv(opts.env ?? process.env),
      shell: false,
      // Nothing to type at: a command that waits for input would hang forever,
      // so it gets EOF immediately instead.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const capture = (chunk: Buffer, into: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      if (into === "out") {
        if (stdout.length + text.length > MAX_OUTPUT_BYTES) truncated = true;
        stdout = (stdout + text).slice(0, MAX_OUTPUT_BYTES);
      } else {
        if (stderr.length + text.length > MAX_OUTPUT_BYTES) truncated = true;
        stderr = (stderr + text).slice(0, MAX_OUTPUT_BYTES);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "err"));

    const stop = (): void => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    opts.signal?.addEventListener("abort", stop, { once: true });

    const done = (code: number | null): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      settle({
        argv,
        code,
        stdout,
        stderr,
        timedOut,
        truncated,
        ms: Date.now() - startedAt,
      });
    };

    child.on("error", (err) => {
      stderr = `${stderr}${err.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

/** The working directory must be inside the workspace, like every other path. */
function jailCwd(workspace: string, candidate: string | undefined): string {
  const root = realpathSync(resolve(workspace));
  if (!candidate) return root;
  const target = resolve(root, candidate);
  const real = (() => {
    try {
      return realpathSync(target);
    } catch {
      return target;
    }
  })();
  if (real !== root && !real.startsWith(root + sep)) {
    throw new CommandError(`"${candidate}" is outside the workspace.`);
  }
  return real;
}

/** A one-line summary of a run, for the trace and for the tool result. */
export function summarise(result: RunResult): string {
  if (result.timedOut) return `timed out after ${result.ms}ms`;
  return `exit ${result.code ?? "signal"} in ${result.ms}ms`;
}
