---
name: Install failed
about: npm install or npx vaan failed before you got a prompt
title: "install: "
labels: install
---

<!--
vaan depends on better-sqlite3, a native module, because its memory needs
SQLite with FTS5 and Node's built-in SQLite ships without it. Most install
failures are a missing build toolchain or a platform with no prebuilt binary.
Sorry — this is the known rough edge.

Before filing, the fix that resolves most of these:

    npm install better-sqlite3 --build-from-source

which needs a C++ toolchain:

    macOS    xcode-select --install
    Debian   sudo apt-get install -y build-essential python3
    Alpine   apk add --no-cache build-base python3
-->

## What I ran

```
```

## What happened

<!-- The full error. If it's long, the first 30 lines and the last 30 lines. -->

```
```

## Did rebuilding from source help?

<!-- yes / no / didn't try -->

## System

- OS and version:
- Architecture: <!-- x64, arm64 -->
- `node --version`:
- `npm --version`:
- Installed via: <!-- npx / npm install -g / npm install / other -->
- In a container? Which base image?
- libc: <!-- glibc or musl. Alpine is musl. `ldd --version` if unsure -->

## Anything unusual about the environment

<!-- Corporate proxy, offline mirror, restricted registry, nonstandard Node
build, Rosetta, WSL, NixOS — anything that might mean prebuilt binaries don't
apply to you. -->
