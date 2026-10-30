import type { KeyDetails } from "@table-craft/desktop/engine/protocol.js";
import { detailRows } from "@table-craft/desktop/renderer/model/keyHeader.js";
import type { KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import {
  keyValueSize,
  DEFAULT_REQUEST_BYTES,
  SIZE_REFERENCE_NOTICE,
  SIZE_WARNING_RATIO,
  SIZE_DANGER_RATIO,
} from "@table-craft/desktop/renderer/keys/keyValueFacts.js";
import { useRemainingLease } from "@table-craft/desktop/renderer/keys/useLeaseClock.js";
import { ttlLabel } from "@table-craft/desktop/renderer/model/keyHeader.js";
import { formatBytes } from "@table-craft/desktop/renderer/model/format.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { invoke, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { KEY_LEASE_EDITOR_IDS } from "@table-craft/desktop/renderer/actions/keyLeaseEditorActions.js";
import { ADMIN_ACTION_IDS } from "@table-craft/desktop/renderer/keyAdmin/actions.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";

/** The facts the one-line header leaves out (plan 110), on the right of the value, open on demand. */
export function KeyDetailsPanel({ details, tab }: { readonly details: KeyDetails; readonly tab: KeyTab }) {
  const size = keyValueSize(tab);
  const ttl = useRemainingLease(tab);
  const ratio = size === null ? 0 : size / DEFAULT_REQUEST_BYTES;
  const leaseCapable = useDatasources((state) => {
    const source = state.datasources.find((item) => item.id === tab.datasourceId);
    return source !== undefined && capabilitiesOf(state.plugins, source.pluginId).includes("leases");
  });
  const leaseEditable = useActionEnabled(KEY_LEASE_EDITOR_IDS.keep);
  return (
    <aside
      aria-label="Key details"
      data-testid="key-details"
      className="flex w-plan-details shrink-0 flex-col overflow-auto border-l border-line bg-panel"
    >
      <h2 className="flex h-row shrink-0 items-center border-b border-line px-gap font-semibold text-ink">Details</h2>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-gap gap-y-1 p-gap">
        {detailRows(details).map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-ink-muted">{row.label}</dt>
            <dd
              className="min-w-0 break-all text-right font-grid text-ink tabular-nums select-all"
              title="Select to copy the full value."
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {tab.revisionGuardAvailable !== true || size === null ? null : (
        <div className="space-y-1 border-t border-line p-gap text-ink-muted" title={SIZE_REFERENCE_NOTICE}>
          <p
            className={cn(
              "tabular-nums",
              ratio >= SIZE_DANGER_RATIO ? "text-danger" : ratio >= SIZE_WARNING_RATIO && "text-warning",
            )}
          >
            {tab.stringValue !== null || tab.merge != null ? "Pending value" : "Value"}: {formatBytes(size)}
          </p>
          <meter
            className="w-full accent-plan-bar"
            min={0}
            max={DEFAULT_REQUEST_BYTES}
            value={Math.min(size, DEFAULT_REQUEST_BYTES)}
            aria-label="Value bytes compared with the default request limit"
          />
          <p>Default request limit: 1.5 MiB</p>
          <p>Server limit not measured. Key and transaction overhead are extra.</p>
          {tab.stringProblem != null ? <p>Size shows the last valid value.</p> : null}
        </div>
      )}
      {ttl === null ? null : <p className="border-t border-line p-gap text-ink-muted tabular-nums">{ttlLabel(ttl)}</p>}
      {tab.leaseAssignmentAvailable !== true || !leaseCapable ? null : (
        <section aria-label="Lease on save" className="space-y-gap border-t border-line p-gap">
          <p className="text-ink-muted">
            Lease:{" "}
            <span className="font-grid text-ink select-all">
              {tab.merge?.snapshot.revision?.lease ?? details.revision?.lease ?? "0"}
            </span>
          </p>
          {(tab.merge?.snapshot.revision?.lease ?? details.revision?.lease ?? "0") === "0" ? null : (
            <button
              type="button"
              className="text-ink-muted hover:text-ink hover:underline"
              onClick={() =>
                void invoke(ADMIN_ACTION_IDS.leases, {
                  datasourceId: tab.datasourceId,
                  leaseId: tab.merge?.snapshot.revision?.lease ?? details.revision?.lease,
                })
              }
            >
              Open in Leases
            </button>
          )}
          <label
            className="flex items-center gap-gap"
            title="Keep the current lease, including when restoring an older value."
          >
            <input
              type="checkbox"
              checked={tab.leaseDraft == null || tab.leaseDraft.kind === "preserve"}
              disabled={!leaseEditable}
              onChange={(event) =>
                void invoke(event.target.checked ? KEY_LEASE_EDITOR_IDS.keep : KEY_LEASE_EDITOR_IDS.detach)
              }
            />
            On save: Keep lease
          </label>
          {tab.leaseDraft?.kind === "attach" ? (
            <p className="break-all">Pending attachment: {tab.leaseDraft.leaseId}</p>
          ) : tab.leaseDraft?.kind === "detach" ? (
            <p>Pending: detach lease. The key will not expire with it.</p>
          ) : null}
          <div className="flex flex-wrap gap-gap">
            <ActionButton actionId={KEY_LEASE_EDITOR_IDS.attach} />
            <ActionButton actionId={KEY_LEASE_EDITOR_IDS.grant} />
          </div>
          <p className="text-ink-muted">
            Leases are cluster-wide. Expiry deletes every attached key, including keys outside this namespace. Detaching
            never revokes a lease.
          </p>
        </section>
      )}
    </aside>
  );
}
