import { useId } from "react";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { ProbeResult } from "@table-craft/desktop/engine/protocol.js";
import { Button, FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  endpointRows,
  endpointRowsChange,
  MAX_CONNECTION_ENDPOINTS,
} from "@table-craft/desktop/renderer/model/datasourceConnection.js";
import type { FormDraft } from "@table-craft/desktop/renderer/model/datasourceForm.js";

interface Props {
  readonly draft: FormDraft;
  readonly plugin: PluginInfo;
  readonly onChange: (change: Partial<FormDraft>) => void;
  readonly endpointTests?: readonly ProbeResult[];
}

function EndpointProbe({ result, number }: { readonly result: ProbeResult | undefined; readonly number: number }) {
  if (result === undefined) return null;
  return (
    <span
      data-testid={`endpoint-test-${String(number)}`}
      data-ok={result.ok}
      role="status"
      className={result.ok ? "text-success" : "text-danger"}
      title={
        result.ok
          ? "Connection succeeded through the configured transport"
          : `${result.error.message} ${result.error.hint}`
      }
    >
      {result.ok ? "✓" : "✗"}
      <span className="sr-only">
        Endpoint {number} {result.ok ? "succeeded" : "failed"}
      </span>
    </span>
  );
}

/** Edits the scalar endpoint list without changing its persisted transport contract. */
export function EndpointConnection({ draft, plugin, onChange, endpointTests }: Props) {
  const id = useId();
  const rows = endpointRows(draft, plugin);
  const mode = plugin.tls?.mode;
  const secure =
    mode !== undefined &&
    typeof draft.values[mode] === "string" &&
    draft.values[mode] !== "disable" &&
    draft.values[mode] !== "";
  const update = (next: readonly string[]) => onChange(endpointRowsChange(draft, plugin, next));
  return (
    <>
      {rows.map((row, index) => (
        <FieldRow key={index} label={index === 0 ? "Endpoints" : ""} htmlFor={`${id}-${String(index)}`}>
          <span className="text-ink-muted">{secure ? "https://" : "http://"}</span>
          <TextInput
            id={`${id}-${String(index)}`}
            aria-label={`Endpoint ${String(index + 1)}`}
            className="flex-1"
            placeholder="host:2379"
            value={row}
            onChange={(event) => update(rows.map((value, at) => (at === index ? event.target.value : value)))}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (!text.includes(",") && !text.includes("\n")) return;
              event.preventDefault();
              update([...rows.slice(0, index), ...text.trim().split(/[,\n]/), ...rows.slice(index + 1)]);
            }}
          />
          <Button
            aria-label={`Remove endpoint ${String(index + 1)}`}
            disabled={rows.length === 1}
            onClick={() => update(rows.filter((_, at) => at !== index))}
          >
            −
          </Button>
          <EndpointProbe result={endpointTests?.[index]} number={index + 1} />
        </FieldRow>
      ))}
      <div className="col-start-2">
        <Button disabled={rows.length >= MAX_CONNECTION_ENDPOINTS} onClick={() => update([...rows, ""])}>
          + Add endpoint
        </Button>
      </div>
      <p className="col-start-2 text-ink-muted">
        Paste host:port or a full HTTP(S) URL. All endpoints share the TLS mode below; changing a URL scheme changes it
        for the whole list. Mixed URL schemes are refused. Test Connection checks the pool's cluster identity and each
        endpoint through the same SSH/TLS settings. Only configured targets are dialed.
      </p>
    </>
  );
}

/** TLS switch retains verification choices rather than downgrading to unverified encryption. */
export function EndpointTls({ draft, plugin, onChange }: Props) {
  const skipId = useId();
  const mode = plugin.tls?.mode;
  if (mode === undefined) return null;
  const enabled =
    typeof draft.values[mode] === "string" && draft.values[mode] !== "disable" && draft.values[mode] !== "";
  return (
    <>
      <FieldRow label="Use TLS">
        <label className="flex items-center gap-cell">
          <input
            aria-label="Use TLS"
            type="checkbox"
            checked={enabled}
            onChange={(event) =>
              onChange({ values: { ...draft.values, [mode]: event.target.checked ? "verify-full" : "disable" } })
            }
          />
          Encrypt every configured endpoint
        </label>
      </FieldRow>
      {enabled ? (
        <FieldRow label="Skip certificate verification" htmlFor={skipId}>
          <label className="flex items-center gap-cell text-danger">
            <input
              id={skipId}
              type="checkbox"
              checked={draft.values[mode] === "require"}
              onChange={(event) =>
                onChange({ values: { ...draft.values, [mode]: event.target.checked ? "require" : "verify-full" } })
              }
            />
            Only for test clusters
          </label>
        </FieldRow>
      ) : null}
      {draft.values[mode] === "require" || draft.values[mode] === "verify-ca" ? (
        <p role="alert" className="col-start-2 text-danger">
          {draft.values[mode] === "require"
            ? "Certificate verification is skipped. Only for test clusters."
            : "Certificate hostname verification is skipped. Use Verify full to verify endpoint identity."}
        </p>
      ) : null}
    </>
  );
}
