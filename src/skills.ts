// Skills are markdown in .vaan/skills/, not code. There is no plugin API to
// learn and nothing to keep in sync with a Vaan release.
//
//     .vaan/skills/
//       code-review/SKILL.md
//       deployment/SKILL.md
//
// Only each skill's first line goes in the system prompt. When one applies, the
// model reads the whole file with read_file — the skills folder is inside the
// workspace, so the tool it already has is the tool it uses. Twenty skills
// therefore cost twenty lines per turn, not twenty skills' worth.
//
// A skill is instruction, not permission. Nothing a SKILL.md says can widen
// what the agent may do: the gate doesn't read them and wouldn't care.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { skillsDir, skillsRelative } from "./paths.js";

export interface Skill {
  name: string;
  /** Path relative to the workspace, which is what read_file wants. */
  path: string;
  description: string;
}

/** Past this many, the descriptions themselves start costing real tokens. */
const WARN_ABOVE = 20;
const MAX_DESCRIPTION = 200;

export function loadSkills(workspace: string): { skills: Skill[]; warnings: string[] } {
  const root = skillsDir(workspace);
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return { skills: [], warnings: [] };
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const found = locate(root, entry);
    if (!found) continue;
    const description = firstLine(join(workspace, found.path));
    if (!description) continue;
    skills.push({ name: found.name, path: found.path, description });
  }

  const warnings =
    skills.length > WARN_ABOVE
      ? [
          `${skills.length} skills in ${skillsRelative}. Their descriptions are sent on every ` +
            `turn — consider merging or removing some.`,
        ]
      : [];
  return { skills, warnings };
}

/**
 * A skill is `<name>/SKILL.md`. A bare `<name>.md` is accepted too, because
 * that is what people write first and refusing it teaches nothing.
 */
function locate(root: string, entry: string): { name: string; path: string } | undefined {
  const full = join(root, entry);
  try {
    if (statSync(full).isDirectory()) {
      const inner = join(full, "SKILL.md");
      statSync(inner);
      return { name: entry, path: join(skillsRelative, entry, "SKILL.md") };
    }
  } catch {
    return undefined; // A directory without a SKILL.md isn't a skill.
  }
  if (!entry.endsWith(".md")) return undefined;
  return { name: entry.replace(/\.md$/, ""), path: join(skillsRelative, entry) };
}

function firstLine(path: string): string {
  try {
    const line = readFileSync(path, "utf8")
      .split("\n")
      .map((candidate) => candidate.replace(/^#+\s*/, "").trim())
      .find((candidate) => candidate.length > 0);
    return line ? line.slice(0, MAX_DESCRIPTION) : "";
  } catch {
    return "";
  }
}
