// First run. Ten steps, and the design rule behind which ones exist.
//
// A question earns its place if getting it wrong is expensive and the right
// answer isn't guessable. Workspace, model, key, and the three security
// questions qualify: nobody can guess whether you want the agent running
// commands unattended. Everything else has a sane default and lives in a file
// you can edit, which is why there is no question about where the database goes.
//
// The security steps come last on purpose. By the time someone is choosing a
// sandbox profile they have seen the agent's name and the model it'll use, and
// the question reads as "how much rope" rather than as paperwork.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  DEFAULT_AGENT_NAME,
  SANDBOX_PROFILES,
  defaultConfig,
  saveConfig,
  type Config,
  type SandboxProfileName,
} from "../config.js";
import { probeFts5 } from "../memory/store.js";
import { ALL_APPROVALS, type ApprovalFlags } from "../permissions/rules.js";
import { GUARDRAILS_FILE, SOUL_FILE, skillsDir } from "../paths.js";
import { DEFAULT_GUARDRAILS, DEFAULT_SOUL } from "../prompt.js";
import { build, isShape, registry, SHAPES, type Shape } from "../providers/index.js";
import { GROUPS } from "../tools/index.js";
import type { ToolGroup } from "../types.js";
import { INSTALL_HINT, launchCommand, viaNpx } from "../invocation.js";
import { updateEnvFile } from "./dotenv.js";
import { CUSTOM_NOTE, DEFAULT_MODEL, SUGGESTED } from "./suggested.js";
import { createTheme, DOT, type Theme } from "./theme.js";

export const VERSION = "0.1.3";

/**
 * Say back what was just chosen.
 *
 * Every step ends with one of these. Without it the onboarding is nine
 * questions and no answers: you press Enter on "keep them all" and the screen
 * moves on, having never told you what "all" turned out to be.
 */
const chose = (out: NodeJS.WriteStream, t: Theme, text: string): void => {
  out.write(`  ${t.lime("✓")} ${t.bright(text)}\n`);
};

/** A numbered option: dim number, readable label, dim note. */
const option = (t: Theme, index: number, label: string, note = "", width = 26): string =>
  `    ${t.dim(`${index})`)} ${label.padEnd(width)}${note ? t.dim(note) : ""}\n`;

export interface WizardOptions {
  /** Where Vaan was launched. Step one can move it. */
  cwd: string;
  yes: boolean;
  env: NodeJS.ProcessEnv;
}

export interface WizardResult {
  workspace: string;
  config: Config;
}

export async function runWizard(opts: WizardOptions): Promise<WizardResult | undefined> {
  const out = process.stdout;
  const t = createTheme({ env: opts.env });
  out.write(`\n  ${t.bold(t.lime("vaan"))} ${t.dim(VERSION)}\n`);
  out.write(`  ${t.dim("let's get you set up")}\n\n`);

  const fts = probeFts5();
  if (fts) {
    out.write(`  SQLite here is missing FTS5, which Vaan's memory needs.\n  ${fts}\n\n`);
    out.write("  Try: npm install better-sqlite3 --build-from-source\n\n");
    return undefined;
  }

  if (opts.yes) return unattended(opts, out);

  const rl = createInterface({ input: process.stdin, output: out });
  try {
    // 1. Workspace
    const workspace = await askWorkspace(rl, out, t, opts.cwd);
    if (!workspace) return undefined;
    chose(out, t, workspace.replace(homedir(), "~"));
    const config = defaultConfig(workspace);

    // 2. Model  3. Authenticate
    const model = await askModel(rl, out, t, opts, workspace);
    if (!model) return undefined;
    config.model = model;

    // 4. Agent identity
    out.write(`\n  ${t.bright("Agent identity")}\n`);
    config.agentName =
      (await rl.question(`  ${t.dim(`name [${DEFAULT_AGENT_NAME}]`)}  ? `)).trim() ||
      DEFAULT_AGENT_NAME;
    chose(out, t, config.agentName);

    // 5. Memory
    config.memory = await askYesNo(rl, out, t, "Persistent project memory?", true);
    chose(out, t, config.memory ? "memory on" : "memory off");

    // 6. Tools
    config.tools = await askTools(rl, out, t);
    chose(out, t, config.tools.join(", "));

    // 7. Sandbox
    config.sandbox = await askSandbox(rl, out, t);
    chose(out, t, `${config.sandbox.name} sandbox`);
    config.network.allowLocal = config.sandbox.allowLocalNetwork;

    // 8. Permissions
    config.approvals = await askApprovals(rl, out, t);
    const required = Object.entries(config.approvals).filter(([, on]) => on).map(([n]) => n);
    chose(out, t, required.length ? `approval for ${required.join(", ")}` : "no approvals required");

    // 9. Project configuration
    await confirmFile(rl, out, t, opts.env, join(workspace, SOUL_FILE), DEFAULT_SOUL, SOUL_FILE);
    await confirmFile(
      rl,
      out,
      t,
      opts.env,
      join(workspace, GUARDRAILS_FILE),
      DEFAULT_GUARDRAILS,
      GUARDRAILS_FILE,
    );

    saveConfig(workspace, config);
    updateEnvFile(workspace, { VAAN_MODEL: config.model });
    mkdirSync(skillsDir(workspace), { recursive: true });

    out.write(`\n  ${t.dim("checking that works…")} `);
    const problem = await healthCheck(config.model, opts.env);
    if (problem) {
      out.write(`\n\n  ${t.red("that call failed")}\n  ${t.dim(problem)}\n\n`);
      out.write(`  Fix it and run \`${launchCommand()} init\` again.\n\n`);
      return undefined;
    }
    out.write(`${t.lime("ok")}\n`);

    // 10. Ready
    ready(out, t, config);
    return { workspace, config };
  } finally {
    rl.close();
  }
}

/** `--yes`: everything from the environment, no prompts. */
function unattended(opts: WizardOptions, out: NodeJS.WriteStream): WizardResult | undefined {
  const workspace = resolvePath(opts.cwd);
  const usable = registry(opts.env).find((spec) => !spec.envKey || opts.env[spec.envKey]);
  const model =
    opts.env.VAAN_MODEL ?? (usable ? (DEFAULT_MODEL[usable.name] ?? "") : "");
  if (!model) {
    out.write("  --yes needs VAAN_MODEL, or an API key in the environment.\n\n");
    return undefined;
  }

  for (const [name, body] of [
    [SOUL_FILE, DEFAULT_SOUL],
    [GUARDRAILS_FILE, DEFAULT_GUARDRAILS],
  ] as const) {
    const path = join(workspace, name);
    if (!existsSync(path)) writeFileSync(path, body, "utf8");
  }

  const config = defaultConfig(workspace, model);
  saveConfig(workspace, config);
  mkdirSync(skillsDir(workspace), { recursive: true });
  updateEnvFile(workspace, { VAAN_MODEL: model });
  return { workspace, config };
}

// --- Step 1 ------------------------------------------------------------------

async function askWorkspace(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
  cwd: string,
): Promise<string | undefined> {
  out.write(`  ${t.bright("Workspace")}  ${t.dim(`${DOT} everything Vaan can see`)}\n\n`);
  out.write(option(t, 1, "this directory", cwd.replace(homedir(), "~"), 18));
  out.write(option(t, 2, "another directory", "", 18));
  out.write("\n");

  if ((await rl.question(`  ${t.dim("?")} `)).trim() !== "2") return resolvePath(cwd);

  const typed = (await rl.question(`\n  ${t.dim("path")}  ? `)).trim();
  if (!typed) return undefined;
  const chosen = isAbsolute(typed) ? typed : resolvePath(cwd, typed);
  if (!existsSync(chosen)) {
    out.write(`\n  ${t.red(`${chosen} does not exist`)}\n\n`);
    return undefined;
  }
  // Everything Vaan may touch is decided from here, so it is resolved once and
  // never recomputed from a relative path later.
  return resolvePath(chosen);
}

// --- Steps 2 and 3 -----------------------------------------------------------

async function askModel(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
  opts: WizardOptions,
  workspace: string,
): Promise<string | undefined> {
  out.write(`\n  ${t.bright("Model")}  ${t.dim(`${DOT} cloud or local, no lock-in`)}\n\n`);
  SUGGESTED.forEach((entry, index) => {
    out.write(option(t, index + 1, entry.spec, entry.note, 28));
  });
  out.write(option(t, SUGGESTED.length + 1, "custom", CUSTOM_NOTE, 28));
  out.write(`\n  ${t.dim("a number, or type any provider/model")}\n\n`);

  const answer = (await rl.question(`  ${t.dim("?")} `)).trim();
  const picked = SUGGESTED[Number(answer) - 1];

  let spec: string;
  if (picked) spec = picked.spec;
  else if (Number(answer) === SUGGESTED.length + 1) {
    const custom = await askCustomProvider(rl, out, t, opts, workspace);
    if (!custom) return undefined;
    spec = custom;
  } else if (answer.includes("/")) {
    // Anything with a prefix is a model name, passed through untouched. The
    // numbers are a convenience, not a list of what's allowed.
    spec = answer;
  } else {
    out.write(`\n  ${t.red("not one of the numbers, and not a provider/model string")}\n\n`);
    return undefined;
  }

  chose(out, t, spec);
  const key = await askKey(rl, out, t, opts, workspace, spec);
  return key === false ? undefined : spec;
}

async function askCustomProvider(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
  opts: WizardOptions,
  workspace: string,
): Promise<string | undefined> {
  out.write(`\n  ${t.bright("API shape")}\n\n`);
  SHAPES.forEach((entry, index) => {
    out.write(option(t, index + 1, entry.endpoint, entry.note, 30));
  });
  out.write("\n");

  const chosen = SHAPES[Number((await rl.question(`  ${t.dim("?")} `)).trim()) - 1];
  const shape: Shape = chosen && isShape(chosen.shape) ? chosen.shape : "openai";

  const name = (await rl.question("\n  A short name for it  ? ")).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    out.write("\n  Names must be letters, digits and underscores.\n\n");
    return undefined;
  }
  const baseUrl = (await rl.question("  Base URL  ? ")).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    out.write("\n  That doesn't look like a URL.\n\n");
    return undefined;
  }
  const model = (await rl.question("  Model name  ? ")).trim();
  if (!model) return undefined;

  const registration = `VAAN_PROVIDER_${name.toUpperCase()}`;
  const keyVar = `${name.toUpperCase()}_API_KEY`;
  opts.env[registration] = `${shape}:${baseUrl}`;
  if (!opts.env[keyVar]) {
    const key = await askSecret(rl, out, "  API key (blank if it needs none)  ? ");
    opts.env[keyVar] = key || "none";
  }
  updateEnvFile(workspace, {
    [registration]: `${shape}:${baseUrl}`,
    [keyVar]: opts.env[keyVar] as string,
  });
  out.write(`\n  saved to .env as ${registration}\n`);
  return `${name}/${model}`;
}

/** Returns the env var written, `undefined` if none was needed, `false` to abort. */
async function askKey(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
  opts: WizardOptions,
  workspace: string,
  spec: string,
): Promise<string | undefined | false> {
  const name = spec.slice(0, spec.indexOf("/")).toLowerCase();
  const found = registry(opts.env).find((entry) => entry.name === name);
  if (!found?.envKey) {
    out.write(`  ${t.lime("✓")} ${t.dim("no API key required")}\n`);
    return undefined;
  }
  // An existing key is offered for replacement rather than silently skipped.
  // Skipping makes `vaan init` a dead end for the one thing people re-run it
  // for: the key expired, was rotated, or belongs to the wrong account.
  const existing = [found.envKey, ...(found.altEnvKeys ?? [])].find(
    (candidate) => opts.env[candidate],
  );
  if (existing) {
    out.write(
      `\n  ${t.bright("Credentials")}  ${t.dim(`${DOT} ${existing} is set${fingerprint(opts.env[existing])}`)}\n`,
    );
    if (!(await askYesNo(rl, out, t, "Replace it?", false))) {
      chose(out, t, `keeping ${existing}`);
      return existing;
    }
  }

  const key = await askSecret(
    rl,
    out,
    `\n  ${t.dim(`${existing ? "new " : ""}${label(name)} API key`)}  ? `,
  );
  if (!key) {
    out.write(
      `\n  ${t.red("no key, no calls")} ${t.dim(`${DOT} set one and run \`${launchCommand()} init\` again`)}\n\n`,
    );
    return false;
  }
  opts.env[found.envKey] = key;
  // Clear any alternate name, or the old key could win on the next run.
  for (const alternate of found.altEnvKeys ?? []) delete opts.env[alternate];
  updateEnvFile(workspace, { [found.envKey]: key });
  out.write(`  ${t.lime("✓")} ${t.dim(`saved to .env as ${found.envKey}`)}\n`);
  return found.envKey;
}

const label = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * Enough of a key to tell which one it is, and not enough to be worth having.
 * Without this, "already set" is unanswerable: set to what?
 */
function fingerprint(key: string | undefined): string {
  if (!key || key.length < 8) return "";
  return ` (…${key.slice(-4)})`;
}

// --- Steps 5 to 8 ------------------------------------------------------------

async function askYesNo(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
  question: string,
  fallback: boolean,
): Promise<boolean> {
  out.write(`\n  ${t.bright(question)}\n\n`);
  out.write(
    fallback
      ? `    ${t.lime("Y")} yes   ${t.dim("n")} no\n\n`
      : `    ${t.dim("y")} yes   ${t.lime("N")} no\n\n`,
  );
  const answer = (await rl.question(`  ${t.dim("?")} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

async function askTools(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
): Promise<ToolGroup[]> {
  out.write(`\n  ${t.bright("Tools")}  ${t.dim(`${DOT} a group you turn off does not exist`)}\n\n`);
  const available = GROUPS.filter((group) => group.available);
  available.forEach((group, index) => {
    out.write(
      `    ${t.dim(`${index + 1})`)} ${t.lime("[x]")} ${group.label.padEnd(22)}${t.dim(group.note)}\n`,
    );
  });
  for (const group of GROUPS.filter((entry) => !entry.available)) {
    out.write(`       ${t.faint("[ ]")} ${t.faint(group.label.padEnd(22))}${t.faint(group.note)}\n`);
  }
  out.write(`\n  ${t.dim("enter to keep them all, or numbers to turn off (e.g. 3 5)")}\n\n`);

  const answer = (await rl.question(`  ${t.dim("?")} `)).trim();
  if (!answer) return available.map((group) => group.group);

  const off = new Set(
    answer
      .split(/[\s,]+/)
      .map((token) => Number(token))
      .filter((index) => Number.isInteger(index)),
  );
  return available.filter((_, index) => !off.has(index + 1)).map((group) => group.group);
}

async function askSandbox(rl: Interface, out: NodeJS.WriteStream, t: Theme) {
  out.write(`\n  ${t.bright("Coding sandbox")}  ${t.dim(`${DOT} where commands run`)}\n\n`);
  out.write(option(t, 1, "restricted", "every command re-approved, 60s limit  (default)", 12));
  out.write(option(t, 2, "standard", "repeat commands remembered, 5m limit", 12));
  out.write(option(t, 3, "custom", "edit .vaan/config/config.json yourself", 12));
  out.write("\n");

  const answer = (await rl.question(`  ${t.dim("?")} `)).trim();
  const name: SandboxProfileName =
    answer === "2" ? "standard" : answer === "3" ? "custom" : "restricted";
  if (name === "custom") {
    return { ...SANDBOX_PROFILES.restricted, name: "custom" as const };
  }
  return SANDBOX_PROFILES[name];
}

const APPROVAL_LABELS: { key: keyof ApprovalFlags; label: string }[] = [
  { key: "destructive", label: "Destructive commands" },
  { key: "network", label: "External network actions" },
  { key: "credentials", label: "Credential access" },
  { key: "outside", label: "Files outside workspace" },
  { key: "system", label: "System changes" },
];

async function askApprovals(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
): Promise<ApprovalFlags> {
  out.write(`\n  ${t.bright("Require approval for")}\n\n`);
  APPROVAL_LABELS.forEach((entry, index) => {
    out.write(`    ${t.dim(`${index + 1})`)} ${t.lime("[x]")} ${entry.label}\n`);
  });
  out.write(`\n  ${t.dim("enter to keep them all, or numbers to drop")}\n`);
  out.write(`  ${t.faint("credential access and system changes stay denied either way")}\n\n`);

  const answer = (await rl.question(`  ${t.dim("?")} `)).trim();
  const flags = { ...ALL_APPROVALS };
  if (!answer) return flags;

  for (const token of answer.split(/[\s,]+/)) {
    const entry = APPROVAL_LABELS[Number(token) - 1];
    if (entry) flags[entry.key] = false;
  }
  return flags;
}

// --- Step 9 ------------------------------------------------------------------

async function confirmFile(
  rl: Interface,
  out: NodeJS.WriteStream,
  t: Theme,
  env: NodeJS.ProcessEnv,
  path: string,
  body: string,
  label: string,
): Promise<void> {
  if (existsSync(path)) {
    chose(out, t, `${label} already exists, leaving it alone`);
    return;
  }
  out.write(`\n  ${t.bright(label)}  ${t.dim(`${DOT} yours to edit, applies on the next message`)}\n`);
  out.write(`\n${t.faint(body.replace(/^/gm, "  "))}\n`);
  const answer = (
    await rl.question(
      `  ${t.dim("write this?")}  ${t.bright("[Y]")} yes  ${t.bright("[e]")} edit  ${t.bright("[n]")} skip  `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === "n") {
    chose(out, t, `skipped ${label}`);
    return;
  }
  writeFileSync(path, body, "utf8");
  if (answer === "e") {
    const editor = env.VISUAL ?? env.EDITOR ?? "nano";
    spawnSync(editor, [path], { stdio: "inherit" });
  }
  chose(out, t, `wrote ${label}`);
}

// --- Step 10 -----------------------------------------------------------------

function ready(out: NodeJS.WriteStream, t: Theme, config: Config): void {
  const row = (label: string, value: string): string =>
    `  ${t.dim(label.padEnd(11))}${t.bright(value)}\n`;

  out.write(`\n  ${t.lime("✓")} ${t.bold(t.bright(`${config.agentName} is ready`))}\n\n`);
  out.write(row("workspace", config.workspace.replace(homedir(), "~")));
  out.write(row("model", config.model));
  out.write(row("memory", config.memory ? "on" : "off"));
  out.write(row("sandbox", config.sandbox.name));
  out.write(row("tools", config.tools.join(", ")));
  out.write("\n");
  // Nothing is on PATH after npx, and finding that out tomorrow is worse than
  // finding it out now.
  if (viaNpx()) out.write(`  ${INSTALL_HINT}\n\n`);
}

/** One small call, so a bad key fails here instead of three turns into a REPL. */
async function healthCheck(spec: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const slash = spec.indexOf("/");
    const name = spec.slice(0, slash);
    const found = registry(env).find((entry) => entry.name === name);
    if (!found) return `Unknown provider "${name}".`;
    await build(found, env).generate({
      model: spec.slice(slash + 1),
      system: "",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 8,
    });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * readline has no built-in masking; suppressing its echo is the usual trick.
 *
 * The order below is load-bearing. Writing the prompt with `out.write` and then
 * calling `rl.question("")` looks equivalent and is not: `question` sets the
 * prompt, refreshes the line — `ESC[1G ESC[0J`, cursor to column one and clear
 * — and so erases the prompt that was just written. The user gets a blank line
 * and no idea they are being asked for a key.
 *
 * So `question` prints the prompt itself, and masking goes on immediately
 * after. `question` writes synchronously before it returns its promise, which
 * is what makes that safe.
 */
async function askSecret(rl: Interface, out: NodeJS.WriteStream, prompt: string): Promise<string> {
  const pending = rl.question(prompt);
  const internals = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = internals._writeToOutput;
  internals._writeToOutput = () => {};
  try {
    return (await pending).trim();
  } finally {
    internals._writeToOutput = original;
    out.write("\n");
  }
}
