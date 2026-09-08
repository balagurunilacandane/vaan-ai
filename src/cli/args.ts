// Argument parsing, extracted so it can be tested.
//
// It lived inline in main.ts and had a bug that every unit test missed: with
// no `--model` flag, `indexOf` returns -1, so `argv[index + 1]` read argv[0]
// and swallowed the command. `vaan memory` silently became `vaan`. Hence this
// file, and test/cli.test.ts.

/** Flags that take a value, so the value is never mistaken for the command. */
const VALUED = ["--model", "--workspace"] as const;

export interface Args {
  /** `repl`, `init`, `eval`, `memory`, `trace`, `doctor`, `schedule`, or whatever was typed. */
  command: string;
  /** Positionals after the command, e.g. the id in `vaan trace 7f3e9b4a`. */
  rest: string[];
  model?: string;
  workspace?: string;
  yes: boolean;
  memory: boolean;
  trace: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((arg) => arg.startsWith("-")));

  // Track each valued flag's *position*, not just its value: -1 means the flag
  // is absent, and index 0 is a perfectly good place for a command to be.
  const consumed = new Set<number>();
  const values: Record<string, string | undefined> = {};
  for (const flag of VALUED) {
    const at = argv.indexOf(flag);
    if (at === -1) continue;
    consumed.add(at + 1);
    values[flag] = argv[at + 1];
  }

  const positionals = argv.filter(
    (arg, index) => !arg.startsWith("-") && !consumed.has(index),
  );
  const [command = "repl", ...rest] = positionals;

  const model = values["--model"];
  const workspace = values["--workspace"];

  return {
    command,
    rest,
    ...(model ? { model } : {}),
    ...(workspace ? { workspace } : {}),
    yes: flags.has("--yes") || flags.has("-y"),
    memory: !flags.has("--no-memory"),
    trace: !flags.has("--no-trace"),
    help: flags.has("--help") || flags.has("-h") || command === "help",
    version: flags.has("--version") || flags.has("-v"),
  };
}
