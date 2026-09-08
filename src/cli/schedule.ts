// `vaan schedule` — recurring work, without a daemon.
//
// Two decisions worth stating, because both are deliberate.
//
// First, there is no Vaan service. A background process that holds your API key
// and can write to your project is a thing you have to trust around the clock;
// the operating system already has a scheduler you trust, so Vaan stores the
// task and hands you the one line that installs it. It runs when cron runs it,
// as you, and not otherwise.
//
// Second, Vaan does not install that line itself. Editing a crontab is a system
// change, and system changes are denied by fixed policy in
// src/permissions/rules.ts — including to the CLI. An agent that exempts itself
// from its own floor doesn't have a floor. So the command is printed and you
// run it.
//
// A scheduled run has nobody to ask for permission, so nothing that needs
// approval happens: it lands in the inbox instead, and `/inbox` shows it the
// next time you're at the keyboard.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config.js";
import { addItem } from "../inbox.js";
import { createSession } from "../index.js";
import { shortId } from "../observability/request.js";
import { stateDir } from "../paths.js";
import type { Env } from "../providers/index.js";

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  /** Standard five-field cron, e.g. "0 9 * * 1-5". */
  cron: string;
  createdAt: string;
  lastRunAt?: string;
}

const file = (workspace: string): string => join(stateDir(workspace), "schedules.json");

export function readSchedules(workspace: string): Schedule[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(workspace), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isSchedule) : [];
  } catch {
    return [];
  }
}

export function writeSchedules(workspace: string, schedules: Schedule[]): void {
  mkdirSync(stateDir(workspace), { recursive: true });
  writeFileSync(file(workspace), `${JSON.stringify(schedules, null, 2)}\n`, "utf8");
}

const isSchedule = (value: unknown): value is Schedule =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Schedule).id === "string" &&
  typeof (value as Schedule).prompt === "string";

/** The line the user runs to hand this to their own scheduler. */
export function installCommand(workspace: string, schedule: Schedule): string {
  if (process.platform === "win32") {
    const [minute = "0", hour = "9"] = schedule.cron.split(" ");
    return (
      `schtasks /create /tn "vaan-${schedule.name}" /tr ` +
      `"cmd /c cd /d ${workspace} && vaan schedule run ${shortId(schedule.id)}" ` +
      `/sc daily /st ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
    );
  }
  return `${schedule.cron} cd ${workspace} && vaan schedule run ${shortId(schedule.id)}`;
}

export function printSchedules(out: NodeJS.WriteStream, workspace: string): number {
  const schedules = readSchedules(workspace);
  if (schedules.length === 0) {
    out.write("\n  Nothing scheduled.\n\n  vaan schedule add   to create one.\n\n");
    return 0;
  }

  out.write("\n  scheduled\n\n");
  for (const schedule of schedules) {
    out.write(`    ${shortId(schedule.id)}  ${schedule.cron.padEnd(16)} ${schedule.name}\n`);
    out.write(`              ${clip(schedule.prompt, 68)}\n`);
    out.write(
      `              last run ${schedule.lastRunAt ? schedule.lastRunAt.slice(0, 16).replace("T", " ") : "never"}\n\n`,
    );
  }
  out.write("  vaan schedule run <id>      run one now\n");
  out.write("  vaan schedule remove <id>   forget it\n\n");
  return 0;
}

export async function addSchedule(out: NodeJS.WriteStream, workspace: string): Promise<number> {
  if (!process.stdin.isTTY) {
    out.write("\n  Adding a schedule needs a terminal.\n\n");
    return 1;
  }
  const rl = createInterface({ input: process.stdin, output: out });
  try {
    const name = (await rl.question("\n  A short name  ? ")).trim().replace(/\s+/g, "-");
    if (!name) return leave(out, "No name, no schedule.");

    const prompt = (await rl.question("\n  What should Vaan do?\n\n  ? ")).trim();
    if (!prompt) return leave(out, "No task, no schedule.");

    out.write("\n  When?  cron, five fields\n\n");
    out.write("    0 9 * * 1-5      weekdays at 09:00\n");
    out.write("    0 * * * *        hourly\n");
    out.write("    30 18 * * 5      Fridays at 18:30\n\n");
    const cron = (await rl.question("  ? ")).trim() || "0 9 * * 1-5";
    if (cron.split(/\s+/).length !== 5) return leave(out, "That isn't five cron fields.");

    const schedule: Schedule = {
      id: randomUUID(),
      name,
      prompt,
      cron,
      createdAt: new Date().toISOString(),
    };
    writeSchedules(workspace, [...readSchedules(workspace), schedule]);

    out.write(`\n  Saved as ${shortId(schedule.id)}.\n\n`);
    out.write("  Vaan doesn't install this itself — editing a scheduler is a system change,\n");
    out.write("  and those are denied by fixed policy. Add it yourself:\n\n");
    out.write(
      process.platform === "win32"
        ? `    ${installCommand(workspace, schedule)}\n\n`
        : `    crontab -e\n\n    ${installCommand(workspace, schedule)}\n\n`,
    );
    return 0;
  } finally {
    rl.close();
  }
}

export function removeSchedule(out: NodeJS.WriteStream, workspace: string, query: string): number {
  const schedules = readSchedules(workspace);
  const remaining = schedules.filter((entry) => !entry.id.startsWith(query.toLowerCase()));
  if (remaining.length === schedules.length) {
    out.write(`\n  No schedule matching "${query}".\n\n`);
    return 1;
  }
  writeSchedules(workspace, remaining);
  out.write(`\n  Removed ${schedules.length - remaining.length}.\n\n`);
  return 0;
}

export interface RunOptions {
  workspace: string;
  env: Env & NodeJS.ProcessEnv;
  model: string;
  /** Approve writes and commands with nobody watching. The user's explicit call. */
  yes: boolean;
}

/** Run one schedule now. Nothing interactive: the result goes to the inbox. */
export async function runSchedule(
  out: NodeJS.WriteStream,
  query: string,
  opts: RunOptions,
): Promise<number> {
  const schedules = readSchedules(opts.workspace);
  const schedule = schedules.find((entry) => entry.id.startsWith(query.toLowerCase()));
  if (!schedule) {
    out.write(`\n  No schedule matching "${query}".\n\n`);
    return 1;
  }

  const config = loadConfig(opts.workspace);
  const session = createSession({
    workspace: opts.workspace,
    model: opts.model,
    ...(config ? { config } : {}),
    env: opts.env,
    yes: opts.yes,
  });

  // Without `--yes` there is nobody to approve anything, so the gate refuses
  // and the model is told so. That is the safe default for unattended work.
  let blocked = false;

  try {
    const result = await session.ask(schedule.prompt, {
      onEvent: (event) => {
        if (event.type === "tool_result" && event.isError && /Not permitted/.test(event.output)) {
          blocked = true;
        }
      },
    });

    schedule.lastRunAt = new Date().toISOString();
    writeSchedules(opts.workspace, schedules);

    addItem(opts.workspace, {
      kind: blocked ? "needs-approval" : "scheduled",
      title: `${schedule.name} ran`,
      detail: result.text,
      requestId: result.requestId,
    });

    out.write(`\n  ${schedule.name}: ${result.requestId}\n\n${result.text}\n\n`);
    return 0;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    addItem(opts.workspace, {
      kind: "failed",
      title: `${schedule.name} failed`,
      detail,
    });
    out.write(`\n  ${schedule.name} failed: ${detail}\n\n`);
    return 1;
  } finally {
    session.close();
  }
}

function leave(out: NodeJS.WriteStream, message: string): number {
  out.write(`\n  ${message}\n\n`);
  return 1;
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max)}…`;
};
