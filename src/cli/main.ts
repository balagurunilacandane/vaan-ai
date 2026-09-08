#!/usr/bin/env node
// Entry point. Seven commands, and the bare one is the REPL.

import { resolve } from "node:path";
import { defaultConfig, loadConfig } from "../config.js";
import { printReport } from "../eval/report.js";
import { runEvals } from "../eval/runner.js";
import { openMemory } from "../memory/store.js";
import { parseArgs } from "./args.js";
import { runDoctor } from "./doctor.js";
import { loadEnv } from "./dotenv.js";
import { printMemory } from "./memory-cmd.js";
import { runRepl } from "./repl.js";
import { addSchedule, printSchedules, removeSchedule, runSchedule } from "./schedule.js";
import { printTrace, printTraceList } from "./trace-cmd.js";
import { runWizard, VERSION } from "./wizard.js";

const HELP = `
  Vaan ${VERSION}

    vaan                 start the REPL
    vaan init            run setup again
    vaan memory          print facts and recent turns
    vaan trace [id]      list requests, or show one in full
    vaan doctor          check this install
    vaan eval            run the suites, exit non-zero if they fail
    vaan schedule        list, add, remove or run a scheduled task

  options

    --model <spec>       provider/model for this run, e.g. anthropic/claude-opus-5
    --workspace <path>   work somewhere other than the current directory
    --no-memory          don't read or write memory this session
    --no-trace           don't write a trace file this session
    --yes                grant every permission without asking
    --help, --version

  In the REPL:  /model  /new  /memory  /forget  /inbox  /status  /trace  /settings  /exit
`;

async function main(argv: string[]): Promise<number> {
  const out = process.stdout;
  const args = parseArgs(argv);
  const workspace = resolve(args.workspace ?? process.cwd());
  loadEnv(workspace);

  if (args.help) {
    out.write(HELP);
    return 0;
  }
  if (args.version) {
    out.write(`${VERSION}\n`);
    return 0;
  }

  const stored = loadConfig(workspace);
  // Precedence: the flag, then the environment, then what setup decided.
  const model = args.model ?? process.env.VAAN_MODEL ?? stored?.model;

  switch (args.command) {
    case "memory": {
      const store = openMemory({ dir: workspace, turnLimit: 10 });
      printMemory(out, await store.recall(workspace, ""));
      store.close?.();
      return 0;
    }

    case "trace":
      return args.rest[0]
        ? printTrace(out, workspace, args.rest[0])
        : printTraceList(out, workspace);

    case "doctor":
      return runDoctor(out, {
        workspace,
        env: process.env,
        ...(model ? { model } : {}),
      });

    case "eval": {
      if (!model) return unconfigured(out);
      const report = await runEvals({ workspace, model, env: process.env });
      printReport(out, report);
      return report.passed ? 0 : 1;
    }

    case "schedule": {
      const [sub, id] = args.rest;
      if (!sub) return printSchedules(out, workspace);
      if (sub === "add") return addSchedule(out, workspace);
      if (sub === "remove" && id) return removeSchedule(out, workspace, id);
      if (sub === "run" && id) {
        if (!model) return unconfigured(out);
        return runSchedule(out, id, { workspace, env: process.env, model, yes: args.yes });
      }
      out.write("\n  vaan schedule [add | run <id> | remove <id>]\n\n");
      return 1;
    }

    case "repl":
    case "init":
      break;

    default:
      out.write(`\n  Unknown command "${args.command}".\n${HELP}`);
      return 1;
  }

  // Setup needs a person at the keyboard. Say so and leave, rather than
  // blocking forever on a prompt that nothing is going to answer.
  const needsSetup = args.command === "init" || !model;
  if (!process.stdin.isTTY && (needsSetup ? !args.yes : true)) {
    out.write(
      needsSetup
        ? "\n  Vaan needs a terminal to set up. Run it interactively, or pass --yes with\n" +
            "  VAAN_MODEL and an API key already in the environment.\n\n"
        : "\n  Vaan is a REPL and needs a terminal. It doesn't read piped input.\n\n",
    );
    return 1;
  }

  let config = stored ?? defaultConfig(workspace, model ?? "");
  if (needsSetup) {
    const result = await runWizard({ cwd: workspace, yes: args.yes, env: process.env });
    if (!result) return 1;
    config = result.config;
    if (args.command === "init") return 0;
  }

  return runRepl({
    workspace: config.workspace,
    model: args.model ?? config.model,
    config,
    memory: args.memory && config.memory,
    yes: args.yes,
    trace: args.trace,
    env: process.env,
  });
}

function unconfigured(out: NodeJS.WriteStream): number {
  out.write("\n  No model configured. Run `vaan init` first.\n\n");
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(1);
  },
);
