// Turning a sentence into something FTS5 will accept.
//
// This is separated from the store because it is the part with no I/O in it and
// the part most likely to be wrong: user text goes straight into query syntax,
// where a stray quote or the bare word "AND" is a syntax error rather than a
// search term.

/** Words too common to be worth a BM25 term. Short list on purpose. */
export const STOPWORDS = new Set(
  ("the a an and or but if then than that this these those is are was were be been being do does did " +
    "for to of in on at by with from about into over after before you your my me i it its as what when " +
    "where who how why can could should would will just have has had not no yes please").split(" "),
);

/** Terms past this add noise rather than signal, and cost query time. */
const MAX_TERMS = 12;
const MIN_TERM_LENGTH = 3;

/**
 * An FTS5 MATCH expression, or undefined when there's nothing worth searching.
 *
 * Reducing to alphanumeric words and quoting each one sidesteps the whole
 * grammar: no operator can survive the reduction, so no input can be a syntax
 * error, and `OR` between terms lets BM25 rank rather than filter.
 */
export function toMatchQuery(text: string): string | undefined {
  const useful = terms(text);
  return useful.length > 0 ? useful.map((word) => `"${word}"`).join(" OR ") : undefined;
}

/** The words a query actually searches on. Exposed so tests can assert on them. */
export function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((word) => word.length >= MIN_TERM_LENGTH && !STOPWORDS.has(word))
    .slice(0, MAX_TERMS);
}
