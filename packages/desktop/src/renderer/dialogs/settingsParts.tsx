import { useId, useState } from "react";
import { FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { formatCount, parseWholeNumber } from "@table-craft/desktop/renderer/model/format.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import type { NumberRange, Settings } from "@table-craft/desktop/settings/settings.js";

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

interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly range: NumberRange;
  readonly check: (value: number) => string | null;
  readonly onValid: (value: number) => void;
  /** False for an identifier such as a port, which is never written with separators. */
  readonly grouped?: boolean;
}

/**
 * A whole-number field that saves only valid values and says what is wrong with the rest. It shows
 * the saved value with digit separators while not being edited (plan 130 decision 21).
 */
export function NumberField({ label, value, range, check, onValid, grouped = true }: NumberFieldProps) {
  const show = grouped ? formatCount : String;
  const id = useId();
  const errorId = useId();
  const [editing, setEditing] = useState(false);
  const { text, edit } = useDraft(value, String);
  const parsed = parseWholeNumber(text);
  const error = Number.isNaN(parsed) ? `${label} must be a whole number.` : check(parsed);
  return (
    <>
      <FieldRow label={label} htmlFor={id}>
        <TextInput
          id={id}
          inputMode="numeric"
          className="w-28 tabular-nums"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          value={editing || error !== null ? text : show(value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(event) => {
            const next = event.target.value;
            const number = parseWholeNumber(next);
            if (!Number.isNaN(number) && check(number) === null) {
              edit(next, number);
              onValid(number);
            } else {
              edit(next, value);
            }
          }}
        />
        <span className="text-ink-muted">
          {show(range.min)}–{show(range.max)}
        </span>
      </FieldRow>
      <FieldError id={errorId} error={error} />
    </>
  );
}
