/** How many "Did you mean" fixes an unresolved name offers. */
export const MAX_SUGGESTIONS = 3;
/** A candidate this close is always offered; longer names allow a third of their length. */
const MIN_SUGGESTION_DISTANCE = 2;
const SUGGESTION_LENGTH_RATIO = 3;

/** The edit distance between two names, compared case-blind. */
export function editDistance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (a.charAt(row - 1) === b.charAt(column - 1) ? 0 : 1);
      current.push(Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The closest `candidates` to `name`, nearest first, within max(2, a third of its length). */
export function suggestions(name: string, candidates: Iterable<string>): string[] {
  const threshold = Math.max(MIN_SUGGESTION_DISTANCE, Math.floor(name.length / SUGGESTION_LENGTH_RATIO));
  const scored = new Map<string, number>();
  for (const candidate of candidates) {
    if (scored.has(candidate) || candidate.toLowerCase() === name.toLowerCase()) continue;
    const distance = editDistance(name, candidate);
    if (distance <= threshold) scored.set(candidate, distance);
  }
  return [...scored]
    .sort(([leftName, left], [rightName, right]) => left - right || leftName.localeCompare(rightName))
    .slice(0, MAX_SUGGESTIONS)
    .map(([candidate]) => candidate);
}
