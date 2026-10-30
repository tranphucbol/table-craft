import type { KeyBytes } from "@table-craft/desktop/engine/protocol.js";
import { parseKeyJson } from "@table-craft/desktop/renderer/model/keyMerge.js";
import { normalizedKeyYaml, parseKeyYaml } from "@table-craft/desktop/renderer/model/valueFormats.js";

const JSON_INDENT = 2;
const MAX_DIFF_CELLS = 250_000;

export interface DiffLine {
  readonly kind: "same" | "delete" | "insert";
  readonly text: string;
  readonly left: number | null;
  readonly right: number | null;
}

export interface DiffPair {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

/** Pair replacements so a removed line faces its replacement, not an unrelated gap. */
export function alignDiff(lines: readonly DiffLine[]): readonly DiffPair[] {
  const pairs: DiffPair[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind === "same") {
      pairs.push({ left: line, right: line });
      index++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index]?.kind !== "same") {
      const change = lines[index++];
      if (change?.kind === "delete") removed.push(change);
      if (change?.kind === "insert") added.push(change);
    }
    for (let row = 0; row < Math.max(removed.length, added.length); row++) {
      pairs.push({ left: removed[row] ?? null, right: added[row] ?? null });
    }
  }
  return pairs;
}

/** Null means absent, not a present empty value. Binary values are never decoded lossily. */
export function diffText(value: KeyBytes | null): string {
  if (value === null) return "(key absent)";
  if (value.hex !== null) return `Binary value (hex)\n${value.hex}`;
  try {
    const parsed: unknown = parseKeyJson(value.text);
    return JSON.stringify(parsed, null, JSON_INDENT);
  } catch {
    try {
      return normalizedKeyYaml(parseKeyYaml(value.text));
    } catch {
      return value.text;
    }
  }
}

/** Bounded LCS: large documents fall back to an honest whole-document replacement. */
export function keyDiff(before: string, after: string): readonly DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_DIFF_CELLS) {
    if (before === after) return a.map((text, index) => ({ kind: "same", text, left: index + 1, right: index + 1 }));
    return [
      ...a.map((text, index): DiffLine => ({ kind: "delete", text, left: index + 1, right: null })),
      ...b.map((text, index): DiffLine => ({ kind: "insert", text, left: null, right: index + 1 })),
    ];
  }
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = matrix[i];
      const next = matrix[i + 1];
      if (row !== undefined && next !== undefined) {
        row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] ?? "", left: ++i, right: ++j });
    } else if (i < a.length && (j === b.length || (matrix[i + 1]?.[j] ?? 0) >= (matrix[i]?.[j + 1] ?? 0))) {
      lines.push({ kind: "delete", text: a[i] ?? "", left: ++i, right: null });
    } else {
      lines.push({ kind: "insert", text: b[j] ?? "", left: null, right: ++j });
    }
  }
  return lines;
}
