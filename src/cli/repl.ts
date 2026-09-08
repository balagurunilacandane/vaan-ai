// The REPL. There is no single-shot mode: a positional-argument branch would
// duplicate this whole path to save one keystroke, and piping into Vaan is a
// different program. If stdin isn't a terminal we say so and leave, rather than
// blocking forever on a prompt nobody can answer.
//
// The approval prompt lives here, and that placement is the security design.
// `approve` below is closed over this readline handle, attached to the real
// terminal. It is handed to createSession and never leaves that closure — no
// tool receives it, nothing the model emits can reach it. When the gate needs a
// yes, it comes from a person or it doesn't come.

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { describeConfig, type Config } from "../config.js";
import { clearInbox, readInbox } from "../inbox.js";
import { createSession, type Session } from "../index.js";
import { launchCommand } from "../invocation.js";
import { shortId } from "../observability/request.js";
import type { PermissionRequest } from "../permissions/rules.js";
import { statuses } from "../providers/index.js";
import { activeGroups, GROUPS } from "../tools/index.js";
import { printMemory } from "./memory-cmd.js";
import { configFile } from "../paths.js";
import { VERSION } from "./wizard.js";
import { createSpinner } from "./spinner.js";
import { render } from "./trace-cmd.js";
import {
  ASK,
  createTheme,
  describeInput,
  DOT,
  duration,
  STEP,
  summariseOutput,
  tokens,
  clip,
  type Theme,
} from "./theme.js";

const DIM = "[2m";
const RESET = "[0m";

export interface ReplOptions {
  workspace: string;
  model: string;
  config: Config;
  memory: boolean;
  yes: boolean;
  trace: boolean;
  env: NodeJS.ProcessEnv;
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  const out = process.stdout;
  const rl = createInterface({ input: process.stdin, output: out });
  const t = createTheme({ env: opts.env });

  let session: Session;
  try {
    session = open(opts, rl, t);
  } catch (err) {
    out.write(`\n  ${t.red(message(err))}\n\n`);
    rl.close();
    return 1;
  }

  banner(out, opts, session, t);

  let lastRequestId = "";
  for (;;) {
    const line = (await rl.question(`${t.lime(">")} `)).trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [command = "", ...rest] = line.slice(1).split(/\s+/);
      if (command === "exit" || command === "quit") break;
      try {
        session = await handle(command, rest, session, opts, rl, out, lastRequestId, t);
      } catch (err) {
        out.write(`  ${t.red(message(err))}\n\n`);
      }
      continue;
    }

    const controller = new AbortController();
    const interrupt = () => controller.abort();
    rl.once("SIGINT", interrupt);
    const spinner = createSpinner({ out, theme: t, animate: out.isTTY === true });
    try {
      out.write("\n");
      const result = await session.ask(line, {
        signal: controller.signal,
        onRequest: (request) => {
          lastRequestId = request.id;
        },
        onRecall: (used) => {
          spinner.start(used ? "recalling" : "thinking");
        },
        onEvent: (event) => {
          if (event.type === "thinking") spinner.start("thinking");

          if (event.type === "tool_call") {
            spinner.stop();
            const args = describeInput(event.input);
            out.write(
              `${t.lime(STEP)} ${t.lime(event.name)}${args ? ` ${t.dim(args)}` : ""}\n`,
            );
          }

          if (event.type === "tool_result") {
            const summary = summariseOutput(event.output);
            const body = `  ${summary}  ${DOT} ${duration(event.ms)}`;
            out.write(event.isError ? `${t.red(body)}\n\n` : `${t.dim(body)}\n\n`);
            // Back to waiting on the model until it says otherwise.
            spinner.start("thinking");
          }

          if (event.type === "text") spinner.stop();
        },
      });
      spinner.stop();
      out.write(`${result.text}\n\n`);
      footer(out, session, lastRequestId, t);
    } catch (err) {
      spinner.stop();
      out.write(
        controller.signal.aborted
          ? `  ${t.dim("interrupted")}\n\n`
          : `  ${t.red(message(err))}\n\n`,
      );
    } finally {
      spinner.stop();
      rl.off("SIGINT", interrupt);
    }
  }

  session.close();
  rl.close();
  return 0;
}

/** Model, tokens, and the request id — one dim line under each answer. */
function footer(
  out: NodeJS.WriteStream,
  session: Session,
  requestId: string,
  t: Theme,
): void {
  // No percentage: Vaan has no allowlist of models and therefore no idea how
  // big this one's context window is. A made-up denominator is worse than none.
  const used = `↑${tokens(session.usage.input)} ↓${tokens(session.usage.output)}`;
  const id = requestId ? `  ${DOT}  ${shortId(requestId)}` : "";
  out.write(`${t.faint(`  ${session.model}  ${DOT}  ${used}${id}`)}\n\n`);
}

function banner(out: NodeJS.WriteStream, opts: ReplOptions, session: Session, t: Theme): void {
  const name = session.config.agentName.toLowerCase();
  out.write(`\n  ${t.bold(t.lime(name))} ${t.dim(VERSION)}\n`);

  // One line of context rather than six lines of ticks: what it can see, what
  // it can do to you, and whether it will remember. Everything else is /status.
  const facts = [
    opts.workspace.replace(homedir(), "~"),
    opts.config.sandbox.name === "restricted" ? "sandboxed" : opts.config.sandbox.name,
    opts.memory ? "memory on" : "memory off",
    opts.trace ? "tracing on" : "tracing off",
  ];
  out.write(`  ${t.dim(facts.join(`  ${DOT}  `))}\n`);

  const notes = [...session.warnings];
  if (opts.yes) notes.push("--yes: every permission is granted without asking");
  const pending = readInbox(opts.workspace).length;
  if (pending > 0) notes.push(`${pending} item${pending === 1 ? "" : "s"} in /inbox`);
  for (const note of notes) out.write(`  ${t.red(ASK)} ${t.dim(note)}\n`);

  out.write("\n");
}

function open(opts: ReplOptions, rl: Interface, t: Theme): Session {
  const out = process.stdout;

  return createSession({
    workspace: opts.workspace,
    model: opts.model,
    config: opts.config,
    memory: opts.memory,
    yes: opts.yes,
    trace: opts.trace,
    env: opts.env,

    // Whether. The gate calls this, and only a person can answer it.
    approve: async (request: PermissionRequest, reason: string) => {
      const detail = request.detail ? ` ${DOT} ${request.detail}` : "";
      out.write(
        `${t.red(ASK)} ${t.bright(verb(request))} ` +
          `${t.dim(clip(shorten(request.target, opts.workspace), 48))}\n`,
      );
      out.write(`${t.dim(`  ${request.capability.toUpperCase()}${detail}`)}\n`);
      out.write(`${t.faint(`  ${reason}`)}\n`);
      const answer = (
        await rl.question(`  ${t.dim("allow?")}  ${t.bright("[y]")} yes  ${t.bright("[n]")} no  `)
      )
        .trim()
        .toLowerCase();
      out.write("\n");
      return answer === "y" || answer === "yes";
    },

    // What. Every write stops here too — but the diff is offered, not dumped.
    // Forty lines nobody asked for is forty lines nobody reads.
    confirm: async (request) => {
      out.write(`${t.red(ASK)} ${t.bright(request.tool)}  ${t.dim(request.target)}\n`);
      out.write(
        `  ${t.red(`- ${request.removed}`)}   ${t.lime(`+ ${request.added}`)}` +
          `   ${t.faint(request.action.toLowerCase())}\n`,
      );

      for (;;) {
        const answer = (
          await rl.question(
            `  ${t.dim("apply this change?")}  ${t.bright("[y]")} yes  ` +
              `${t.bright("[d]")} diff  ${t.bright("[n]")} no  `,
          )
        )
          .trim()
          .toLowerCase();

        if (answer === "d" || answer === "diff") {
          out.write(`\n${colourDiff(request.diff, t)}\n\n`);
          continue;
        }
        out.write("\n");
        return answer === "y" || answer === "yes";
      }
    },
  });
}

/**
 * A path a person can read. The policy resolves everything to an absolute real
 * path — which is what it must compare against — but
 * `/private/var/folders/2c/j03wb…` truncated to fit is not an approval prompt,
 * it is a dare. Inside the workspace, say where inside.
 */
function shorten(target: string, workspace: string): string {
  if (!isAbsolute(target)) return target;
  const inside = relative(workspace, target);
  if (inside && !inside.startsWith("..")) return inside;
  return target.replace(homedir(), "~");
}

/** Red for what goes, lime for what arrives. The rest is context. */
function colourDiff(diff: string, t: Theme): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("- ")) return t.red(line);
      if (line.startsWith("+ ")) return t.lime(line);
      return t.faint(line);
    })
    .join("\n");
}

const verb = (request: PermissionRequest): string => {
  switch (request.capability) {
    case "write":
      return "modify";
    case "execute":
    case "destructive":
      return "run";
    case "network":
      return "reach";
    case "outside":
      return "touch a path outside the workspace";
    default:
      return "access";
  }
};

const HELP = `
  /model [spec]   show providers, or switch model
  /new            start a new conversation, keeping stored memory
  /memory         what's remembered
  /forget [id]    remove a fact
  /inbox          results from scheduled runs
  /status         workspace, permissions, tools, tokens
  /trace [id]     the last request in full, or one by id
  /settings       where to change things
  /help           this
  /exit           leave
`;

async function handle(
  command: string,
  args: string[],
  session: Session,
  opts: ReplOptions,
  rl: Interface,
  out: NodeJS.WriteStream,
  lastRequestId: string,
  t: Theme,
): Promise<Session> {
  switch (command) {
    case "model": {
      if (args.length === 0) {
        out.write(`\n  using ${opts.model}\n\n`);
        for (const spec of statuses(opts.env)) {
          const key = spec.envKey
            ? `${spec.envKey} ${spec.ready ? "set" : "missing"}`
            : "no key needed";
          out.write(`    ${spec.name.padEnd(12)} ${spec.ready ? "✓" : " "} ${key}\n`);
        }
        out.write("\n  /model <provider>/<name> to switch.\n\n");
        return session;
      }
      const next = args[0] as string;
      const replacement = open({ ...opts, model: next }, rl, t);
      session.close();
      opts.model = next;
      out.write(`\n  ✓ ${next}\n\n`);
      return replacement;
    }

    case "new":
      session.reset();
      out.write("\n  New conversation. Facts and past turns are still remembered.\n\n");
      return session;

    case "memory":
      printMemory(out, await session.memory.recall(opts.workspace, ""));
      return session;

    case "forget": {
      const { facts } = await session.memory.recall(opts.workspace, "");
      if (facts.length === 0) {
        out.write("\n  Nothing remembered yet.\n\n");
        return session;
      }
      let id = Number(args[0]);
      if (!Number.isInteger(id)) {
        out.write("\n");
        for (const fact of facts) out.write(`    ${String(fact.id).padStart(3)}  ${fact.text}\n`);
        id = Number((await rl.question("\n  Forget which?  ")).trim());
      }
      const removed = Number.isInteger(id) ? await session.memory.forget(opts.workspace, id) : 0;
      out.write(removed > 0 ? `  forgot #${id}\n\n` : "  no such fact\n\n");
      return session;
    }

    case "inbox": {
      const items = readInbox(opts.workspace);
      if (items.length === 0) {
        out.write("\n  Nothing pending.\n\n");
        return session;
      }
      out.write("\n  inbox\n\n");
      for (const item of items) {
        out.write(`    ${item.at.slice(0, 16).replace("T", " ")}  ${item.kind}\n`);
        out.write(`      ${item.title}\n`);
        out.write(`      ${item.detail.split("\n")[0] ?? ""}\n`);
        if (item.requestId) out.write(`      /trace ${shortId(item.requestId)}\n`);
        out.write("\n");
      }
      if (args[0] === "clear") out.write(`  cleared ${clearInbox(opts.workspace)}\n\n`);
      else out.write("  /inbox clear to empty it.\n\n");
      return session;
    }

    case "status": {
      out.write("\n  status\n\n");
      for (const entry of describeConfig({ ...session.config, model: opts.model })) {
        out.write(`    ${entry}\n`);
      }
      out.write(`    tokens      ${session.usage.input} in / ${session.usage.output} out\n`);
      out.write("\n  tool groups\n\n");
      const on = new Set(activeGroups(session.tools));
      for (const group of GROUPS) {
        const state = !group.available ? "not configured" : on.has(group.group) ? "on" : "off";
        out.write(`    ${group.label.padEnd(22)} ${state}\n`);
      }
      out.write("\n");
      return session;
    }

    case "trace": {
      const id = args[0] ?? lastRequestId;
      if (!id) {
        out.write("\n  Nothing to show yet — ask something first.\n\n");
        return session;
      }
      const { readTrace } = await import("../observability/trace.js");
      const { home } = await import("../paths.js");
      const trace = readTrace(home(opts.workspace), id);
      out.write(trace ? render(trace) : `\n  No trace matching "${id}".\n\n`);
      return session;
    }

    case "settings":
      out.write(`\n  Settings live in files you can edit:\n\n`);
      out.write(`    ${configFile(opts.workspace)}\n      model, tools, sandbox, approvals\n\n`);
      out.write(`    SOUL.md\n      who the agent is\n\n`);
      out.write(`    GUARDRAILS.md\n      what it should and shouldn't do\n\n`);
      out.write("  Changes to SOUL.md and GUARDRAILS.md apply on the next message.\n");
      out.write(`  Config changes need a restart. \`${launchCommand()} init\` walks through it again.\n\n`);
      return session;

    default:
      out.write(HELP);
      return session;
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
