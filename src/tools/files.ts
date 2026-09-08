// read_file, list_dir, write_file, edit_file.
//
// Every one of them goes through two gates, and they answer different
// questions. `jail` answers *where*: the path is resolved against the workspace
// and rejected if it lands outside, symlinks included. The permission gate
// answers *whether*: reading inside the workspace is free, changing anything
// asks. Only after both does the user see the diff and decide.

import { mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { jail, listEntries, readText, writeText } from "../sandbox/filesystem.js";
import type { Tool, ToolContext } from "../types.js";
import { readIfExists } from "./shared.js";

const MAX_DIFF_LINES = 40;

const show = (workspace: string, path: string): string => relative(workspace, path) || ".";

export const readFile: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the workspace. Paths are relative to it. " +
    "Large files are truncated.",
  group: "files",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the workspace." } },
    required: ["path"],
  },
  async run(input, ctx) {
    const path = String(input.path ?? "");
    await ctx.gate.require(ctx.policy.forPath("read_file", path, "read"));

    const result = readText(ctx.workspace, path);
    ctx.trace.record({ kind: "sandbox", op: "read", target: path, ok: true });
    return result.truncated
      ? `${result.text}\n\n[truncated — ${result.bytes} bytes total]`
      : result.text;
  },
};

export const listDir: Tool = {
  name: "list_dir",
  description:
    "List the entries of a directory inside the workspace. " +
    "Directories are shown with a trailing slash.",
  group: "files",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path. Defaults to the workspace root." },
    },
  },
  async run(input, ctx) {
    const path = String(input.path ?? ".");
    await ctx.gate.require(ctx.policy.forPath("list_dir", path, "read"));

    const target = jail(ctx.workspace, path);
    const { entries, more } = listEntries(ctx.workspace, path);
    ctx.trace.record({ kind: "sandbox", op: "list", target: path, ok: true });
    if (entries.length === 0) return `${show(ctx.workspace, target)} is empty.`;
    return entries.join("\n") + (more > 0 ? `\n[${more} more entries]` : "");
  },
};

export const writeFile: Tool = {
  name: "write_file",
  description:
    "Write a UTF-8 text file inside the workspace, replacing it if it exists. " +
    "The user is shown a diff and asked to approve before anything is written. " +
    "Prefer edit_file when you are changing part of an existing file.",
  group: "files",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace." },
      content: { type: "string", description: "The complete new contents of the file." },
    },
    required: ["path", "content"],
  },
  async run(input, ctx: ToolContext) {
    const path = String(input.path ?? "");
    const content = String(input.content ?? "");
    return commit(ctx, path, content, "write_file");
  },
};

export const editFile: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file inside the workspace. Use this rather than write_file " +
    "for changes to an existing file: it doesn't require restating the parts you aren't " +
    "changing, so the diff shows only what moved. The old text must appear exactly once " +
    "unless replace_all is true.",
  group: "files",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace." },
      old_text: { type: "string", description: "The exact text to replace, including indentation." },
      new_text: { type: "string", description: "What to put in its place." },
      replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
    },
    required: ["path", "old_text", "new_text"],
  },
  async run(input, ctx: ToolContext) {
    const path = String(input.path ?? "");
    const oldText = String(input.old_text ?? "");
    const newText = String(input.new_text ?? "");
    const all = input.replace_all === true;

    if (!oldText) return "old_text was empty. Use write_file to create a file.";

    // Read through the jail so a path outside the workspace fails here rather
    // than after the user has been asked to approve something.
    await ctx.gate.require(ctx.policy.forPath("edit_file", path, "read"));
    const before = readText(ctx.workspace, path).text;

    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) {
      return `That exact text isn't in ${path}. Read the file again — whitespace and indentation have to match.`;
    }
    if (occurrences > 1 && !all) {
      return (
        `That text appears ${occurrences} times in ${path}. Include enough surrounding lines to ` +
        `make it unique, or pass replace_all.`
      );
    }

    const after = all ? before.split(oldText).join(newText) : before.replace(oldText, newText);
    return commit(ctx, path, after, "edit_file");
  },
};

/** The shared tail of every write: permission, then a diff, then the bytes. */
async function commit(
  ctx: ToolContext,
  path: string,
  content: string,
  tool: string,
): Promise<string> {
  await ctx.gate.require(ctx.policy.forPath(tool, path, "write"));

  const target = jail(ctx.workspace, path);
  const label = show(ctx.workspace, target);
  const before = readIfExists(target);

  if (before === content) return `${label} already has exactly that content. Nothing written.`;

  const approved = await ctx.confirm(
    `${before === undefined ? "Create" : "Modify"} ${label}\n\n${diff(before ?? "", content)}`,
  );
  if (!approved) {
    ctx.trace.record({ kind: "sandbox", op: "write", target: label, ok: false, detail: "declined" });
    return `The user declined the write to ${label}. The file is unchanged.`;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeText(ctx.workspace, path, content);
  const lines = content === "" ? 0 : content.split("\n").length;
  ctx.trace.record({ kind: "sandbox", op: "write", target: label, ok: true, detail: `${lines} lines` });
  return `Wrote ${label} (${lines} lines).`;
}

/**
 * A diff good enough to decide by. Trims the common head and tail and shows
 * what's left. That covers the shape of a normal edit without dragging in a
 * real LCS implementation for a confirmation prompt.
 */
export function diff(before: string, after: string): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const removed = a.slice(head, endA).map((line) => `- ${line}`);
  const added = b.slice(head, endB).map((line) => `+ ${line}`);
  const body = [...removed, ...added];
  if (body.length === 0) return "(no textual change)";

  const shown = body.slice(0, MAX_DIFF_LINES);
  const hidden = body.length - shown.length;
  const context = head > 0 ? [`  … ${head} unchanged line${head === 1 ? "" : "s"} above`] : [];
  return [...context, ...shown, ...(hidden > 0 ? [`  … ${hidden} more changed lines`] : [])].join(
    "\n",
  );
}
