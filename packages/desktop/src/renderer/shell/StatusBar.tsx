import { STATUS_ITEMS, type StatusItem } from "@table-craft/desktop/renderer/shell/statusItems.js";
import { ClusterStatus } from "@table-craft/desktop/renderer/keyAdmin/ClusterStatus.js";

function Items({ items }: { readonly items: readonly StatusItem[] }) {
  return items.map(({ id, Component }) => <Component key={id} />);
}

export function StatusBar() {
  return (
    <footer
      aria-label="Status bar"
      className="flex h-status-bar shrink-0 items-center justify-between gap-gap border-t border-line bg-panel px-gap text-ink-muted"
    >
      <div className="flex min-w-0 flex-1 items-center gap-gap">
        <ClusterStatus />
        <Items items={STATUS_ITEMS.filter((item) => item.side === "left")} />
      </div>
      <div className="flex items-center gap-gap">
        <Items items={STATUS_ITEMS.filter((item) => item.side === "right")} />
      </div>
    </footer>
  );
}
