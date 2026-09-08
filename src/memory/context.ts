// What memory actually contributes to a turn: the gate that decides whether to
// look, and the shape recalled memory takes once it's in the prompt.
//
// The gate is the most visible thing Vaan does. Before touching memory, one
// cheap call answers one question: does answering this need anything we've been
// told? "What's 2+2" doesn't. "When am I seeing Alex" does. Skipping the search
// on the first kind keeps the prompt small and the turn fast.
//
// It fails open. If the gate errors, times out, or answers something we can't
// read, we retrieve — a slightly larger prompt is a much smaller problem than an
// agent that forgot you.

import type { Provider } from "../types.js";
import type { Fact, Turn } from "./index.js";

const GATE_SYSTEM = `You decide whether answering a message needs the user's stored memory.

Reply with exactly one word: YES or NO.

YES when the message touches the user themselves — their history, preferences,
plans, people, projects, or anything they would have had to tell you.
NO when the message stands on its own: arithmetic, general knowledge, a
definition, a translation, or writing something from scratch.`;

export interface GateOptions {
  provider: Provider;
  model: string;
  signal?: AbortSignal;
}

export async function needsMemory(message: string, opts: GateOptions): Promise<boolean> {
  try {
    const reply = await opts.provider.generate({
      model: opts.model,
      system: GATE_SYSTEM,
      messages: [{ role: "user", parts: [{ type: "text", text: message }] }],
      tools: [],
      maxTokens: 8,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const answer = reply.message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()
      .toUpperCase();
    return !answer.startsWith("NO");
  } catch {
    return true;
  }
}

/** Facts are injected, not searched, so they carry their own framing. */
export function factsSection(facts: Fact[]): string | undefined {
  if (facts.length === 0) return undefined;
  return (
    `# What you know about this user\n\n` +
    `Things they've told you in past sessions. Use them without being asked, and without\n` +
    `announcing that you remembered.\n\n` +
    facts.map((fact) => `- ${fact.text}`).join("\n")
  );
}

/** Recalled turns are retrieved, so they say so — retrieval can and does miss. */
export function turnsSection(turns: Turn[]): string | undefined {
  if (turns.length === 0) return undefined;
  return (
    `# Relevant past conversation\n\n` +
    `Retrieved because it looked related to what was just asked. It may not be.\n\n` +
    turns.map(formatTurn).join("\n\n")
  );
}

const TURN_CLIP = 500;

const formatTurn = (turn: Turn): string =>
  `[${turn.ts.slice(0, 10)}]\n` +
  `user: ${clip(turn.userText, TURN_CLIP)}\n` +
  `you: ${clip(turn.replyText, TURN_CLIP)}`;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;
