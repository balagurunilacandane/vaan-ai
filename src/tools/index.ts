// The tool registry, grouped the way the onboarding checkboxes group them.
//
// Groups are the unit the user turns on and off, so they are the unit the
// registry is built from. Turning off `code` removes run_command entirely — the
// model isn't told about a tool it may not use and then refused, it simply
// doesn't have one. A capability that is absent can't be talked into existing.
//
// Two groups ship declared but empty. `browser` would need a real engine, and
// `integrations` would need connectors; both are listed here so the onboarding,
// `/status` and `vaan doctor` can say plainly that they are not configured
// rather than pretending. An empty group is an honest answer; a tool that
// fetches a page and calls itself a browser is not.

import type { Tool, ToolGroup } from "../types.js";
import { now, remember } from "./basics.js";
import { runCommandTool } from "./code.js";
import { editFile, listDir, readFile, writeFile } from "./files.js";
import { gitDiff, gitLog, gitStatus } from "./git.js";
import { listFiles, searchWorkspace } from "./grep.js";
import { defaultSearchProvider, webFetch, webSearch, type SearchProvider } from "./web.js";

export interface GroupInfo {
  group: ToolGroup;
  label: string;
  note: string;
  /** False when the group exists but ships no tools in this build. */
  available: boolean;
}

export const GROUPS: GroupInfo[] = [
  { group: "files", label: "Files", note: "read, write and edit inside the workspace", available: true },
  { group: "search", label: "Search", note: "find text and files in the workspace", available: true },
  { group: "git", label: "Git", note: "status, diff and log — read-only", available: true },
  { group: "web", label: "Web", note: "search and fetch public pages", available: true },
  { group: "code", label: "Code execution", note: "run commands in the sandbox", available: true },
  { group: "memory", label: "Memory", note: "remember durable facts about you", available: true },
  { group: "browser", label: "Browser", note: "not configured in this build", available: false },
  {
    group: "integrations",
    label: "External integrations",
    note: "not configured in this build",
    available: false,
  },
];

export const DEFAULT_GROUPS: ToolGroup[] = GROUPS.filter((entry) => entry.available).map(
  (entry) => entry.group,
);

export interface ToolsetOptions {
  /** Which groups are switched on. Defaults to every available group. */
  groups?: ToolGroup[];
  /** Override the search backend. Tests pass a stub; nothing else needs this. */
  search?: SearchProvider;
}

export function builtinTools(opts: ToolsetOptions = {}): Tool[] {
  const enabled = new Set(opts.groups ?? DEFAULT_GROUPS);
  const all: Tool[] = [
    now,
    readFile,
    listDir,
    writeFile,
    editFile,
    searchWorkspace,
    listFiles,
    gitStatus,
    gitDiff,
    gitLog,
    webSearch(opts.search ?? defaultSearchProvider()),
    webFetch,
    runCommandTool,
    remember,
  ];
  return all.filter((tool) => enabled.has(tool.group));
}

/** Which groups actually produced tools, for `/status` and the startup lines. */
export function activeGroups(tools: Tool[]): ToolGroup[] {
  return [...new Set(tools.map((tool) => tool.group))];
}

export { now, remember } from "./basics.js";
export { runCommandTool } from "./code.js";
export { diff, editFile, listDir, readFile, writeFile } from "./files.js";
export { gitDiff, gitLog, gitStatus } from "./git.js";
export { listFiles, searchWorkspace } from "./grep.js";
export { jail, JailError } from "../sandbox/filesystem.js";
export {
  braveSearch,
  duckDuckGo,
  parseDuckDuckGo,
  webFetch,
  webSearch,
  type SearchProvider,
  type SearchResult,
} from "./web.js";
