// What an action *is*, and what the rules say about it.
//
// Two layers, and the difference is the whole point. `FLOOR` is not
// configurable: no config file, no onboarding checkbox and no instruction in
// SOUL.md can turn it off. Everything above it is the user's policy, which the
// onboarding writes and the user can edit.
//
// GUARDRAILS.md asks the model to behave. This decides whether it may.

/** What an action needs in order to happen. One request, one capability. */
export type Capability =
  | "read" // read a file inside the workspace
  | "write" // create or modify a file inside the workspace
  | "execute" // run a command in the sandbox
  | "destructive" // a command that removes or rewrites work
  | "network" // reach something outside this machine
  | "credentials" // read key material or the environment holding it
  | "outside" // touch a path outside the workspace
  | "system"; // change the machine rather than the project

export type Decision = "allow" | "ask" | "deny";

export interface PermissionRequest {
  /** The tool asking. Recorded in the trace; never used to decide. */
  tool: string;
  capability: Capability;
  /** A path, a host, or a command line — whatever the decision is about. */
  target: string;
  /** Shown to the human when the decision is `ask`. */
  detail?: string;
}

export interface Rule {
  capability: Capability;
  decision: Decision;
  /** Glob against the target. Absent means every target of that capability. */
  match?: string;
  /** Shown in the trace and in `vaan doctor`. */
  reason?: string;
}

/**
 * Never allowed, whatever the config says.
 *
 * These are the cases where a mistake isn't recoverable by saying no next time:
 * key material that has already been read is already leaked, and a filesystem
 * that has already been formatted is already gone.
 */
export const FLOOR: Rule[] = [
  {
    capability: "credentials",
    decision: "deny",
    reason: "credential material is never read by the agent",
  },
  { capability: "system", decision: "deny", match: "**", reason: "system changes are out of reach" },
  { capability: "outside", decision: "deny", match: "/etc/**", reason: "system configuration" },
  { capability: "outside", decision: "deny", match: "/dev/**", reason: "device files" },
  { capability: "outside", decision: "deny", match: "/proc/**", reason: "kernel interface" },
];

/** Files that are never read or written, wherever they sit. */
export const SENSITIVE_FILES: RegExp[] = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.git[\\/]config$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.gnupg[\\/]/i,
  /(^|[\\/])\.kube[\\/]config$/i,
  /(^|[\\/])credentials(\.json)?$/i,
  /(^|[\\/])service-account.*\.json$/i,
];

export const isSensitiveFile = (path: string): boolean =>
  SENSITIVE_FILES.some((pattern) => pattern.test(path));

/** Which approvals the user asked for during onboarding. All on by default. */
export interface ApprovalFlags {
  destructive: boolean;
  network: boolean;
  credentials: boolean;
  outside: boolean;
  system: boolean;
}

export const ALL_APPROVALS: ApprovalFlags = {
  destructive: true,
  network: true,
  credentials: true,
  outside: true,
  system: true,
};

/**
 * The starting policy. Reading inside the workspace is free; changing anything
 * is not. A flag the user cleared downgrades `ask` to `allow` — that is what
 * the checkbox means — but it can never reach past `FLOOR`.
 */
export function defaultRules(flags: ApprovalFlags = ALL_APPROVALS): Rule[] {
  const gated = (on: boolean): Decision => (on ? "ask" : "allow");
  return [
    { capability: "read", decision: "allow", reason: "reading inside the workspace" },
    { capability: "write", decision: "ask", reason: "changing a file in the workspace" },
    { capability: "execute", decision: "ask", reason: "running a command in the sandbox" },
    { capability: "destructive", decision: gated(flags.destructive), reason: "destructive command" },
    { capability: "network", decision: gated(flags.network), reason: "external network action" },
    {
      capability: "credentials",
      decision: flags.credentials ? "deny" : "ask",
      reason: "credential access",
    },
    {
      capability: "outside",
      decision: flags.outside ? "ask" : "allow",
      reason: "path outside the workspace",
    },
    { capability: "system", decision: flags.system ? "deny" : "ask", reason: "system change" },
  ];
}

/**
 * Glob matching, `*` within a segment and `**` across them. Small on purpose:
 * a security decision should not depend on a pattern language nobody can hold
 * in their head.
 */
export function matchesGlob(pattern: string, target: string): boolean {
  const normalised = target.replace(/\\/g, "/");
  const source = pattern.replace(/\\/g, "/");
  let regex = "";

  // Scanned rather than built from chained replaces. The chained version got
  // `**` wrong in a way nothing would have noticed: it compiled to a pattern
  // that matched nothing, which silently disabled the FLOOR rule denying system
  // changes. A security decision shouldn't rest on replace ordering.
  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string;
    if (char === "*") {
      if (source[index + 1] === "*") {
        // `**/` crosses zero or more directories; a bare `**` matches the rest
        // of the path, separators included.
        if (source[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`).test(normalised);
}

export interface Verdict {
  decision: Decision;
  reason: string;
  /** True when the verdict came from FLOOR and cannot be configured away. */
  fixed: boolean;
}

/** First matching rule wins, floor first. An unmatched capability is denied. */
export function evaluate(rules: Rule[], request: PermissionRequest): Verdict {
  for (const rule of FLOOR) {
    if (applies(rule, request)) {
      return { decision: rule.decision, reason: rule.reason ?? "not permitted", fixed: true };
    }
  }
  for (const rule of rules) {
    if (applies(rule, request)) {
      return { decision: rule.decision, reason: rule.reason ?? rule.capability, fixed: false };
    }
  }
  return { decision: "deny", reason: `no rule covers ${request.capability}`, fixed: false };
}

const applies = (rule: Rule, request: PermissionRequest): boolean =>
  rule.capability === request.capability &&
  (rule.match === undefined || matchesGlob(rule.match, request.target));

// ---------------------------------------------------------------------------
// Classifying a command line.

interface Pattern {
  pattern: RegExp;
  why: string;
}

/** Refused outright: no approval prompt, because there is no good answer to it. */
const FORBIDDEN: Pattern[] = [
  { pattern: /\bmkfs(\.\w+)?\b/, why: "formats a filesystem" },
  { pattern: /\bdd\b[^\n]*\bof=\s*\/dev\//, why: "writes directly to a device" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, why: "changes machine state" },
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, why: "deletes the filesystem root" },
  { pattern: /\b(chmod|chown)\s+-R\b[^\n]*\s\/(\s|$)/, why: "rewrites the filesystem root" },
  { pattern: /\b(curl|wget)\b[^\n]*\|\s*(ba|z|k)?sh\b/, why: "pipes a download into a shell" },
];

const DESTRUCTIVE: Pattern[] = [
  { pattern: /\brm\s+-[a-zA-Z]*[rf]/, why: "recursive or forced delete" },
  { pattern: /\bgit\s+push\b[^\n]*--force/, why: "force push" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fd])/, why: "discards working-tree changes" },
  { pattern: /\bgit\s+branch\s+-D\b/, why: "deletes a branch" },
  { pattern: /\bnpm\s+(publish|unpublish)\b/, why: "publishes a package" },
  { pattern: /\b(drop|truncate)\s+(table|database)\b/i, why: "drops data" },
  { pattern: /\bdocker\s+(rm|rmi|system\s+prune)\b/, why: "removes containers or images" },
  { pattern: /\bkill(all)?\s+-9\b/, why: "force-kills processes" },
];

const NETWORKED: Pattern[] = [
  { pattern: /\b(curl|wget|nc|ssh|scp|rsync|ftp)\b/, why: "reaches the network" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update)\b/, why: "downloads packages" },
  { pattern: /\b(pip3?|uv|poetry)\s+(install|add|sync)\b/, why: "downloads packages" },
  {
    pattern: /\b(go\s+get|cargo\s+(add|install)|gem\s+install|apt-get|apk\s+add|brew\s+install)\b/,
    why: "downloads packages",
  },
  { pattern: /\bgit\s+(push|pull|fetch|clone)\b/, why: "talks to a remote" },
];

const PRIVILEGED: Pattern[] = [
  { pattern: /\b(sudo|doas|su)\b/, why: "asks for elevated privileges" },
  { pattern: /\b(systemctl|launchctl|service)\b/, why: "changes system services" },
  { pattern: /\b(useradd|userdel|visudo)\b/, why: "changes system users" },
];

const CREDENTIAL_READS: Pattern[] = [
  { pattern: /\b(printenv|env)\b(?!\s*\w+=)/, why: "dumps the environment" },
  { pattern: /\bcat\b[^\n]*\.(env|npmrc|netrc|pypirc)\b/, why: "reads a credential file" },
  { pattern: /\b(security|keychain|gpg|pass)\s/, why: "reads a credential store" },
  { pattern: /\baws\s+configure\b/, why: "reads cloud credentials" },
];

export interface CommandClass {
  /** The strongest capability the command needs; what the gate is asked for. */
  capability: Capability;
  /** Everything it matched, so the approval prompt can say why. */
  reasons: string[];
  /** Refused before any prompt. */
  forbidden: boolean;
}

/**
 * Read a command line and say what it is. Deliberately over-broad: a false
 * "this looks destructive" costs one keystroke, a false "this looks harmless"
 * costs a working tree.
 */
export function classifyCommand(command: string): CommandClass {
  const hits = (patterns: Pattern[]): string[] =>
    patterns.filter((entry) => entry.pattern.test(command)).map((entry) => entry.why);

  const forbidden = hits(FORBIDDEN);
  if (forbidden.length > 0) {
    return { capability: "destructive", reasons: forbidden, forbidden: true };
  }

  const credentials = hits(CREDENTIAL_READS);
  if (credentials.length > 0) {
    return { capability: "credentials", reasons: credentials, forbidden: false };
  }

  const privileged = hits(PRIVILEGED);
  if (privileged.length > 0) return { capability: "system", reasons: privileged, forbidden: false };

  const destructive = hits(DESTRUCTIVE);
  if (destructive.length > 0) {
    return { capability: "destructive", reasons: destructive, forbidden: false };
  }

  const networked = hits(NETWORKED);
  if (networked.length > 0) return { capability: "network", reasons: networked, forbidden: false };

  return { capability: "execute", reasons: [], forbidden: false };
}
