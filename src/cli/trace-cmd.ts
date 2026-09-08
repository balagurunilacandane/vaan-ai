// `vaan trace` — the listing, and one request in full.
//
// The claim in the README is that every request is understandable after the
// fact: what it received, what it decided, which tools it used, what was
// allowed, what ran in the sandbox, what happened. This is where that claim is
// either true or it isn't, so the printer shows every event rather than a
// curated summary.

import { describeEvent, listTraces, readTrace, type StoredTrace } from "../observability/trace.js";
import { shortId } from "../observability/request.js";
import { home } from "../paths.js";

export function printTraceList(out: NodeJS.WriteStream, workspace: string, limit = 20): number {
  const traces = listTraces(home(workspace), limit);
  if (traces.length === 0) {
    out.write("\n  No traces yet. They're written to .vaan/traces after each request.\n\n");
    return 0;
  }

  out.write("\n  recent requests\n\n");
  for (const trace of traces) {
    out.write(
      `    ${shortId(trace.id)}  ${trace.at.slice(0, 16).replace("T", " ")}  ` +
        `${trace.ok ? "ok  " : "FAIL"}  ${(trace.durationMs / 1000).toFixed(1)}s  ` +
        `${clip(trace.input, 48)}\n`,
    );
  }
  out.write("\n  vaan trace <id> for one in full.\n\n");
  return 0;
}

export function printTrace(out: NodeJS.WriteStream, workspace: string, query: string): number {
  const trace = readTrace(home(workspace), query);
  if (!trace) {
    out.write(`\n  No trace matching "${query}".\n\n`);
    return 1;
  }
  out.write(render(trace));
  return 0;
}

export function render(trace: StoredTrace): string {
  const lines: string[] = [
    "",
    `  Request ID:  ${trace.id}`,
    `  When:        ${trace.at}`,
    `  Model:       ${trace.model}`,
    `  Workspace:   ${trace.workspace}`,
    "",
    `  Request:     ${clip(trace.input, 200)}`,
    "",
    "  Steps",
    "",
  ];

  for (const event of trace.events) {
    lines.push(`    ${pad(event.ms)}  ${describeEvent(event)}`);
  }

  const permissions = trace.events.filter((event) => event.kind === "permission");
  if (permissions.length > 0) {
    lines.push("", "  Permissions", "");
    for (const event of permissions) {
      if (event.kind !== "permission") continue;
      lines.push(
        `    ${event.decision === "allow" ? "✓" : "✗"} ${event.capability.padEnd(12)}` +
          `${clip(event.target, 44)}\n      ${event.reason}`,
      );
    }
  }

  lines.push(
    "",
    "  Timing",
    "",
    `    Total: ${(trace.durationMs / 1000).toFixed(2)}s`,
    "",
    `  Result: ${trace.ok ? "ok" : "failed"}`,
    `    ${clip(trace.summary, 200)}`,
    "",
  );
  return lines.join("\n");
}

const pad = (ms: number): string => `${(ms / 1000).toFixed(2)}s`.padStart(7);

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max)}…`;
};
