// `vaan eval`, and the release gate.
//
// Deterministic suites must pass completely; judged suites must clear their
// threshold; anything else exits non-zero so CI notices. Cases run in a scratch
// workspace with a known fixture, so the result doesn't depend on whatever
// happens to be in the user's project — and so the security cases have
// something to try to read that nobody minds them trying.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../config.js";
import { createSession } from "../index.js";
import { home } from "../paths.js";
import { resolve, type Env } from "../providers/index.js";
import { FIXTURE, SUITES, type Suite } from "./suites.js";
import type { Grade } from "./graders.js";

export interface CaseReport {
  name: string;
  grades: Grade[];
  passed: boolean;
  error?: string;
}

export interface SuiteReport {
  suite: Suite;
  cases: CaseReport[];
  rate: number;
  passed: boolean;
}

export interface EvalReport {
  suites: SuiteReport[];
  passed: boolean;
}

export interface EvalOptions {
  workspace: string;
  model: string;
  env: Env & NodeJS.ProcessEnv;
  suites?: Suite[];
  onCase?: (report: CaseReport, suite: Suite) => void;
}

export async function runEvals(opts: EvalOptions): Promise<EvalReport> {
  const scratch = join(home(opts.workspace), "eval");
  mkdirSync(scratch, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURE)) {
    writeFileSync(join(scratch, name), body, "utf8");
  }

  const { provider, model } = resolve(opts.model, opts.env);
  const suites: SuiteReport[] = [];

  for (const suite of opts.suites ?? SUITES) {
    const cases: CaseReport[] = [];
    for (const testCase of suite.cases) {
      // A fresh session per case: memory off so one case can't teach the next,
      // and tracing off disk because the graders read the events in memory.
      //
      // `approve` is the interesting knob. Most cases set it true so a write
      // never blocks on a keystroke nobody is there to press. The security
      // cases set it false, because "what happens when nobody says yes" is
      // exactly what they measure — an auto-yes would grade the gate as open.
      const approve = testCase.approve ?? true;
      const config = defaultConfig(scratch, opts.model);
      const session = createSession({
        workspace: scratch,
        model: opts.model,
        config: { ...config, memory: false },
        memory: false,
        env: opts.env,
        trace: false,
        yes: approve,
        ...(approve ? {} : { approve: async () => false, confirm: async () => false }),
      });

      let report: CaseReport;
      try {
        const result = await session.ask(testCase.prompt);
        const grades = await Promise.all(
          testCase.graders.map((grade) =>
            grade({ result, trace: result.trace, provider, model }),
          ),
        );
        report = { name: testCase.name, grades, passed: grades.every((entry) => entry.pass) };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        report = { name: testCase.name, grades: [], passed: false, error: detail };
      } finally {
        session.close();
      }
      cases.push(report);
      opts.onCase?.(report, suite);
    }

    const rate =
      cases.length === 0 ? 1 : cases.filter((entry) => entry.passed).length / cases.length;
    const required = suite.kind === "deterministic" ? 1 : suite.threshold;
    suites.push({ suite, cases, rate, passed: rate >= required });
  }

  return { suites, passed: suites.every((entry) => entry.passed) };
}
