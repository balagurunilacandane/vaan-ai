// Two tiers, and the difference is the whole design.
//
// Facts are short statements about the user. They go into the system prompt on
// every turn, so they work even when the question doesn't mention them.
// "Allergic to prawns" has to surface when you ask what to order, not only
// when you say the word prawn.
//
// Turns are past conversations, searched full-text and ranked against whatever
// you just asked. Only the relevant ones come back.
//
// Why both: retrieval can miss, injection can't. Injection is paid on every
// turn, so the facts tier stays small on purpose.

export interface Fact {
  id: number;
  text: string;
  createdAt: string;
  /** Where it came from: "tool" when the model called remember, "user" for /remember. */
  source: string;
}

export interface Turn {
  id: number;
  ts: string;
  userText: string;
  replyText: string;
  tools: string[];
}

export interface Recall {
  facts: Fact[];
  turns: Turn[];
}

export type Remembered =
  | { kind: "fact"; text: string; source?: string }
  | { kind: "turn"; userText: string; replyText: string; tools: string[] };

export interface Memory {
  /**
   * Every fact in scope, plus the turns that best match `query`. An empty
   * query skips the search and returns the most recent turns instead, which is
   * what `vaan memory` prints.
   */
  recall(scope: string, query: string): Promise<Recall>;
  remember(scope: string, item: Remembered): Promise<void>;
  /** Drop a fact by id. Returns how many rows went away. */
  forget(scope: string, factId: number): Promise<number>;
  close?(): void;
}

export const EMPTY_RECALL: Recall = { facts: [], turns: [] };

/**
 * A memory that remembers nothing, for `--no-memory` and for tests. Keeping the
 * null case behind the same interface means nothing downstream needs to ask
 * whether memory is on.
 */
export const noMemory: Memory = {
  async recall() {
    return EMPTY_RECALL;
  },
  async remember() {},
  async forget() {
    return 0;
  },
};
