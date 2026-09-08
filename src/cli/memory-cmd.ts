// `vaan memory`, and the /memory slash command. Both print the same thing:
// what's injected on every turn, then what's sitting in the searchable tier.

import type { Recall } from "../memory/index.js";

export function printMemory(out: NodeJS.WriteStream, recall: Recall): void {
  out.write("\n  facts — sent with every message\n\n");
  if (recall.facts.length === 0) {
    out.write("    (none yet)\n");
  } else {
    for (const fact of recall.facts) {
      out.write(`    ${String(fact.id).padStart(3)}  ${fact.text}\n`);
    }
  }

  out.write("\n  recent turns — searched, not injected\n\n");
  if (recall.turns.length === 0) {
    out.write("    (none yet)\n");
  } else {
    for (const turn of recall.turns) {
      const tools = turn.tools.length > 0 ? `  [${turn.tools.join(", ")}]` : "";
      out.write(`    ${turn.ts.slice(0, 16).replace("T", " ")}${tools}\n`);
      out.write(`      ${clip(turn.userText)}\n`);
      out.write(`      ${clip(turn.replyText)}\n\n`);
    }
  }
  out.write("\n");
}

const clip = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 96 ? line : `${line.slice(0, 96)}…`;
};
