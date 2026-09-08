// search. The tool the trace in the README shows first, because it is what an
// agent reaches for before it knows which files matter.
//
// It walks the workspace rather than shelling out to grep or ripgrep: those
// aren't installed everywhere, their flags differ between platforms, and
// spawning one would put an ordinary lookup behind the execute permission for
// no gain. Reading files inside the workspace is already allowed.

import { search, walk } from "../sandbox/filesystem.js";
import type { Tool } from "../types.js";

const MAX_MATCHES = 60;
const MAX_FILES_LISTED = 100;

export const searchWorkspace: Tool = {
  name: "search",
  description:
    "Search the workspace for text and get back matching file paths with line numbers. " +
    "Use this to find where something lives before reading files. Skips node_modules, " +
    ".git, build output and other generated directories.",
  group: "search",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to look for." },
      regex: {
        type: "boolean",
        description: "Treat the query as a regular expression. Default false.",
      },
      path_contains: {
        type: "string",
        description: "Only search files whose path contains this, e.g. \"src/\" or \".ts\".",
      },
    },
    required: ["query"],
  },
  async run(input, ctx) {
    const query = String(input.query ?? "").trim();
    if (!query) return "No query given.";

    await ctx.gate.require(ctx.policy.forPath("search", ".", "read"));

    const glob = input.path_contains === undefined ? undefined : String(input.path_contains);
    const matches = search(ctx.workspace, query, {
      regex: input.regex === true,
      limit: MAX_MATCHES,
      ...(glob ? { glob } : {}),
    });

    ctx.trace.record({
      kind: "sandbox",
      op: "search",
      target: query,
      ok: true,
      detail: `${matches.length} matches`,
    });

    if (matches.length === 0) {
      return `No matches for "${query}". Generated directories are skipped, so try list_files if you expected one there.`;
    }
    const body = matches.map((match) => `${match.path}:${match.line}  ${match.text}`).join("\n");
    return matches.length >= MAX_MATCHES ? `${body}\n[stopped at ${MAX_MATCHES} matches]` : body;
  },
};

export const listFiles: Tool = {
  name: "list_files",
  description:
    "List every file in the workspace, skipping generated directories. Use it to get the " +
    "shape of a project in one call rather than walking it with list_dir.",
  group: "search",
  parameters: {
    type: "object",
    properties: {
      path_contains: { type: "string", description: "Only list paths containing this." },
    },
  },
  async run(input, ctx) {
    await ctx.gate.require(ctx.policy.forPath("list_files", ".", "read"));

    const filter = input.path_contains === undefined ? "" : String(input.path_contains);
    const all: string[] = [];
    for (const path of walk(ctx.workspace)) {
      if (!filter || path.includes(filter)) all.push(path);
      if (all.length > MAX_FILES_LISTED) break;
    }

    ctx.trace.record({
      kind: "sandbox",
      op: "walk",
      target: filter || ".",
      ok: true,
      detail: `${all.length} files`,
    });

    if (all.length === 0) return filter ? `No files match "${filter}".` : "The workspace is empty.";
    const shown = all.slice(0, MAX_FILES_LISTED);
    return (
      shown.sort().join("\n") +
      (all.length > MAX_FILES_LISTED ? `\n[stopped at ${MAX_FILES_LISTED} — narrow with path_contains]` : "")
    );
  },
};
