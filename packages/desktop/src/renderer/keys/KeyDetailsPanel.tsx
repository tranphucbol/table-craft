import type { KeyDetails } from "@table-craft/desktop/engine/protocol.js";
import { detailRows } from "@table-craft/desktop/renderer/model/keyHeader.js";

/** The facts the one-line header leaves out (plan 110), on the right of the value, open on demand. */
export function KeyDetailsPanel({ details }: { readonly details: KeyDetails }) {
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
            <dd className="min-w-0 truncate text-right font-grid text-ink tabular-nums" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
