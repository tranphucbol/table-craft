import { looksLikeJson } from "@table-craft/desktop/renderer/model/jsonText.js";

export interface JsonViewInput {
  /** The value's text; null for NULL, bytes, or no value. */
  readonly text: string | null;
  /** The column is a declared JSON type. */
  readonly json: boolean;
  /** `data.detectJson`. */
  readonly detect: boolean;
  /** The column's `{}` choice in this result, when one was made. */
  readonly override: boolean | undefined;
}

export interface JsonViewState {
  /** Whether `{}` is offered. */
  readonly available: boolean;
  /** Whether the value shows formatted. */
  readonly on: boolean;
}

/** Neither an id nor a column name holds it. */
const KEY_SEPARATOR = "\u0000";

const UNAVAILABLE: JsonViewState = { available: false, on: false };

/** Whether a value panel offers the JSON view and shows it (plan 126 decisions 1, 5 and 6). */
export function jsonViewOf({ text, json, detect, override }: JsonViewInput): JsonViewState {
  if (text === null || (!json && !looksLikeJson(text))) return UNAVAILABLE;
  return { available: true, on: override ?? (json || detect) };
}

/** A result's columns share one choice each; a new handle (a re-run) starts from the default again. */
export function jsonOwnerKey(ownerId: string, handle: string): string {
  return `${ownerId}${KEY_SEPARATOR}${handle}`;
}

export function jsonColumnKey(owner: string, column: string): string {
  return `${owner}${KEY_SEPARATOR}${column}`;
}
