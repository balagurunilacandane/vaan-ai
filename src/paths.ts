// Every path Vaan writes to, in one place.
//
// `.vaan/` sits at the root of the workspace rather than in the home directory,
// because the interesting state is per-project: this project's memory, this
// project's traces, this project's skills. Nothing here is shared between
// workspaces, which is also why nothing here needs a lock.

import { join } from "node:path";

export const HOME_DIR = ".vaan";

/** `<workspace>/.vaan` — the root of everything below. */
export const home = (workspace: string): string => join(workspace, HOME_DIR);

export const configDir = (workspace: string): string => join(home(workspace), "config");
export const memoryDir = (workspace: string): string => join(home(workspace), "memory");
export const tracesDir = (workspace: string): string => join(home(workspace), "traces");
export const stateDir = (workspace: string): string => join(home(workspace), "state");
export const skillsDir = (workspace: string): string => join(home(workspace), "skills");

export const configFile = (workspace: string): string => join(configDir(workspace), "config.json");
export const databaseFile = (workspace: string): string => join(memoryDir(workspace), "state.db");
export const memoryMirror = (workspace: string): string => join(memoryDir(workspace), "MEMORY.md");
export const inboxFile = (workspace: string): string => join(stateDir(workspace), "inbox.json");

/** Relative to the workspace, which is what `read_file` wants. */
export const skillsRelative = join(HOME_DIR, "skills");

export const SOUL_FILE = "SOUL.md";
export const GUARDRAILS_FILE = "GUARDRAILS.md";
