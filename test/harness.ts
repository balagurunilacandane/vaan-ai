// Shared scaffolding: a ToolContext that isn't wired to anything real, and a
// grade context with an empty trace. Both exist so a test about the loop stays
// a test about the loop rather than half a test about permissions.

import type { AgentResult } from "../src/agent.js";
import { newRequest } from "../src/observability/request.js";
import { openTrace, type Trace } from "../src/observability/trace.js";
import { openGate, type Gate } from "../src/permissions/approval.js";
import { createPolicy } from "../src/permissions/policy.js";
import { DEFAULT_NETWORK_POLICY } from "../src/sandbox/network.js";
import { scrubEnv } from "../src/sandbox/process.js";
import { scripted } from "./provider.js";
import type { Tool, ToolContext, ToolGroup } from "../src/types.js";

/** A trace that collects events in memory and writes nothing to disk. */
export function testTrace(input = "test"): Trace {
  return openTrace({
    home: "/dev/null",
    request: newRequest(input, "test/model", process.cwd()),
    persist: false,
  });
}

export interface TestContextOptions {
  workspace?: string;
  gate?: Gate;
  confirm?: boolean;
  trace?: Trace;
}

export function testContext(opts: TestContextOptions = {}): ToolContext {
  const workspace = opts.workspace ?? process.cwd();
  return {
    workspace,
    gate: opts.gate ?? openGate,
    policy: createPolicy({ workspace }),
    trace: opts.trace ?? testTrace(),
    network: DEFAULT_NETWORK_POLICY,
    confirm: async () => opts.confirm ?? true,
    remember: async () => {},
    // The same environment the runtime hands a command: real, minus anything
    // that looks like a credential. An empty env would mean no PATH, and every
    // exec test would fail for a reason that has nothing to do with the tool.
    env: scrubEnv(process.env),
  };
}

export const testTool = (name: string, run: Tool["run"], group: ToolGroup = "files"): Tool => ({
  name,
  description: `test tool ${name}`,
  group,
  parameters: { type: "object", properties: {} },
  run,
});

/** A grade context for graders that only look at the result, not the trace. */
export function gradeContext(result: AgentResult, trace?: Trace) {
  const collected = trace ?? testTrace();
  return {
    result,
    trace: collected.finish(true, result.text),
    provider: scripted([]),
    model: "fake",
  };
}
