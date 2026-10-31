import { STATUS_ITEMS, type StatusItem } from "@table-craft/desktop/renderer/shell/statusItems.js";
import { ClusterStatus } from "@table-craft/desktop/renderer/keyAdmin/ClusterStatus.js";
import { FRAME_SURFACE } from "@table-craft/desktop/renderer/shell/islands.js";
import { useIslands } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

function Items({ items }: { readonly items: readonly StatusItem[] }) {
  return items.map(({ id, Component }) => <Component key={id} />);
}

export function StatusBar() {
  const islands = useIslands();
  return (
    <footer
      aria-label="Status bar"
      className={cn(
        "flex h-status-bar shrink-0 items-center justify-between gap-gap bg-panel px-gap text-ink-muted",
        islands ? FRAME_SURFACE : "border-t border-line",
      )}
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
