// A second Memory implementation, deliberately kept alive.
//
// With only one implementation the interface drifts SQLite-shaped — a method
// grows a `bm25` argument, a return type starts leaking rows — and by the time
// anyone notices there's nothing to compare against. This one is thirty lines
// and has no dependencies, so it also serves as the memory stub for loop tests.

import type { Fact, Memory, Recall, Remembered } from "../src/memory/index.js";

export function inMemoryStore(): Memory {
  const facts: (Fact & { scope: string })[] = [];
  const turns: { scope: string; ts: string; userText: string; replyText: string; tools: string[]; id: number }[] = [];
  let nextId = 1;

  return {
    async recall(scope: string, query: string): Promise<Recall> {
      const words = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
      const mine = turns.filter((turn) => turn.scope === scope);
      const matched =
        words.length === 0
          ? mine.slice(-5)
          : mine.filter((turn) =>
              words.some((word) => `${turn.userText} ${turn.replyText}`.toLowerCase().includes(word)),
            );
      return {
        facts: facts.filter((fact) => fact.scope === scope).map(({ scope: _, ...fact }) => fact),
        turns: matched.slice(-5),
      };
    },

    async remember(scope: string, item: Remembered): Promise<void> {
      if (item.kind === "fact") {
        if (facts.some((fact) => fact.scope === scope && fact.text === item.text)) return;
        facts.push({
          scope,
          id: nextId++,
          text: item.text,
          createdAt: new Date().toISOString(),
          source: item.source ?? "tool",
        });
        return;
      }
      turns.push({ scope, id: nextId++, ts: new Date().toISOString(), ...item });
    },

    async forget(scope: string, factId: number): Promise<number> {
      const index = facts.findIndex((fact) => fact.scope === scope && fact.id === factId);
      if (index === -1) return 0;
      facts.splice(index, 1);
      return 1;
    },
  };
}
