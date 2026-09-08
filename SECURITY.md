# Security

## Reporting a vulnerability

Please use GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository rather than opening a public issue. We'll acknowledge within
a few days and keep you updated as we work on a fix.

## What vaan does on your machine

Worth knowing before you decide how much to trust it:

- **It runs an agent loop with tools.** A language model chooses which of the
  six built-in tools to call and with what arguments. Those choices are
  influenced by everything in its context, including file contents and web
  search results.
- **File access is confined to the working directory.** Every path is resolved
  and rejected if it lands outside the directory vaan was started in, and
  symlinks that escape are rejected too (`src/tools/jail.ts`).
- **Writes are confirmed.** `write_file` shows the path and a diff and waits for
  a keystroke. `--yes` disables that prompt — only pass it when you already
  trust what's about to happen, such as in CI.
- **Your query leaves your machine when you search.** Nothing else does. Memory
  is a local SQLite file at `.vaan/state.db`; it is never uploaded.
- **Your API key is read from the environment or `.env`.** `.env` is in
  `.gitignore`. Check before you commit anyway.

## The honest limits

**`GUARDRAILS.md` is instruction, not enforcement.** It's sent to the model as
part of the prompt, and a sufficiently confused or sufficiently manipulated
model can ignore it. The limits that actually hold are in code: the path jail
and the write confirmation. Treat the file as direction and the code as the
fence.

**Prompt injection is a real risk and vaan does not solve it.** Text from a
web page or a file can try to instruct the model. vaan tells the model, in a
part of the system prompt that users can't accidentally delete, that such text
is information and never instructions — but that is mitigation, not a
guarantee. The practical protections are the two in code above: injected text
still cannot make vaan read outside the directory or write without asking.

Concretely: don't run `vaan --yes` in a directory whose contents you don't
trust, and read the diff before approving a write during a session that has
been reading the web.

## Out of scope

- Findings that require an attacker to already have local code execution as
  your user.
- The model saying something wrong, offensive, or made up. That's a model
  quality issue; please report it to your provider.
- `--yes` doing what it says on the tin.

## Supported versions

0.1.x, which is the only released line. Fixes land on the latest release; there
are no backports yet.
