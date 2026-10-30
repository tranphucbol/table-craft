import { useId } from "react";
import { SECRET_MODES, type ConnectionField, type SecretMode } from "@table-craft/desktop/preload/bridge.js";
import { Button, FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { secretPlaceholder, type FormDraft } from "@table-craft/desktop/renderer/model/datasourceForm.js";

export const SECRET_MODE_LABEL: Readonly<Record<SecretMode, string>> = {
  forever: "Forever",
  untilRestart: "Until restart",
  never: "Never",
};

export interface SecretFieldProps {
  readonly field: ConnectionField;
  readonly draft: FormDraft;
  readonly encryption: { readonly available: boolean; readonly reason: string | null };
  readonly onChange: (change: Partial<FormDraft>) => void;
}

/** A secret input with its save mode (decision 020): blank keeps what is stored, Clear forgets it. */
export function SecretField({ field, draft, encryption, onChange }: SecretFieldProps) {
  const id = useId();
  const change = draft.secrets[field.key] ?? { action: "keep" };
  const mode = draft.secretModes[field.key] ?? "never";
  const stored = draft.storedSecrets.includes(field.key);
  return (
    <FieldRow label={field.label} htmlFor={id}>
      <TextInput
        id={id}
        type="password"
        className="flex-1"
        placeholder={secretPlaceholder(draft, field.key)}
        value={change.action === "set" ? change.value : ""}
        onChange={(event) =>
          onChange({
            secrets: {
              ...draft.secrets,
              [field.key]:
                event.target.value === "" ? { action: "keep" } : { action: "set", value: event.target.value },
            },
          })
        }
      />
      <Dropdown
        label={`Save ${field.label.toLowerCase()}`}
        variant="field"
        value={mode}
        title={encryption.available ? undefined : (encryption.reason ?? undefined)}
        options={SECRET_MODES.map((option) => ({
          value: option,
          label: SECRET_MODE_LABEL[option],
          disabled: option === "forever" && !encryption.available,
        }))}
        onChange={(value) => {
          const chosen = SECRET_MODES.find((option) => option === value);
          if (chosen !== undefined) onChange({ secretModes: { ...draft.secretModes, [field.key]: chosen } });
        }}
      />
      {stored || change.action === "clear" ? (
        <Button
          disabled={change.action === "clear"}
          onClick={() => onChange({ secrets: { ...draft.secrets, [field.key]: { action: "clear" } } })}
        >
          Clear
        </Button>
      ) : null}
    </FieldRow>
  );
}
