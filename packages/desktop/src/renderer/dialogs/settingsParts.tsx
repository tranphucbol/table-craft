import { useId, useState } from "react";
import { FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import type { NumberRange, Settings } from "@table-craft/desktop/settings/settings.js";

const WHOLE_NUMBER = /^\d+$/;

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
}

/** A whole-number field that saves only valid values and says what is wrong with the rest. */
export function NumberField({ label, value, range, check, onValid }: NumberFieldProps) {
  const id = useId();
  const errorId = useId();
  const { text, edit } = useDraft(value, String);
  const parsed = WHOLE_NUMBER.test(text) ? Number(text) : Number.NaN;
  const error = Number.isNaN(parsed) ? `${label} must be a whole number.` : check(parsed);
  return (
    <>
      <FieldRow label={label} htmlFor={id}>
        <TextInput
          id={id}
          inputMode="numeric"
          className="w-28"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          value={text}
          onChange={(event) => {
            const next = event.target.value.trim();
            const number = WHOLE_NUMBER.test(next) ? Number(next) : Number.NaN;
            if (!Number.isNaN(number) && check(number) === null) {
              edit(next, number);
              onValid(number);
            } else {
              edit(next, value);
            }
          }}
        />
        <span className="text-ink-muted">
          {range.min.toLocaleString("en-US")}–{range.max.toLocaleString("en-US")}
        </span>
      </FieldRow>
      <FieldError id={errorId} error={error} />
    </>
  );
}
