const isUpper = (text: string) => text === text.toUpperCase() && text !== text.toLowerCase();
const isLower = (text: string) => text === text.toLowerCase() && text !== text.toUpperCase();

/**
 * `replacement` in the case `matched` was written in, as DataGrip's Preserve case does: all upper,
 * all lower, or capitalised. Any other mix, or a match without letters, keeps `replacement` as typed.
 */
export function recase(matched: string, replacement: string): string {
  if (isUpper(matched)) return replacement.toUpperCase();
  if (isLower(matched)) return replacement.toLowerCase();
  const first = matched.slice(0, 1);
  const rest = matched.slice(1);
  if (!isUpper(first) || rest !== rest.toLowerCase()) return replacement;
  return replacement.slice(0, 1).toUpperCase() + replacement.slice(1).toLowerCase();
}
