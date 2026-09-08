// The inbox: things that happened while you weren't looking.
//
// A scheduled run finishes at 09:00 with nobody at the keyboard, and its result
// has to go somewhere a person will see it. Same for a run that failed, or one
// that stopped because it needed an approval and there was no one to ask. Those
// are the only three things that land here — this is not a log, and a busy
// inbox would be worse than none.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inboxFile, stateDir } from "./paths.js";

export type InboxKind = "scheduled" | "failed" | "needs-approval";

export interface InboxItem {
  id: string;
  at: string;
  kind: InboxKind;
  title: string;
  detail: string;
  /** The trace this came from, so `vaan trace <id>` shows the whole story. */
  requestId?: string;
}

/** Older items past this are dropped when a new one arrives. */
const KEEP = 50;

export function addItem(
  workspace: string,
  item: Omit<InboxItem, "id" | "at">,
): InboxItem | undefined {
  try {
    const entry: InboxItem = { id: randomUUID(), at: new Date().toISOString(), ...item };
    const items = [...readInbox(workspace), entry].slice(-KEEP);
    mkdirSync(stateDir(workspace), { recursive: true });
    writeFileSync(inboxFile(workspace), `${JSON.stringify(items, null, 2)}\n`, "utf8");
    return entry;
  } catch {
    // An inbox that can't be written must not take the run down with it.
    return undefined;
  }
}

/** Newest last, which is the order they're printed in. */
export function readInbox(workspace: string): InboxItem[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(inboxFile(workspace), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isItem) : [];
  } catch {
    return [];
  }
}

export function clearInbox(workspace: string): number {
  const count = readInbox(workspace).length;
  try {
    mkdirSync(stateDir(workspace), { recursive: true });
    writeFileSync(inboxFile(workspace), "[]\n", "utf8");
  } catch {
    return 0;
  }
  return count;
}

const isItem = (value: unknown): value is InboxItem =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as InboxItem).id === "string" &&
  typeof (value as InboxItem).title === "string";
