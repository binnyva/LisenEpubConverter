/**
 * Signs that a passage needs a cleanup edit before it is read aloud. Script
 * tests a chunk against these before paying for a model call: prose with no
 * quotation marks and none of these goes straight to the narrator.
 *
 * The test is deliberately cheap and one-sided. It cannot see a scanning error
 * in otherwise clean text, and that miss is accepted; a false alarm only costs
 * the call that would have been made anyway.
 */
export const CLEANUP_TRIGGERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Footnote and citation numbers set against a word or its punctuation: "women12", "women.12".
  { name: 'digits attached to a word', pattern: /\p{L}\d|(?<=\p{L})[.,;:!?"”’)\]]\d{1,3}(?![\d\p{L}])/u },
  // "[12]", "(3)", "[^1]", with the backslashes markdown conversion adds, and superscript digits.
  { name: 'bracketed number', pattern: /\\?[[(]\^?\d{1,3}\\?[\])]|[⁰¹²³⁴-⁹]/u },
  // Abbreviations a narrator says in full. Those that are also words ("no.", "p.") need a number after them.
  { name: 'abbreviation', pattern: /\b(?:e\.\s?g|i\.\s?e|etc|viz|cf|vs|approx|et al|ibid)\.|\b(?:nos?|pp?|vols?|figs?|ch|sec|ca?)\.\s?\d/iu },
  // A number with a unit symbol.
  { name: 'unit', pattern: /\d\s?(?:km|kg|cm|mm|ml|mg|mph|kph|lbs?|oz|ft|hrs?|mins?|secs?|kW|MW|GB|MB|kHz|Hz)\b|\d\s?°/u },
  // Symbols a voice model reads badly or skips, and bare web addresses.
  { name: 'unusual symbol', pattern: /[§¶†‡©®™°±×÷≈≠≤≥→←↔∞µ‰=+@]|https?:\/\/|\bwww\./u },
];

/** Names of the triggers a passage sets off; empty when it can be read as it stands. */
export function cleanupTriggers(text: string): string[] {
  return CLEANUP_TRIGGERS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
