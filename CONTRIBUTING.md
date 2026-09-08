# Contributing

Thanks for looking. Vaan is small on purpose, and the parts that enforce
anything are meant to stay small enough to read in one sitting.

## The line that matters

**Security is enforced by the runtime, never by a prompt.**

`SOUL.md` and `GUARDRAILS.md` ask the model to behave. `src/sandbox/` and
`src/permissions/` decide whether it may. A pull request that moves a limit from
the second category into the first will be closed, however well the wording
reads — an instruction is a hint, and a hint is not a boundary.

Concretely, these are settled:

- **No shell.** `run_command` tokenises in-process and spawns with
  `shell: false`. Adding `shell: true`, or a tool that accepts a shell string,
  makes every other protection decorative: the argv a user approves would stop
  being the argv that runs.
- **`FLOOR` in `src/permissions/rules.ts` is not configurable.** No config
  field, onboarding checkbox or skill may reach it. If you find a way to widen
  it from a file the agent can write, that's a security bug — see
  [SECURITY.md](SECURITY.md).
- **The approver never leaves the runtime's closure.** It is not on
  `ToolContext`, not in the system prompt, and not reachable from anything the
  model emits. The model cannot approve its own actions, and that has to stay a
  fact about the code rather than a claim about the prompt.
- **No allowlist of model names.** Model strings pass through untouched so a
  model released tomorrow works today. `src/cli/suggested.ts` holds the
  onboarding shortcuts and is the only file that knows any model name.
- **One runtime dependency.** `better-sqlite3` — ranked retrieval needs real
  BM25, and Node's built-in `node:sqlite` ships compiled without FTS5. A second
  dependency needs an argument at least that strong.

## House rules

In rough order of how annoyed a reviewer will be if you break them:

1. **`src/agent.ts` never imports a concrete provider**, and never decides
   anything about safety. It knows about the `Provider` interface, tools, and
   the trace. Tools ask the gate; the gate asks a human. Keeping that out of the
   loop is why the loop is readable.
2. **A new tool declares a `group` and asks the gate before it touches
   anything.** A tool tested with the gate stubbed open is a tool whose
   permission check nobody has ever run.
3. **Memory failures never throw.** The backend being down must not stop the
   agent answering.
4. **Observability never takes the run down with it.** A trace that can't be
   written is a missing trace, not a failed request.
5. **Tests never require network or an API key.** Stub the `Provider`.
   `test/provider.ts` and `test/harness.ts` are the pattern.
6. **Nothing that could be a credential reaches a trace file.** Redaction runs
   as an event is recorded, not when it's read.

## Out of scope

> Out of scope: planners, multi-agent routing, RAG over your codebase, a Vaan
> daemon.

A pull request adding one of these will be closed with a link to this section.
That isn't a judgement about the idea — several are good ideas — it's that they
compose better as a separate tool than as a flag in this one. The daemon has a
second reason: a background process holding your API key with write access to
your project is a thing you have to trust around the clock, and `vaan schedule`
exists so you don't have to.

**No bespoke plugin format.** Skills are markdown. Custom code tools wait for
MCP, rather than inventing a manifest, a lifecycle and a compatibility promise
that only Vaan speaks.

## The shape of the thing

```text
src/agent.ts         the loop — read this first
src/index.ts         the runtime, where policy, gate and trace are built
src/types.ts         provider-neutral messages, tools, tool context
src/providers/       one adapter per API shape
src/memory/          SQLite, two tiers
src/sandbox/         filesystem, process, network
src/permissions/     policy, rules, approval
src/observability/   request, events, trace
src/eval/            suites and graders
```

## Getting set up

```bash
npm install          # runs the FTS5 probe; it should pass
npm run typecheck
npm test             # 135 tests, all offline
```

`npm test` compiles to `dist/` and runs `node --test`. There's no test framework
dependency and there isn't going to be one.

To try your build against a real model:

```bash
npm run build
node dist/src/cli/main.js
```

`vaan eval` runs the graded suites. That one *does* need a key and a network,
because the thing being tested is whether a real model uses the tools — and
whether the gate holds when it tries not to.

## Changing the loop

The GUARD comments in `src/agent.ts` each mark a bug that only shows up against
a real provider: reasoning has to round-trip, tool calls arrive in parallel,
tool errors are data, not every stop is a stop, and a refused permission is an
answer rather than a crash. `test/agent.test.ts` pins all five. If you're
touching that code, read those tests first.

## Changing anything that enforces

`test/permissions.test.ts` is written from the attacker's side: every test is a
way an agent might get somewhere it shouldn't, and the assertion is that it
doesn't. If you change `src/permissions/` or `src/sandbox/`, add the case that
would have caught your bug — one of the existing tests exists because a `**`
glob silently compiled to a pattern that matched nothing, quietly disabling the
rule that denies system changes.

## Reporting things

- Something's broken: use the bug template.
- `npm install` or `npx vaan` failed: use the install-failed template. That one
  is expected to be most of the early traffic, because a native module is
  involved.
- Something looks like a security problem: see [SECURITY.md](SECURITY.md), and
  please don't open a public issue first.
