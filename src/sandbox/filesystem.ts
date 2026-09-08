// The filesystem boundary.
//
// Every path a tool is handed is resolved against the workspace and rejected if
// it lands outside. This is the fence. GUARDRAILS.md is instruction; a confused
// model can talk itself past instruction. It cannot talk itself past this.
//
// The permission policy sits above this and decides whether an in-bounds path
// may be written at all. The two are separate on purpose: the jail answers
// "where", the policy answers "may you".

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export class JailError extends Error {
  constructor(candidate: string) {
    super(`"${candidate}" is outside the workspace, so Vaan won't touch it.`);
    this.name = "JailError";
  }
}

/**
 * Resolve `candidate` inside `workspace`, or throw.
 *
 * Two checks, because either alone has a hole. Resolving normalises away `..`,
 * which stops a traversal spelled out in the path. But a symlink inside the
 * workspace can point anywhere, and resolving doesn't follow it — so we also
 * resolve the real path and check that. For a file that doesn't exist yet we
 * check the nearest ancestor that does: components that don't exist can't be
 * symlinks, so if the deepest real ancestor is inside, the new file will be too.
 */
export function jail(workspace: string, candidate: string): string {
  const root = realpathSync(resolve(workspace));
  const target = resolve(root, candidate);
  if (!within(root, target)) throw new JailError(candidate);
  if (!within(root, realpathOfNearest(target))) throw new JailError(candidate);
  return target;
}

/** The same question without the throw, for classification rather than access. */
export function isInside(workspace: string, candidate: string): boolean {
  try {
    jail(workspace, candidate);
    return true;
  } catch {
    return false;
  }
}

const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

function realpathOfNearest(target: string): string {
  let current = target;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      // Hit the filesystem root without finding anything real. Nothing to
      // resolve, and the plain resolve() check above already passed.
      if (parent === current) return current;
      current = parent;
    }
  }
}

export const MAX_READ_BYTES = 100_000;
export const MAX_ENTRIES = 300;

export interface ReadResult {
  text: string;
  bytes: number;
  truncated: boolean;
}

export function readText(workspace: string, path: string): ReadResult {
  const target = jail(workspace, path);
  const { size } = statSync(target);
  const text = readFileSync(target, "utf8");
  return size <= MAX_READ_BYTES
    ? { text, bytes: size, truncated: false }
    : { text: text.slice(0, MAX_READ_BYTES), bytes: size, truncated: true };
}

export function writeText(workspace: string, path: string, content: string): string {
  const target = jail(workspace, path);
  writeFileSync(target, content, "utf8");
  return target;
}

export function listEntries(workspace: string, path: string): { entries: string[]; more: number } {
  const target = jail(workspace, path);
  const all = readdirSync(target, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
  return { entries: all.slice(0, MAX_ENTRIES), more: Math.max(0, all.length - MAX_ENTRIES) };
}

/** Directories that are never worth walking, and never what anyone meant. */
export const IGNORED_DIRS = new Set([
  ".git",
  ".vaan",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".idea",
  ".cache",
  "vendor",
]);

export interface WalkOptions {
  /** Stop after this many files, so a huge tree can't stall a turn. */
  limit?: number;
  maxDepth?: number;
}

/** Every file under `workspace`, skipping the directories nobody greps. */
export function* walk(workspace: string, opts: WalkOptions = {}): Generator<string> {
  const limit = opts.limit ?? 20_000;
  const maxDepth = opts.maxDepth ?? 12;
  const root = realpathSync(resolve(workspace));
  let seen = 0;

  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || next.depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory: not an error, just nothing to report.
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        if (IGNORED_DIRS.has(entry.name) || entry.isDirectory()) continue;
      }
      const full = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push({ dir: full, depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (++seen > limit) return;
      yield relative(root, full);
    }
  }
}

/** Bytes past which a file is assumed to be a build artefact rather than source. */
const MAX_SEARCHABLE_BYTES = 400_000;

export interface Match {
  path: string;
  line: number;
  text: string;
}

/**
 * Grep the workspace. Plain substring by default; a regex when asked, compiled
 * with a length cap so a pathological pattern can't hang the turn.
 */
export function search(
  workspace: string,
  needle: string,
  opts: { regex?: boolean; limit?: number; glob?: string } = {},
): Match[] {
  const limit = opts.limit ?? 60;
  const matcher = opts.regex ? safeRegex(needle) : undefined;
  const lowered = needle.toLowerCase();
  const out: Match[] = [];

  for (const path of walk(workspace)) {
    if (out.length >= limit) break;
    if (opts.glob && !path.includes(opts.glob) && !path.endsWith(opts.glob)) continue;
    let body: string;
    try {
      const full = join(realpathSync(resolve(workspace)), path);
      if (statSync(full).size > MAX_SEARCHABLE_BYTES) continue;
      body = readFileSync(full, "utf8");
    } catch {
      continue; // Binary, unreadable, or gone since the walk. Skip it.
    }
    if (body.includes("\u0000")) continue;

    const lines = body.split("\n");
    for (let index = 0; index < lines.length && out.length < limit; index++) {
      const line = lines[index] ?? "";
      const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(lowered);
      if (hit) out.push({ path, line: index + 1, text: line.trim().slice(0, 200) });
    }
  }
  return out;
}

function safeRegex(pattern: string): RegExp {
  if (pattern.length > 200) throw new Error("Pattern is too long.");
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(`Not a valid regular expression: ${err instanceof Error ? err.message : err}`);
  }
}
