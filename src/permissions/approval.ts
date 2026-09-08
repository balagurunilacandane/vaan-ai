// The gate. Every tool that touches anything comes through here first.
//
// The one invariant worth stating plainly: the model cannot approve its own
// actions. The approver is a function the CLI supplies when the session is
// built, closed over a readline handle attached to the real terminal. It is
// never passed to a tool, never named in a prompt, and never reachable from
// anything the model emits. A tool can ask the gate; only a human can answer.

import type { Trace } from "../observability/trace.js";
import type { Policy } from "./policy.js";
import type { PermissionRequest } from "./rules.js";

export class PermissionDenied extends Error {
  constructor(
    readonly request: PermissionRequest,
    readonly reason: string,
  ) {
    super(`Not permitted: ${request.capability} on ${request.target} — ${reason}`);
    this.name = "PermissionDenied";
  }
}

/** Asks the human. Returns true only if they said yes. */
export type Approver = (request: PermissionRequest, reason: string) => Promise<boolean>;

/** `--yes`, and the eval runner. Never wired to anything the model controls. */
export const approveAll: Approver = async () => true;

/** Non-interactive sessions: nobody is there to ask, so the answer is no. */
export const denyAll: Approver = async () => false;

export interface Gate {
  /** Throws `PermissionDenied` unless the action may proceed. */
  require(request: PermissionRequest): Promise<void>;
  /** The same decision without the throw, for tools that want to degrade. */
  allowed(request: PermissionRequest): Promise<boolean>;
}

export interface GateOptions {
  policy: Policy;
  approve: Approver;
  /**
   * The trace to record into. A function rather than a value because the gate
   * outlives any one request: the memo of what you already approved is
   * session-scoped, while the trace it writes to changes every turn.
   */
  trace?: () => Trace | undefined;
  /** False re-asks for every command, even an identical one. */
  memoise?: boolean;
}

/** Capabilities whose target fully describes the action, so a yes can be reused. */
const MEMOABLE = new Set(["execute", "destructive", "network"]);

export function createGate(opts: GateOptions): Gate {
  // Approving `npm test` once and then being asked again for the identical
  // command is the fastest way to teach someone to hold down `y`. Commands and
  // hosts are memoised by exact target. File writes deliberately are not: the
  // path is the same on every write, and the content is what changed.
  const granted = new Set<string>();
  const memoise = opts.memoise !== false;

  async function decide(request: PermissionRequest): Promise<boolean> {
    const verdict = opts.policy.check(request);
    const key = `${request.capability} ${request.target}`;

    let allowed: boolean;
    let how: string;
    if (verdict.decision === "deny") {
      allowed = false;
      how = verdict.fixed ? "denied by fixed policy" : "denied by policy";
    } else if (verdict.decision === "allow") {
      allowed = true;
      how = "allowed by policy";
    } else if (memoise && MEMOABLE.has(request.capability) && granted.has(key)) {
      allowed = true;
      how = "approved earlier this session";
    } else {
      allowed = await opts.approve(request, verdict.reason);
      how = allowed ? "approved by user" : "declined by user";
      if (allowed && memoise && MEMOABLE.has(request.capability)) granted.add(key);
    }

    opts.trace?.()?.record({
      kind: "permission",
      tool: request.tool,
      capability: request.capability,
      target: request.target,
      decision: allowed ? "allow" : "deny",
      reason: `${verdict.reason} — ${how}`,
    });
    return allowed;
  }

  return {
    allowed: decide,
    async require(request) {
      if (!(await decide(request))) {
        throw new PermissionDenied(request, opts.policy.check(request).reason);
      }
    },
  };
}

/** A gate that permits everything, for unit tests of things that aren't the gate. */
export const openGate: Gate = {
  async require() {},
  async allowed() {
    return true;
  },
};
