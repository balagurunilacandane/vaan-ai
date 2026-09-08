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

import { createInterface, type Interface } from "node:readline/promises";
import { describeConfig, type Config } from "../config.js";
import { clearInbox, readInbox } from "../inbox.js";
import { createSession, type Session } from "../index.js";
import { shortId } from "../observability/request.js";
import type { PermissionRequest } from "../permissions/rules.js";
import { statuses } from "../providers/index.js";
import { activeGroups, GROUPS } from "../tools/index.js";
import { printMemory } from "./memory-cmd.js";
import { configFile } from "../paths.js";
import { render } from "./trace-cmd.js";

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
  const dim = (text: string) => (out.isTTY ? `${DIM}${text}${RESET}` : text);

  let session: Session;
  try {
    session = open(opts, rl);
  } catch (err) {
    out.write(`\n  ${message(err)}\n\n`);
    rl.close();
    return 1;
  }

  banner(out, opts, session);

  let lastRequestId = "";
  for (;;) {
    const line = (await rl.question("> ")).trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [command = "", ...rest] = line.slice(1).split(/\s+/);
      if (command === "exit" || command === "quit") break;
      try {
        session = await handle(command, rest, session, opts, rl, out, lastRequestId);
      } catch (err) {
        out.write(`  ${message(err)}\n\n`);
      }
      continue;
    }

    const controller = new AbortController();
    const interrupt = () => controller.abort();
    rl.once("SIGINT", interrupt);
    let streamed = false;
    try {
      const result = await session.ask(line, {
        signal: controller.signal,
        onRequest: (request) => {
          lastRequestId = request.id;
          out.write(dim(`  · ${shortId(request.id)}\n`));
        },
        onRecall: (used) =>
          out.write(dim(used ? "  · checking memory\n" : "  · no memory needed\n")),
        onEvent: (event) => {
          if (event.type === "delta") {
            streamed = true;
            out.write(event.text);
          }
          if (event.type === "tool_call") out.write(dim(`${streamed ? "\n" : ""}  · ${event.name}\n`));
          if (event.type === "tool_result" && event.isError) {
            out.write(dim(`    ${event.output.split("\n")[0]}\n`));
          }
        },
      });
      // With streaming on, the text has already been printed as it arrived;
      // printing `result.text` again would double every answer.
      out.write(streamed ? "\n\n" : `${result.text}\n\n`);
    } catch (err) {
      out.write(controller.signal.aborted ? "  interrupted\n\n" : `  ${message(err)}\n\n`);
    } finally {
      rl.off("SIGINT", interrupt);
    }
  }

  session.close();
  rl.close();
  return 0;
}

function banner(out: NodeJS.WriteStream, opts: ReplOptions, session: Session): void {
  out.write(`\n  ✓ ${opts.model}\n`);
  out.write(
    opts.memory
      ? "  ✓ memory on — .vaan/memory/state.db, local only\n"
      : "  ✓ memory off for this session\n",
  );
  out.write(`  ✓ sandbox ${opts.config.sandbox.name} — commands run inside ${opts.workspace}\n`);
  out.write(
    opts.trace
      ? "  ✓ tracing on — .vaan/traces, one file per request\n"
      : "  ✓ tracing off for this session\n",
  );
  out.write(`  ✓ tools — ${activeGroups(session.tools).join(", ")}\n`);
  out.write("  ✓ skills — drop a SKILL.md in .vaan/skills/\n");
  if (opts.yes) out.write("  ! --yes: every permission is granted without asking\n");
  for (const warning of session.warnings) out.write(`  ! ${warning}\n`);

  const pending = readInbox(opts.workspace).length;
  if (pending > 0) out.write(`  ! ${pending} item${pending === 1 ? "" : "s"} in /inbox\n`);
  out.write("\n");
}

function open(opts: ReplOptions, rl: Interface): Session {
  return createSession({
    workspace: opts.workspace,
    model: opts.model,
    config: opts.config,
    memory: opts.memory,
    yes: opts.yes,
    trace: opts.trace,
    stream: true,
    env: opts.env,

    // Whether. The gate calls this, and only a person can answer it.
    approve: async (request: PermissionRequest, reason: string) => {
      process.stdout.write(`\n  Vaan wants to ${verb(request)}:\n\n    ${request.target}\n\n`);
      process.stdout.write(`  Permission:\n    ${request.capability.toUpperCase()}`);
      process.stdout.write(request.detail ? ` — ${request.detail}\n\n` : `\n\n`);
      process.stdout.write(`  ${reason}\n\n`);
      const answer = (await rl.question("  Allow?  [y/N] ")).trim().toLowerCase();
      process.stdout.write("\n");
      return answer === "y" || answer === "yes";
    },

    // What. Every write stops here too: the path, the diff, and one keystroke.
    confirm: async (details) => {
      process.stdout.write(`\n${details}\n\n`);
      const answer = (await rl.question("  Write it?  [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
  });
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
      const replacement = open({ ...opts, model: next }, rl);
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
      out.write("  Config changes need a restart. `vaan init` walks through it again.\n\n");
      return session;

    default:
      out.write(HELP);
      return session;
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
