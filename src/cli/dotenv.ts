// A very small .env reader. Node has --env-file, but that only helps if the
// user remembers to pass it, and `npx vaan` gives them nowhere to put it.
//
// Values already in the real environment win, so an exported key always beats
// a stale one in the file.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(parseEnv(read(join(cwd, ".env"))))) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = /^(".*"|'.*')$/s.test(value) ? value.slice(1, -1) : value;
  }
  return out;
}

/** Add or replace keys in .env, leaving comments and unrelated keys alone. */
export function updateEnvFile(cwd: string, updates: Record<string, string>): string {
  const path = join(cwd, ".env");
  const lines = read(path).split("\n");
  const remaining = { ...updates };

  const merged = lines.map((line) => {
    const eq = line.indexOf("=");
    if (line.trim().startsWith("#") || eq <= 0) return line;
    const key = line.slice(0, eq).trim();
    if (!(key in remaining)) return line;
    const value = remaining[key] as string;
    delete remaining[key];
    return `${key}=${value}`;
  });

  const added = Object.entries(remaining).map(([key, value]) => `${key}=${value}`);
  const body = [...merged, ...added].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  writeFileSync(path, `${body}\n`, "utf8");
  return path;
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
