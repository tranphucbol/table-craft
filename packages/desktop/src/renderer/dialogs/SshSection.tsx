import { useId } from "react";
import type { SshAuthMethod } from "@table-craft/desktop/engine/protocol.js";
import { DEFAULT_SSH_PORT } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { Button, Check, FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { SecretField } from "@table-craft/desktop/renderer/dialogs/SecretField.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { sshSecretField, type FormDraft, type SshDraft } from "@table-craft/desktop/renderer/model/datasourceForm.js";

const AUTH_LABEL: Readonly<Record<SshAuthMethod, string>> = {
  password: "Password",
  key: "Key pair",
  agent: "SSH agent",
};
const AUTH_METHODS = Object.keys(AUTH_LABEL) as readonly SshAuthMethod[];
const KEY_FILE_TITLE = "Private key";
const AGENT_NOTE = "Uses the keys loaded in the running SSH agent (SSH_AUTH_SOCK; on Windows, the OpenSSH agent).";

interface SshSectionProps {
  readonly draft: FormDraft;
  readonly encryption: { readonly available: boolean; readonly reason: string | null };
  readonly onChange: (change: Partial<FormDraft>) => void;
}

/**
 * The rows under SSH/SSL: the tunnel the session's database connection runs through (decision 070).
 * Its rows show only while the tunnel is on; the draft keeps their values meanwhile (plan 130 decision 16).
 */
export function SshSection({ draft, encryption, onChange }: SshSectionProps) {
  const hostId = useId();
  const portId = useId();
  const userId = useId();
  const authId = useId();
  const keyId = useId();
  const { ssh } = draft;
  const set = (patch: Partial<SshDraft>) => onChange({ ssh: { ...ssh, ...patch } });
  const secret = sshSecretField(ssh);
  return (
    <>
      <FieldRow label="">
        <Check label="Use SSH tunnel" checked={ssh.enabled} onChange={(enabled) => set({ enabled })} />
      </FieldRow>
      {ssh.enabled ? (
        <>
          <FieldRow label="SSH host" htmlFor={hostId}>
            <TextInput
              id={hostId}
              className="flex-1"
              placeholder="bastion.example.com"
              value={ssh.host}
              onChange={(event) => set({ host: event.target.value })}
            />
            <label htmlFor={portId} className="text-ink-muted">
              SSH port
            </label>
            <TextInput
              id={portId}
              className="w-24"
              inputMode="numeric"
              placeholder={String(DEFAULT_SSH_PORT)}
              value={ssh.port}
              onChange={(event) => set({ port: event.target.value })}
            />
          </FieldRow>
          <FieldRow label="SSH user" htmlFor={userId}>
            <TextInput
              id={userId}
              className="flex-1"
              value={ssh.user}
              onChange={(event) => set({ user: event.target.value })}
            />
          </FieldRow>
          <FieldRow
            label="Authentication"
            htmlFor={authId}
            hint={ssh.auth === "agent" ? AGENT_NOTE : undefined}
            hintLabel="About SSH agent"
          >
            <Dropdown
              id={authId}
              label="Authentication"
              variant="field"
              value={ssh.auth}
              options={AUTH_METHODS.map((method) => ({ value: method, label: AUTH_LABEL[method] }))}
              onChange={(value) => {
                const auth = AUTH_METHODS.find((method) => method === value);
                if (auth !== undefined) set({ auth });
              }}
            />
          </FieldRow>
          {ssh.auth === "key" ? (
            <FieldRow label={KEY_FILE_TITLE} htmlFor={keyId}>
              <TextInput
                id={keyId}
                className="flex-1"
                placeholder="~/.ssh/id_ed25519"
                value={ssh.keyPath}
                onChange={(event) => set({ keyPath: event.target.value })}
              />
              <Button
                onClick={() => {
                  void bridge()
                    .chooseFile(KEY_FILE_TITLE)
                    .then((chosen) => {
                      if (chosen.ok && chosen.value !== null) set({ keyPath: chosen.value });
                    });
                }}
              >
                Browse…
              </Button>
            </FieldRow>
          ) : null}
          {secret === null ? null : (
            <SecretField field={secret} draft={draft} encryption={encryption} onChange={onChange} />
          )}
        </>
      ) : null}
    </>
  );
}
