# ☁️ Vaan AI

**Your terminal, with an AI that can actually do the work.**

Vaan is a local-first AI agent for your terminal — built to think, act, remember, and explain what
it did.

Give Vaan a task. It can inspect your project, use tools, modify code, run tests, remember context,
and show you exactly what happened.

```text
You
 ↓
☁️ Vaan
 ↓
🧠 Think → 🔧 Act → 🔐 Permission → 📦 Sandbox
 ↓
🧪 Test → 🔍 Verify → 📋 Explain
 ↓
✓ Done
```

---

## 🚀 Get Started

```bash
npm install -g vaan-ai
```

```bash
cd ~/projects/my-app
vaan
```

That's it. The package is `vaan-ai`; the command it installs is `vaan`.

Just looking? `npx vaan-ai` runs it without installing anything — but it leaves
nothing on your PATH, so it's `npx vaan-ai` every time.

<details>
<summary>From source</summary>

```bash
git clone https://github.com/balagurunilacandane/vaan-ai.git
cd vaan-ai && npm install && npm run build && npm link
```

</details>

**What you need**

- **Node 20 or newer.**
- **One provider** — an API key for Anthropic, OpenAI, Google or Groq, or
  [Ollama](https://ollama.com) running locally, which needs no key at all.
- **A C++ toolchain, occasionally.** Memory is SQLite with FTS5, so there's one native dependency.
  Almost every platform gets a prebuilt binary; if yours doesn't, the install says so and tells you
  what to install.

Vaan starts with an interactive onboarding experience instead of making you configure everything
manually.

---

## 🧭 Interactive Onboarding

When you run `vaan` for the first time, it walks you through:

```text
☁️ Welcome to Vaan AI

Let's get you set up.

┌─────────────────────────────────────┐
│ 1. 📁 Workspace                     │
│    ~/projects/my-app                │
│                                     │
│ 2. 🤖 Model                         │
│    anthropic/claude-opus-5          │
│                                     │
│ 3. 🔑 Credentials                   │
│    ● Configure provider             │
│                                     │
│ 4. 👤 Agent Identity                │
│    Vaan                             │
│                                     │
│ 5. 🧠 Memory                        │
│    ● Enabled                        │
│                                     │
│ 6. 🧰 Tools                         │
│    ✓ Files   ✓ Search   ✓ Git      │
│    ✓ Web     ✓ Code     ✓ Memory   │
│    ○ Browser        (not yet)       │
│    ○ Integrations   (not yet)       │
│                                     │
│ 7. 📦 Coding Sandbox                │
│    ● Restricted                     │
│                                     │
│ 8. 🔐 Permissions                   │
│    ● Configure                      │
│                                     │
│ 9. ⚙️ Project Configuration          │
│    ● SOUL.md / GUARDRAILS.md        │
└─────────────────────────────────────┘

✓ Vaan is ready.
```

A group you switch off doesn't exist. The model isn't told about a tool it may not use and then
refused — it simply doesn't have one.

---

## 🤖 Bring your own model

Choose the model you actually want to use:

```text
anthropic/claude-opus-5
openai/gpt-5
google/gemini-2.5-pro
ollama/qwen3:8b
custom/your-model
```

Cloud or local. No model lock-in, and no allowlist of model names anywhere in the codebase — the
prefix picks an adapter, everything after the slash is passed through untouched. A model released
tomorrow works today.

---

## ⚡ Give it real work

```text
> Add rate limiting to /api/auth/login.
> Use Redis if it's already available.
> Add tests and run them.
```

Vaan:

```text
🧠 Thinking...
🔎 Inspecting project...
🔍 Searching for Redis...
📋 Planning changes...

✓ Redis found
✓ Express detected
✓ Test framework detected
```

Then it asks — naming the exact file, not "some files":

```text
🔐 Permission required

  Vaan wants to modify:

    src/auth/login.ts

  Permission:
    WRITE

  changing a file in the workspace

  Allow?  [y/N]
```

Say yes and you get the diff before a byte is written. Say no and it tells you what it needed and
stops, rather than looking for another way round.

After approval:

```text
📦 Coding sandbox

✓ Updated authentication
✓ Added rate limiting
✓ Added tests
✓ Ran test suite

🧪 18 tests passed

🔍 Verifying...

✓ No unrelated files changed
✓ Rate limiting active
✓ Tests passing

📋 Done.

Request ID: 7f3e9b4a
```

Not just "here's some code."

**Intent → Plan → Permission → Execute → Test → Verify → Explain**

---

## ✨ Why Vaan?

**🧠 Think** — Multi-step reasoning and planning.

**🔧 Act** — Files, search, Git, web and commands. *No shell:* commands are tokenised in-process and
spawned with `shell: false`, so the argv you approve is the argv that runs. No pipe, no redirect, no
`&&` tail that nobody read.

**💾 Remember** — Persistent, local, searchable project memory.

**🔐 Stay in control** — Permissions are enforced by the runtime, not by the model.

**📦 Code safely** — Coding operations run inside a restricted sandbox.

**👀 See everything** — Every request gets a unique Request ID and an end-to-end trace.

**🤖 Use any model** — Cloud models, local models, or your own provider.

**🏠 Local-first** — Your agent state, memory and traces live with your workspace, in `.vaan/`.

---

## 🔐 Security

Vaan's architecture separates the agent runtime from the coding sandbox.

```text
             ☁️ Vaan
                │
        ┌───────┴───────┐
        │               │
     🧠 Agent        🔐 Policy
     Runtime          Engine
        │               │
        └───────┬───────┘
                ↓
        📦 Coding Sandbox
        ├── 📁 Files
        ├── ⚙️ Processes
        ├── 📦 Dependencies
        ├── 🧪 Tests
        └── 🏗️ Builds
```

**The model cannot approve its own actions.** Not as a policy in a prompt — the approver is a
function closed over your terminal, held in the runtime's own scope. No tool receives it and nothing
the model emits can reach it. A tool can ask; only a person can answer.

**Some rules are not configurable.** No config file, onboarding checkbox or skill can turn these
off:

- Credential material is never read — `.env`, `.ssh/`, `.aws/`, `.npmrc`, wherever they sit, even
  inside your workspace
- System changes are out of reach, and so are `/etc`, `/dev` and `/proc`
- Commands that format a disk, delete the filesystem root or pipe a download into a shell are
  refused outright — no approval prompt, because there is no good answer to one

Credentials are isolated, stripped from the environment any sandboxed command inherits, and excluded
from traces — redaction happens as events are written, not when they're read.

`SOUL.md` and `GUARDRAILS.md` define behavior. **They are not security boundaries.** The limits that
actually hold are in `src/sandbox/` and `src/permissions/`.

---

## 👀 Built-in Observability

Every request gets a unique ID:

```text
Request ID: 7f3e9b4a
```

You can inspect what happened:

```bash
vaan trace 7f3e9b4a
```

```text
Request
 ↓
Model
 ↓
Memory
 ↓
Tool calls
 ↓
Permissions
 ↓
Sandbox
 ↓
Tests
 ↓
Verification
 ↓
Response
```

Every permission decision, with the reason and who made it. No black box.

---

## 🧰 Skills

Extend Vaan with local skills:

```text
.vaan/
└── skills/
    ├── code-review/
    │   └── SKILL.md
    └── deploy/
        └── SKILL.md
```

Teach Vaan how to perform specialized workflows without changing the core runtime. Only the first
line of each skill costs tokens; the full file is read when it actually applies.

Skills are instruction, not permission — nothing a `SKILL.md` says can widen what the agent may do.

---

## 💻 CLI

```bash
vaan                  # ☁️ Start Vaan
vaan init             # 🚀 Initialize
vaan memory           # 🧠 Memory
vaan schedule         # ⏰ Scheduling
vaan trace            # 👀 Traces
vaan doctor           # 🩺 Diagnostics
vaan eval             # 🧪 Evaluations
```

Inside Vaan:

```text
/model       🤖 Change model
/new         🆕 New conversation
/memory      🧠 Memory
/forget      🗑️ Forget
/inbox       📥 Scheduled results
/status      📊 Status
/trace       👀 This request, in full
/settings    ⚙️ Settings
/help        ❓ Help
/exit        👋 Exit
```

---

## 🏗️ Architecture

```text
☁️ Vaan CLI
     │
     ▼
🧠 Agent Runtime
 ├── 🤖 Model
 ├── 🧠 Memory
 ├── 🔧 Tools
 ├── 🔐 Permissions
 └── 👀 Observability
          │
          ▼
    📦 Coding Sandbox
          │
          ▼
        ✓ Result
```

```text
src/agent.ts         the loop — read this first
src/index.ts         the runtime, where policy, gate and trace are built
src/permissions/     capability classification; a floor no config can widen
src/sandbox/         filesystem, process and network boundaries
src/observability/   a Request ID and a full trace for every request
src/providers/       Anthropic, OpenAI, Google, Ollama, custom endpoints
src/memory/          SQLite with FTS5, two tiers
src/eval/            suites for trajectory, security, sandbox, reliability
```

The model is replaceable. The runtime, permissions, memory, sandbox, traces and evals are not tied
to any provider.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

---

## 📜 License

Apache License 2.0

---

**☁️ Vaan** — *Think. Remember. Act. Observe.*
