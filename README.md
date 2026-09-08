# Vaan AI

**Your terminal, with an AI that can actually do the work.**

Vaan AI is a local-first AI agent built to think, act, remember, and explain what it did.

Give Vaan a task and it can reason through the problem, use tools, modify and test code inside an
isolated sandbox, remember relevant project context, and complete multi-step workflows — while
keeping you in control of sensitive actions.

Every request gets a unique Request ID and an end-to-end trace, so you can see what Vaan received,
what it decided, which tools it used, what permissions were granted, what ran in the sandbox, and
how the task finished.

The result is an AI agent that is not just conversational — it can take a task from intent to
verified result.

---

## See Vaan in Action

Imagine you are working on a backend service and ask:

```text
You:
Add rate limiting to the /api/auth/login endpoint.

Use Redis if it is already available in the project.
Add tests for the new behavior.
Run the relevant tests when you're done.
```

Vaan turns that request into an observable workflow.

```text
Request ID:
7f3e9b4a-5b5d-4f4f-9e31-1c6e6c3d8a21

Thinking...

→ Inspect project structure
→ Read existing authentication code
→ Search for Redis configuration
→ Inspect existing test patterns
→ Create implementation plan
```

### Inspect

```text
Vaan → read_file
  src/auth/login.ts
  src/config/redis.ts
  tests/auth/login.test.ts

Vaan → search
  "redis"
  "rate limit"
  "login"
```

Vaan discovers that Redis is already configured.

```text
Found:
  Redis: available
  Authentication: Express middleware
  Tests: Vitest
```

### Plan

```text
Plan:

1. Add rate-limiting middleware
2. Use existing Redis connection
3. Apply it only to /api/auth/login
4. Return HTTP 429 when the limit is exceeded
5. Add success and limit-exceeded tests
6. Run the authentication test suite
```

### Ask for permission when required

Vaan shows the exact action and waits:

```text
Vaan wants to modify:

    src/middleware/rate-limit.ts

Permission:
    WRITE — changing a file in the workspace

Allow?  [y/N]
```

Then the diff, before a byte is written:

```text
Create src/middleware/rate-limit.ts

+ import { redis } from "../config/redis.js";
+
+ export function rateLimit({ max, windowMs }) {
+   ...

Write it?  [y/N]
```

One question per action, on purpose. A single prompt covering three files is a prompt people stop
reading.

### Code inside the sandbox

Coding operations are isolated:

```text
┌──────────────────────────────┐
│       Coding Sandbox         │
│                              │
│  Modify source files         │
│  Install required packages   │
│  Run tests                   │
│  Build / execute code        │
│                              │
└──────────────┬───────────────┘
               │
               ▼
            Results
```

Vaan implements the changes and runs the tests inside the sandbox.

```text
Vaan → sandbox
  ✓ Modify rate-limit.ts
  ✓ Update login.ts
  ✓ Add login.test.ts
  ✓ Run authentication tests

Tests:

  ✓ rejects excessive login attempts
  ✓ allows requests below the limit
  ✓ resets the rate limit window

Result:
  18 tests passed
```

### Verify

Vaan checks the final state instead of assuming the task succeeded.

```text
Verification:

✓ Rate limiting applied to /api/auth/login
✓ Existing Redis configuration reused
✓ Tests added
✓ Authentication tests passing
✓ No unrelated files modified
```

### Final result

```text
Done.

Added Redis-backed rate limiting to /api/auth/login.

Limit:
  5 requests / minute / IP

Tests:
  18 passed

Files changed:
  src/auth/login.ts
  src/middleware/rate-limit.ts
  tests/auth/login.test.ts

Request ID:
  7f3e9b4a-5b5d-4f4f-9e31-1c6e6c3d8a21
```

The complete flow is traceable:

```text
Request
   │
   ├── Model reasoning
   │
   ├── File inspection
   │
   ├── Search
   │
   ├── Permission decision
   │
   ├── Sandbox execution
   │
   ├── Tests
   │
   ├── Verification
   │
   └── Final result
```

One request. One trace. One verified result.

---

## Why Vaan AI?

Most AI assistants are designed around a chat window.

Vaan is designed around getting work done.

Instead of treating the model as an unrestricted shell user, Vaan separates reasoning from
execution and intent from permission.

```text
                         ┌───────────────────┐
                         │       User        │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │     Vaan CLI      │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │   Agent Runtime   │
                         │                   │
                         │ Model + Memory    │
                         │ Planning + Tools  │
                         │ Permissions       │
                         │ Observability     │
                         └─────────┬─────────┘
                                   │
                            coding operation
                                   │
                                   ▼
                         ┌───────────────────┐
                         │  Coding Sandbox   │
                         │                   │
                         │ Code              │
                         │ Dependencies      │
                         │ Tests             │
                         │ Build / Execution │
                         └─────────┬─────────┘
                                   │
                                   ▼
                                 Result
                                   │
                                   └──────► Vaan
```

Vaan separates what the model wants to do from what the system actually allows it to do.

---

## Core Principles

### Local-first

Your workspace, configuration, memory, traces, and agent state stay on your machine, in `.vaan/`.
The only thing that leaves is what you send to your model provider, and what a search or fetch tool
asks for after you approve it.

### Provider agnostic

Vaan is not tied to a single AI provider.

```text
anthropic/claude-opus-5
anthropic/claude-sonnet-5
openai/gpt-5
openai/gpt-5-mini
google/gemini-2.5-pro
ollama/qwen3:8b
custom/your-model
```

There is no allowlist of model names anywhere in the codebase. The prefix picks an adapter;
everything after the first slash is passed through untouched, so a model released tomorrow works
today. The agent runtime does not depend on a specific model vendor.

### Security first

Vaan does not give the model unrestricted access to your computer.

The agent runtime controls:

* Tool access
* Filesystem access
* Permissions
* Credentials
* Network access
* Sandbox execution

**The model cannot approve its own actions.** That isn't a policy in a prompt — the approver is a
function closed over your terminal, held in the runtime's own scope. No tool receives it and
nothing the model emits can reach it. A tool can ask the gate; only a person can answer.

### Observable by default

Every agent request receives a unique Request ID.

```text
Request ID: 7f3e9b4a-5b5d-4f4f-9e31-1c6e6c3d8a21
```

That request produces a complete trace containing:

```text
Request
  ↓
Model
  ↓
Tool calls
  ↓
Permissions
  ↓
Sandbox execution
  ↓
Results
  ↓
Final response
```

Observability is a first-class part of Vaan rather than an afterthought.

---

## 🔐 Security Architecture

Security is a core part of Vaan rather than an instruction written inside a prompt.

The agent runtime runs outside the coding sandbox. The sandbox is used specifically for isolated
operations such as:

* Writing code
* Modifying project files
* Installing dependencies
* Running tests
* Building applications
* Executing code
* Running development commands

```text
                 ┌───────────────┐
                 │      User     │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────┐
                 │    Vaan CLI   │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────────┐
                 │   Agent Runtime   │
                 │                   │
                 │ Model + Memory    │
                 │ Planning + Tools  │
                 │ Permissions       │
                 │ Observability     │
                 └─────────┬─────────┘
                           │
                    coding operation
                           │
                           ▼
                 ┌───────────────────┐
                 │  Coding Sandbox   │
                 │                   │
                 │ Files             │
                 │ Code              │
                 │ Dependencies      │
                 │ Tests             │
                 │ Build / Execution │
                 └─────────┬─────────┘
                           │
                           ▼
                       Results
                           │
                           └──────► Agent Runtime
```

### Security boundaries

Behavioral instruction files do not define security boundaries. These do:

| Boundary | Enforced by | What it does |
|---|---|---|
| Files | `src/sandbox/filesystem.ts` | Resolves every path against the workspace and rejects what lands outside, symlinks followed |
| Permissions | `src/permissions/` | Classifies each action into a capability, then allows, asks, or denies |
| Processes | `src/sandbox/process.ts` | No shell: the command is tokenised in-process and spawned with `shell: false` |
| Environment | `src/sandbox/process.ts` | Credentials are stripped from the environment a command inherits |
| Network | `src/sandbox/network.ts` | Loopback, private ranges and the cloud metadata address are refused |
| Traces | `src/observability/events.ts` | Secrets are redacted on the way in, not on the way out |

### There is no shell

The old objection to giving an agent an exec tool was sound: a shell resolves its own paths, so it
can't be jailed, and approving `bash -c "…"` is approving an opaque string, so it can't be
meaningfully confirmed. Both of those are properties of the shell.

So Vaan doesn't use one. `run_command` tokenises the command itself and spawns it with
`shell: false`. Unquoted metacharacters are rejected rather than interpreted:

```text
> run npm test && rm -rf build

  "&" is a shell metacharacter and Vaan does not run commands through a shell.
  Run one command at a time, and quote arguments that need it.
```

The argv you approve is exactly the argv that runs. No pipe, no redirect, no `&&` tail that nobody
read.

### The floor

Some rules are not configurable. No config file, no onboarding checkbox and no instruction in
`SOUL.md` can turn these off:

* Credential material is never read — `.env`, `.ssh/`, `.aws/`, `.npmrc` and friends, wherever they
  sit, even inside the workspace
* System changes are out of the agent's reach
* `/etc`, `/dev` and `/proc` are unreachable
* Commands that format a disk, delete the filesystem root, or pipe a download into a shell are
  refused outright — no approval prompt, because there is no good answer to one

Everything above that floor is yours to configure.

---

## 🚀 Interactive Onboarding

Vaan uses an interactive first-run experience rather than asking you to write a config file.

Start Vaan:

```bash
npx vaan
```

Or initialize explicitly:

```bash
npx vaan init
```

The onboarding walks through the decisions that matter.

**1. Workspace**

```text
  Where should Vaan work?

    1) this directory      /Users/you/projects/my-app
    2) another directory

  ?
```

Vaan restricts its filesystem access to the directory you pick.

**2. Choose your model**

```text
  Select your model:

    1) anthropic/claude-opus-5     most capable
    2) anthropic/claude-sonnet-5   faster, cheaper
    3) anthropic/claude-haiku-4-5  cheapest
    4) openai/gpt-5
    5) openai/gpt-5-mini           faster, cheaper
    6) google/gemini-2.5-pro
    7) ollama/qwen3:8b             local, no key
    8) custom                      your own endpoint

  Pick a number, or type any provider/model.
```

**3. Authenticate the selected provider**

```text
  Selected model: openai/gpt-5

  Openai API key  ?
```

For local models:

```text
  Selected model: ollama/qwen3:8b

  No API key required.
```

The key is written to `.env`, which is gitignored — and which the agent itself is never permitted
to read.

**4. Agent identity**

```text
  Agent name  [Vaan]  ?
```

**5. Memory**

```text
  Enable persistent project memory?

    Y) yes
    n) no
```

**6. Tools**

```text
  Tools:

    1) [x] Files             read, write and edit inside the workspace
    2) [x] Search            find text and files in the workspace
    3) [x] Git               status, diff and log — read-only
    4) [x] Web               search and fetch public pages
    5) [x] Code execution    run commands in the sandbox
    6) [x] Memory            remember durable facts about you
       [ ] Browser           not configured in this build
       [ ] External integrations   not configured in this build

  Enter to keep them all, or type the numbers to turn off (e.g. 3 5).
```

A group you turn off doesn't exist. The model isn't told about a tool it may not use and then
refused — it simply doesn't have one.

**7. Sandbox**

```text
  Coding sandbox:

    1) restricted    every command re-approved, 60s limit   (default)
    2) standard      repeat commands remembered, 5m limit
    3) custom        edit .vaan/config/config.json yourself
```

**8. Permissions**

```text
  Require approval for:

    1) [x] Destructive commands
    2) [x] External network actions
    3) [x] Credential access
    4) [x] Files outside workspace
    5) [x] System changes

  Enter to keep them all, or type the numbers to drop.
  Credential access and system changes stay denied either way.
```

**9. Project configuration**

Vaan shows the `SOUL.md` and `GUARDRAILS.md` it's about to write and waits for a keystroke.

**10. Ready**

```text
  Vaan is ready.

  Workspace: /Users/you/projects/my-app
  Model: openai/gpt-5
  Memory: enabled
  Sandbox: restricted
  Tools: files, search, git, web, code, memory
```

Node 20 or newer. Nothing else to install.

---

## 📁 Project Structure

```text
.
├── src/
│   ├── agent.ts                the loop — read this first
│   ├── index.ts                the runtime, where everything is wired
│   ├── types.ts                provider-neutral messages, tools, context
│   ├── config.ts               .vaan/config/config.json
│   ├── prompt.ts               SOUL.md, GUARDRAILS.md, skills, memory
│   │
│   ├── providers/
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── google.ts
│   │   ├── ollama.ts
│   │   └── custom.ts
│   │
│   ├── memory/
│   │   ├── store.ts            SQLite with FTS5
│   │   ├── search.ts           query building and ranking
│   │   └── context.ts          the retrieval gate, and prompt sections
│   │
│   ├── sandbox/
│   │   ├── filesystem.ts       the path jail
│   │   ├── process.ts          tokenise, spawn, scrub, cap, kill
│   │   └── network.ts          what the agent may reach
│   │
│   ├── permissions/
│   │   ├── policy.ts           action → capability
│   │   ├── rules.ts            the rules, and the floor
│   │   └── approval.ts         the gate, and who answers it
│   │
│   ├── observability/
│   │   ├── request.ts          Request IDs
│   │   ├── events.ts           the event taxonomy, and redaction
│   │   └── trace.ts            writing and reading traces
│   │
│   ├── tools/                  files, search, git, web, code, memory
│   ├── eval/                   suites and graders
│   └── cli/                    onboarding, REPL, trace, doctor, schedule
│
├── .vaan/
│   ├── config/
│   ├── memory/
│   ├── traces/
│   ├── state/
│   └── skills/
│
├── SOUL.md
├── GUARDRAILS.md
├── LICENSE
└── README.md
```

---

## 🧩 Skills

Vaan supports project-specific skills. Skills live under `.vaan/skills/`:

```text
.vaan/
└── skills/
    ├── code-review/
    │   └── SKILL.md
    ├── deployment/
    │   └── SKILL.md
    └── database/
        └── SKILL.md
```

A skill describes how Vaan should perform a particular class of work. Only each skill's first line
goes in the system prompt; when one applies, the model reads the whole file with `read_file`. Twenty
skills cost twenty lines per turn, not twenty skills' worth.

Skills are instruction, not code — there is no plugin API to learn and nothing to keep in sync with
a Vaan release.

**Skills are not security boundaries.** Nothing a `SKILL.md` says can widen what the agent may do.

---

## 📋 Project Instructions

### `SOUL.md`

Defines the agent's personality and general behavioral style.

### `GUARDRAILS.md`

Contains behavioral constraints and safety expectations.

Both are sent at the top of every conversation, both are yours to edit, and changes apply on the
next message with no restart.

**These files influence behavior but cannot override runtime security policies.** A sufficiently
confused model can ignore anything written in them. The limits that actually hold are in
`src/sandbox/` and `src/permissions/`. Treat these files as direction, and the code as the fence.

---

## 🔎 Observability & Traces

Every agent request receives a unique Request ID, and a request is one complete agent flow.

```text
Request
  │
  ├── Model call
  │
  ├── Tool call
  │
  ├── Permission decision
  │
  ├── Sandbox operation
  │
  ├── Tool result
  │
  ├── Model response
  │
  └── Final result
```

Inspect traces:

```bash
vaan trace              # recent requests
vaan trace 7f3e9b4a     # one in full, by id or any prefix
```

```text
  Request ID:  7f3e9b4a-5b5d-4f4f-9e31-1c6e6c3d8a21
  When:        2026-09-08T09:14:02.184Z
  Model:       anthropic/claude-opus-5
  Workspace:   /Users/you/projects/my-app

  Request:     Refactor the authentication middleware

  Steps

      0.00s  request   Refactor the authentication middleware
      0.412s model     anthropic/claude-opus-5  1204 in / 88 out
      0.418s tool      search
      0.501s sandbox   search auth
      0.503s result    search — src/auth/login.ts:12
      1.902s permit    write src/auth/login.ts — ALLOW
      2.140s sandbox   write src/auth/login.ts
      6.883s permit    execute npm test — ALLOW
     18.401s sandbox   exec npm test

  Permissions

    ✓ write        src/auth/login.ts
      changing a file in the workspace — approved by user
    ✓ execute      npm test
      running a command in the sandbox — approved by user

  Timing

    Total: 18.42s

  Result: ok
```

Traces contain the Request ID, model calls, tool calls, execution time, token usage, permission
decisions, sandbox operations, errors and results.

**Sensitive information is never recorded.** Redaction happens as an event is written, not when it
is read — a trace file that has to be sanitised later is a trace file that has already leaked. Field
names that mark a secret lose their value entirely, and every remaining string is scanned for
key-shaped substrings.

One JSON file per request in `.vaan/traces`, pruned to the most recent 200.

---

## 🧪 Evals

Vaan evaluates more than whether the final answer looks correct.

```bash
vaan eval
```

Five suites:

| Suite | Asks |
|---|---|
| **trajectory** | Did it reach for the right tool, and avoid the wrong one? |
| **security** | Did it stay inside the workspace? Did it refuse what it should refuse? |
| **sandbox** | Did coding operations actually go through the sandbox? |
| **reliability** | Did it recover from a tool failure? Did it verify rather than assume? |
| **answers** | Judged: is the answer any good? |

The security cases are the ones worth having. They run with **nothing auto-approved**, because
"what happens when nobody is there to say yes" is exactly what they measure — an auto-yes would
grade the gate as open. A run that produces a perfect answer by reading a file it should not have
reached is a failure, and nothing that only looks at the final text can see it.

Deterministic suites must pass completely, judged suites must clear a threshold, non-zero exit
otherwise. Drop it in CI.

---

## ⏰ Scheduling

Vaan supports scheduled tasks without an always-running agent service.

```bash
vaan schedule            # list
vaan schedule add        # create one
vaan schedule run <id>   # run it now
```

```text
  What should Vaan do?

  ? Check git changes since yesterday, run the tests, and summarise

  When?  cron, five fields

    0 9 * * 1-5      weekdays at 09:00
```

**There is no Vaan daemon.** A background process holding your API key with write access to your
project is something you'd have to trust around the clock. Your operating system already has a
scheduler you trust, so Vaan stores the task and hands you the line that installs it:

```text
  0 9 * * 1-5 cd /Users/you/projects/my-app && vaan schedule run 7f3e9b4a
```

Vaan doesn't install that line itself either — editing a crontab is a system change, and system
changes are denied by fixed policy, including to the CLI. An agent that exempts itself from its own
floor doesn't have a floor.

A scheduled run has nobody to ask for permission, so nothing that needs approval happens. It lands
in the inbox instead, and `/inbox` shows it the next time you're at the keyboard.

---

## 🖥️ CLI

```bash
vaan                 # start the REPL
vaan init            # run setup again
vaan memory          # print facts and recent turns
vaan trace [id]      # list requests, or show one in full
vaan doctor          # check this install
vaan eval            # run the suites, exit non-zero if they fail
vaan schedule        # list, add, remove or run a scheduled task
```

Options:

```text
--model <spec>       provider/model for this run
--workspace <path>   work somewhere other than the current directory
--no-memory          don't read or write memory this session
--no-trace           don't write a trace file this session
--yes                grant every permission without asking
```

---

## 💬 Chat Commands

```text
/model       Change model, or show which keys are set
/new         Start a new conversation, keeping stored memory
/memory      View memory
/forget      Remove a fact
/inbox       Results from scheduled runs
/status      Workspace, permissions, tools, tokens
/trace       The last request in full, or one by id
/settings    Where to change things
/help        Show help
/exit        Exit Vaan
```

---

## 🧠 Memory

Two tiers, and the difference is the whole design.

**Facts** are short statements about you. They go into every conversation automatically, so they
work even when your question doesn't mention them. "Allergic to prawns" has to surface when you ask
what to order, not only when you say the word prawn.

**Turns** are past conversations, searched full-text and ranked against whatever you just asked.
Only the relevant ones come back.

Why both: retrieval can miss, injection can't. But injection is paid on every turn, so the facts
tier stays small on purpose.

Before touching memory, one cheap call answers one question: does answering this need anything
we've been told? "What's 2+2" doesn't. "When am I seeing Alex" does. It fails open — a slightly
larger prompt is a much smaller problem than an agent that forgot you.

Everything is in `.vaan/memory/state.db`, locally. Nothing is uploaded. A readable mirror is written
to `.vaan/memory/MEMORY.md` after each turn.

```bash
vaan memory
```

---

## 🏗️ Architecture

At the core is a model-independent agent loop:

```text
              ┌───────────────┐
              │     User      │
              └───────┬───────┘
                      │
                      ▼
              ┌───────────────┐
              │    Vaan CLI   │
              └───────┬───────┘
                      │
                      ▼
              ┌───────────────┐
              │ Agent Runtime │
              └───────┬───────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       Memory       Model        Tools
                      │           │
                      │           ▼
                      │    ┌───────────────┐
                      │    │  Permissions  │
                      │    └───────┬───────┘
                      │            │
                      │            ▼
                      │    ┌───────────────┐
                      │    │ Coding Sandbox│
                      │    └───────┬───────┘
                      │            │
                      │            ▼
                      │          Result
                      │            │
                      └────────────┘

                 ─────────────────────
                    Observability
                 Request ID + Trace
                 ─────────────────────
```

The model is replaceable. The agent runtime, permissions, memory, sandbox, traces, and evals remain
independent of the model provider.

### What an agent actually is

If you're new to this, the mental model is short and worth having.

A language model can't do anything. It only produces text. When it "reads a file," it emits a
request saying *please run read_file on agent.ts*. Your code runs the read, hands the result back,
and asks again.

An agent is a loop around that:

1. Send the conversation and the list of tools to the model.
2. It replies. Asked for no tools? That's your answer — stop.
3. Asked for tools? Run them, append the results, go back to step 1.

That's the whole idea. It lives in `src/agent.ts`, and it's the shortest useful thing in this repo.
It knows nothing about workspaces, paths or approvals — tools ask the gate, the gate asks a human —
which is why it stays readable.

---

## 🔌 Provider Architecture

Providers implement a common interface.

```text
Provider
   │
   ├── Anthropic     /v1/messages
   ├── OpenAI        /v1/chat/completions
   ├── Google        /v1beta/models/…:generateContent
   ├── Ollama        local, OpenAI-shaped
   └── Custom        any of the above shapes, your URL
```

```typescript
interface Provider {
  generate(request: ProviderRequest): Promise<ProviderReply>
  stream(request: ProviderRequest): AsyncIterable<ModelEvent>
}
```

Both methods are required. Anthropic, OpenAI and Google stream over SSE; any adapter without a
streaming endpoint satisfies `stream` with a shared fallback that waits for the whole turn and
replays it as events — correct, just not incremental.

Adding your own endpoint is configuration, not code:

```bash
VAAN_PROVIDER_TOGETHER=openai:https://api.together.xyz/v1
```

which reads its key from `TOGETHER_API_KEY`.

---

## 🛡️ Permission Model

Vaan follows a least-privilege approach. Every action is classified into one capability, and the
rules decide: allow, ask, or deny.

| Capability | Default | Meaning |
|---|---|---|
| `read` | allow | Read a file inside the workspace |
| `write` | ask | Create or modify a file inside the workspace |
| `execute` | ask | Run a command in the sandbox |
| `destructive` | ask | A command that removes or rewrites work |
| `network` | ask | Reach something outside this machine |
| `outside` | ask | Touch a path outside the workspace |
| `credentials` | **deny** | Read key material — not configurable |
| `system` | **deny** | Change the machine rather than the project — not configurable |

Classification is the part that matters. A rule that says "ask before writing outside the
workspace" is worth nothing if a path that walks out through a symlink is classified as an ordinary
workspace write, so paths are resolved to real paths — including the real path of the nearest
existing ancestor, for a file that doesn't exist yet — before anything else looks at them.

Approving `npm test` once covers the identical command again for the session. File writes are never
memoised: the path is the same on every write, and the content is what changed.

**The approval happens outside the model's control.**

---

## 🔑 Credentials

Provider credentials are handled separately from model context. They:

* Are never sent to the model
* Never appear in traces — redaction happens as events are written
* Are stripped from the environment any sandboxed command inherits
* Are never readable by the agent's own file tools, even inside the workspace
* Live in `.env`, which is gitignored

---

## Philosophy

Vaan is built around a simple idea:

**The AI should be capable of acting, while the system remains observable and in control.**

The model provides reasoning. Vaan provides context, memory, tools, permissions, sandboxed coding,
execution, verification, and observability.

Every request should be understandable after the fact: What did the agent receive? What did it
decide? What tools did it use? What was allowed? What ran in the sandbox? What happened?

That is the foundation of Vaan.

---

## License

Vaan AI is licensed under the Apache License 2.0.

Copyright © 2026 Vaan AI contributors.

See the [LICENSE](LICENSE) file for the full license text.

---

**Vaan**

*Think. Remember. Act. Observe.*

A local-first AI agent for your terminal.
