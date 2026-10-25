import { useState } from "react";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import type { Settings } from "@table-craft/desktop/settings/settings.js";

/** Saves a change to the settings; main broadcasts the result to every window. */
export function update(patch: (current: Settings) => Settings): void {
  void useSettings.getState().update(patch);
}

export function SectionTitle({ children }: { readonly children: string }) {
  return <h3 className="col-span-2 mt-gap border-b border-line pb-1 font-semibold text-ink-muted">{children}</h3>;
}

export function FieldError({ id, error }: { readonly id: string; readonly error: string | null }) {
  if (error === null) return null;
  return (
    <p id={id} role="alert" className="col-start-2 text-danger">
      {error}
    </p>
  );
}

/**
 * What a text field shows: the user's text while it differs from the saved value only because it
 * is not valid yet, otherwise the saved value, so Restore Defaults and other windows show through.
 */
export function useDraft<T>(value: T, show: (value: T) => string) {
  const [draft, setDraft] = useState<{ readonly text: string; readonly basis: T } | null>(null);
  const text = draft !== null && draft.basis === value ? draft.text : show(value);
  return { text, edit: (next: string, basis: T) => setDraft({ text: next, basis }) };
}
