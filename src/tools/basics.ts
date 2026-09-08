import type { Tool } from "../types.js";

export const now: Tool = {
  name: "now",
  description:
    "The current date and time. Call this before answering anything that depends on today's " +
    "date — you have no other way to know it.",
  group: "files",
  parameters: { type: "object", properties: {} },
  run() {
    const at = new Date();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const local = at.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" });
    return `${at.toISOString()} (UTC)\n${local} (${zone})`;
  },
};

export const remember: Tool = {
  name: "remember",
  description:
    "Store one short, durable fact about the user, so it is available in every future " +
    "conversation. Good: a dietary restriction, where they live, what they're building, how " +
    "they like answers written. Not for anything that stops being true next week, and not for " +
    "restating what was just said. Every stored fact costs tokens on every turn, so keep each " +
    "one to a sentence and only store what's worth carrying.",
  group: "memory",
  parameters: {
    type: "object",
    properties: {
      fact: {
        type: "string",
        description: 'The fact, written as a standalone sentence: "Is allergic to prawns."',
      },
    },
    required: ["fact"],
  },
  async run(input, ctx) {
    const fact = String(input.fact ?? "").trim();
    if (!fact) return "Nothing to remember — the fact was empty.";
    await ctx.remember(fact);
    ctx.trace.record({ kind: "memory", op: "remember", detail: fact });
    return `Remembered: ${fact}`;
  },
};
