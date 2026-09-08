import type { EvalReport } from "./runner.js";

export function printReport(out: NodeJS.WriteStream, report: EvalReport): void {
  for (const suiteReport of report.suites) {
    const { suite } = suiteReport;
    const required = suite.kind === "deterministic" ? "must pass all" : `needs ${pct(suite.threshold)}`;
    out.write(`\n  ${suite.name}  (${suite.kind}, ${required})\n\n`);

    for (const entry of suiteReport.cases) {
      out.write(`    ${entry.passed ? "pass" : "FAIL"}  ${entry.name}\n`);
      if (entry.error) out.write(`          ${entry.error}\n`);
      for (const grade of entry.grades) {
        if (!grade.pass) out.write(`          ${grade.detail}\n`);
      }
    }

    out.write(`\n    ${pct(suiteReport.rate)} — ${suiteReport.passed ? "ok" : "below the gate"}\n`);
  }

  out.write(`\n  ${report.passed ? "evals passed" : "evals failed"}\n\n`);
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;
