// How Vaan was launched, so error messages tell you something that works.
//
// `npx vaan-ai` runs the CLI out of a temporary cache directory and puts
// nothing on your PATH. Telling that user to "run `vaan init` again" sends them
// straight to `command not found`, which is the first thing anyone trying Vaan
// for the first time would hit. So messages ask here rather than assuming.

import { sep } from "node:path";

export const PACKAGE = "vaan-ai";
export const COMMAND = "vaan";

/** True when this process was started by `npx` / `npm exec`. */
export function viaNpx(argv: string[] = process.argv, env = process.env): boolean {
  // npx resolves the bin inside <cache>/_npx/<hash>/node_modules/.bin.
  const script = argv[1] ?? "";
  if (script.includes(`${sep}_npx${sep}`) || script.includes("/_npx/")) return true;
  // Belt and braces: npm sets this for `npm exec`, which is what npx now is.
  return env.npm_command === "exec";
}

/**
 * What to type to run Vaan again — `vaan` when it's installed, the full
 * `npx vaan-ai` when it isn't.
 */
export function launchCommand(argv: string[] = process.argv, env = process.env): string {
  return viaNpx(argv, env) ? `npx ${PACKAGE}` : COMMAND;
}

/** Shown once setup finishes, when `vaan` won't be there next time. */
export const INSTALL_HINT =
  `You ran this with npx, so \`${COMMAND}\` isn't on your PATH — next time it's ` +
  `\`npx ${PACKAGE}\` again.\n  To keep it: npm install -g ${PACKAGE}`;
