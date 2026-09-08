// The policy: the user's rules, plus the mapping from a concrete action to the
// capability it needs.
//
// Classification is the part that matters. A rule that says "ask before writing
// outside the workspace" is worth nothing if a path that walks out through a
// symlink is classified as an ordinary workspace write, so paths are resolved
// to real paths before anything else looks at them.

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
  ALL_APPROVALS,
  defaultRules,
  evaluate,
  isSensitiveFile,
  type ApprovalFlags,
  type Capability,
  type PermissionRequest,
  type Rule,
  type Verdict,
} from "./rules.js";

export interface Policy {
  readonly workspace: string;
  readonly rules: Rule[];
  /** What the rules say about this action. Never prompts; never acts. */
  check(request: PermissionRequest): Verdict;
  /** Turn a path plus an intent into the request the gate should be asked. */
  forPath(tool: string, path: string, intent: "read" | "write"): PermissionRequest;
  /** Turn a URL into the request the gate should be asked. */
  forUrl(tool: string, url: string): PermissionRequest;
}

export interface PolicyOptions {
  workspace: string;
  /** Explicit rules win. Otherwise the flags pick a default set. */
  rules?: Rule[];
  approvals?: ApprovalFlags;
}

export function createPolicy(opts: PolicyOptions): Policy {
  const workspace = realpathish(opts.workspace);
  const rules = opts.rules ?? defaultRules(opts.approvals ?? ALL_APPROVALS);

  return {
    workspace,
    rules,
    check: (request) => evaluate(rules, request),

    forPath(tool, path, intent) {
      const target = isAbsolute(path) ? path : resolve(workspace, path);
      const real = realpathOfNearest(target);
      const capability: Capability = isSensitiveFile(real)
        ? "credentials"
        : within(workspace, real)
          ? intent
          : "outside";
      return { tool, capability, target: real };
    },

    forUrl(tool, url) {
      return { tool, capability: "network", target: url };
    },
  };
}

const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

function realpathish(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * The real path of `target`, or of the deepest ancestor that exists with the
 * missing tail re-attached.
 *
 * A path component that doesn't exist yet can't be a symlink, so the deepest
 * real ancestor decides where the finished path will land. Without this, "write
 * a new file" would classify by its own spelling rather than by where its
 * parent directory actually points.
 */
export function realpathOfNearest(target: string): string {
  const full = resolve(target);
  let current = full;
  for (;;) {
    try {
      const real = realpathSync(current);
      return current === full ? real : real + full.slice(current.length);
    } catch {
      const parent = dirname(current);
      if (parent === current) return full;
      current = parent;
    }
  }
}

/** What `vaan doctor` and `/status` print. */
export function describeRules(rules: Rule[]): string[] {
  return rules.map((rule) => {
    const scope = rule.match ? ` ${rule.match}` : "";
    return `${rule.capability}${scope}`.padEnd(24) + rule.decision;
  });
}

export { defaultRules };
export type { ApprovalFlags, Capability, PermissionRequest, Rule, Verdict };
