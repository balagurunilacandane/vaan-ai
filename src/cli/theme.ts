// Colour and glyphs for the REPL.
//
// One rule: everything degrades. Piped into a file, read by a screen reader,
// or running under NO_COLOR, the output must still be readable text — so colour
// is only ever decoration on top of a line that already says what it means. A
// tool call prints its name whether or not the dot before it is green.
//
// 256-colour rather than truecolor: the palette below is close enough at 8-bit,
// and 256 is supported by every terminal anyone still uses, including tmux and
// Windows Terminal without extra configuration.

export interface Theme {
  lime(text: string): string;
  bright(text: string): string;
  dim(text: string): string;
  faint(text: string): string;
  red(text: string): string;
  bold(text: string): string;
  enabled: boolean;
}

const code = (value: string) => (text: string): string => `[${value}m${text}[0m`;

const COLOUR: Omit<Theme, "enabled"> = {
  lime: code("38;5;149"),
  bright: code("38;5;255"),
  dim: code("38;5;243"),
  faint: code("38;5;239"),
  red: code("38;5;210"),
  bold: code("1"),
};

const PLAIN: Omit<Theme, "enabled"> = {
  lime: (text) => text,
  bright: (text) => text,
  dim: (text) => text,
  faint: (text) => text,
  red: (text) => text,
  bold: (text) => text,
};

export interface ThemeOptions {
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Colour when there's a terminal to colour, plain text otherwise.
 *
 * `NO_COLOR` is honoured whatever its value — that's the convention, and the
 * people who set it mean it.
 */
export function createTheme(opts: ThemeOptions = {}): Theme {
  const env = opts.env ?? process.env;
  const on =
    (opts.isTTY ?? process.stdout.isTTY ?? false) &&
    env.NO_COLOR === undefined &&
    env.TERM !== "dumb";
  return { ...(on ? COLOUR : PLAIN), enabled: on };
}

/** Marks a step the agent took. */
export const STEP = "⏺";
/** Marks something waiting on you. */
export const ASK = "⚠";
/** Separates facts on one line. */
export const DOT = "·";

/** `1.2s`, `340ms` — whichever reads better at that magnitude. */
export const duration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

/** `12.4k`, `940` — token counts, short enough for a status line. */
export const tokens = (count: number): string =>
  count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`;

export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/**
 * The most useful thing about a tool call, in a few characters.
 *
 * Which argument that is depends on the tool, and guessing by position would
 * be wrong as soon as a tool grew an option. These are the arguments worth
 * showing, in the order they're worth showing.
 */
const INTERESTING = ["path", "query", "command", "url", "fact", "old_text"];

export function describeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of INTERESTING) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value, 46);
  }
  return "";
}

/**
 * What a tool result amounts to. Short output speaks for itself; long output
 * gets counted, because forty lines of a file scrolling past is not a summary.
 */
export function summariseOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "no output";
  const lines = trimmed.split("\n");
  const first = lines[0] ?? "";
  if (lines.length === 1) return clip(first, 56);
  return `${lines.length} lines`;
}
