---
name: Bug report
about: vaan installed and started, but did the wrong thing
title: ""
labels: bug
---

<!-- If `npm install` or `npx vaan` failed before you reached a prompt,
please use the "Install failed" template instead. -->

## What happened

## What you expected instead

## Steps to reproduce

1.
2.
3.

## The session

<!-- What you typed and what came back. Please redact anything private —
vaan prints file contents and memory, and issues are public. -->

```
>
```

## Setup

- vaan version: <!-- vaan --version -->
- Model: <!-- the provider/model string, e.g. anthropic/claude-opus-4-8 -->
- `node --version`:
- OS:
- Memory on or off: <!-- --no-memory disables it -->
- Any skills in `.vaan/skills/`?
- Have you edited `SOUL.md` or `GUARDRAILS.md`?

## Does it happen with a fresh setup?

<!-- Behaviour is shaped by memory, SOUL.md, GUARDRAILS.md and skills, so a run
in an empty directory narrows it down a lot:

    mkdir /tmp/vaan-check && cd /tmp/vaan-check
    npx vaan --no-memory

yes / no / didn't try -->
