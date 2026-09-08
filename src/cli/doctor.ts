// `vaan doctor` — is this install actually going to work.
//
// Every check answers a question a user would otherwise discover three turns
// into a conversation: is FTS5 there, is a key set, does the config parse, are
// the two groups that ship empty actually empty. It never calls a model: a
// diagnostic that costs money and needs the network is one people won't run.

import { existsSync } from "node:fs";
import { defaultConfig, describeConfig, loadConfig } from "../config.js";
import { probeFts5 } from "../memory/store.js";
import { describeRules } from "../permissions/policy.js";
import { defaultRules } from "../permissions/rules.js";
import { configFile, databaseFile, home, skillsDir } from "../paths.js";
import { statuses, type Env } from "../providers/index.js";
import { loadSkills } from "../skills.js";
import { GROUPS } from "../tools/index.js";
import { listTraces } from "../observability/trace.js";

export interface DoctorOptions {
  workspace: string;
  env: Env & NodeJS.ProcessEnv;
  model?: string;
}

/** Returns the exit code: non-zero when something is actually broken. */
export function runDoctor(out: NodeJS.WriteStream, opts: DoctorOptions): number {
  const problems: string[] = [];
  const line = (ok: boolean | undefined, text: string): void => {
    out.write(`    ${ok === undefined ? " " : ok ? "✓" : "✗"}  ${text}\n`);
  };

  out.write("\n  environment\n\n");
  line(true, `node ${process.version} on ${process.platform}`);
  line(true, `workspace ${opts.workspace}`);

  out.write("\n  memory\n\n");
  const fts = probeFts5();
  if (fts) {
    problems.push("SQLite has no FTS5");
    line(false, `SQLite is missing FTS5 — ${fts}`);
    line(undefined, "fix: npm install better-sqlite3 --build-from-source");
  } else {
    line(true, "SQLite with FTS5");
  }
  line(
    existsSync(databaseFile(opts.workspace)) || undefined,
    existsSync(databaseFile(opts.workspace))
      ? `database at ${databaseFile(opts.workspace)}`
      : "no database yet — it's created on the first turn",
  );

  out.write("\n  providers\n\n");
  const ready = statuses(opts.env);
  for (const spec of ready) {
    const key = spec.envKey ? `${spec.envKey} ${spec.ready ? "set" : "missing"}` : "no key needed";
    line(spec.ready, `${spec.name.padEnd(12)} ${key}`);
  }
  if (!ready.some((spec) => spec.ready)) {
    problems.push("no provider is usable");
  }

  out.write("\n  configuration\n\n");
  const config = loadConfig(opts.workspace);
  if (!config) {
    line(false, `no config at ${configFile(opts.workspace)} — run \`vaan init\``);
    problems.push("not configured");
  } else {
    line(true, "config parses");
    for (const entry of describeConfig(config)) line(undefined, entry);
  }

  out.write("\n  permissions\n\n");
  for (const entry of describeRules(config ? defaultRules(config.approvals) : defaultRules())) {
    line(undefined, entry);
  }
  line(undefined, "credentials and system changes are denied by fixed policy, always");

  out.write("\n  tools\n\n");
  // With no config yet, report what would actually run rather than "off":
  // an unconfigured install still has defaults, and saying otherwise sends
  // people looking for a problem that isn't there.
  const enabled = new Set(config?.tools ?? defaultConfig(opts.workspace).tools);
  for (const group of GROUPS) {
    const state = !group.available
      ? "not configured in this build"
      : enabled.has(group.group)
        ? "on"
        : "off";
    line(group.available && enabled.has(group.group), `${group.label.padEnd(22)} ${state}`);
  }

  const { skills, warnings } = loadSkills(opts.workspace);
  out.write("\n  skills\n\n");
  if (skills.length === 0) {
    line(undefined, `none — drop a SKILL.md in ${skillsDir(opts.workspace)}`);
  } else {
    for (const skill of skills) line(true, `${skill.name.padEnd(22)} ${skill.path}`);
  }
  for (const warning of warnings) line(false, warning);

  out.write("\n  traces\n\n");
  const traces = listTraces(home(opts.workspace), 1);
  line(
    undefined,
    traces.length === 0
      ? "none yet — written to .vaan/traces after each request"
      : `most recent ${traces[0]?.at ?? ""}`,
  );

  out.write(
    problems.length === 0
      ? "\n  all clear\n\n"
      : `\n  ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.join(", ")}\n\n`,
  );
  return problems.length === 0 ? 0 : 1;
}
