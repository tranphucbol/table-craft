/** Longer text is never parsed to see whether it is JSON (plan 126 decision 1). */
export const JSON_DETECT_MAX_CHARS = 1_000_000;

const CLOSERS: Readonly<Record<string, string>> = { "{": "}", "[": "]" };

export function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether a text value is a JSON object or array; bare strings, numbers and literals stay text. */
export function looksLikeJson(text: string): boolean {
  if (text.length > JSON_DETECT_MAX_CHARS) return false;
  const trimmed = text.trim();
  const closer = CLOSERS[trimmed.charAt(0)];
  return closer !== undefined && trimmed.endsWith(closer) && parsesAsJson(trimmed);
}

/** Drops the whitespace outside strings without parsing, so every digit and escape stays as written. */
export function compactJson(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      continue;
    } else if (char === '"') {
      inString = true;
    }
    out += char;
  }
  return out;
}

export interface StoredJson {
  readonly text: string;
  /** False when the edited text is not JSON; it is then stored as typed. */
  readonly valid: boolean;
}

/**
 * What an edit made in the formatted view writes (plan 126 decision 9): compact when the stored
 * text was compact, otherwise as typed.
 */
export function storedJson(edited: string, initial: string): StoredJson {
  if (!parsesAsJson(edited)) return { text: edited, valid: false };
  return { text: compactJson(initial) === initial ? compactJson(edited) : edited, valid: true };
}
