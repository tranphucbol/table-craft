import type { ReactNode } from "react";
import type { PluginOrigin } from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/**
 * Settings → Plugins is laid out looser than the other pages (plan 154): the user found the
 * default rows and gaps too tight for its cards and hints.
 */
export const LOOSE_GRID_CLASS = "grid grid-cols-[minmax(0,max-content)_1fr] items-start gap-x-gap gap-y-gap";

export function LooseTitle({ children, action }: { readonly children: string; readonly action?: ReactNode }) {
  return (
    <div className="col-span-2 mt-gap flex min-h-row-loose items-center gap-cell border-b border-line pt-gap pb-cell">
      <h3 className="flex-1 font-semibold text-ink-muted">{children}</h3>
      {action}
    </div>
  );
}

/** A labelled row whose hint and error sit right under its control. */
export function LooseRow({
  label,
  htmlFor,
  hint,
  error,
  errorId,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly errorId?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <label
        htmlFor={htmlFor}
        className="flex min-h-row-loose max-w-dialog-label min-w-0 items-center leading-tight text-ink-muted"
      >
        {label}
      </label>
      <div className="flex min-w-0 flex-col">
        <div className="flex min-h-row-loose min-w-0 flex-wrap items-center gap-cell">{children}</div>
        {error === undefined || error === null ? null : (
          <p id={errorId} role="alert" className="text-danger">
            {error}
          </p>
        )}
        {hint === undefined ? null : <p className="text-ink-muted">{hint}</p>}
      </div>
    </>
  );
}

/** A note under the page's rows, in the control column. */
export function LooseNote({ children }: { readonly children: ReactNode }) {
  return <p className="col-start-2 text-ink-muted">{children}</p>;
}

/** A registry's card: padded, its title line ruled off, its border danger while its token is refused. */
export function RegistryCard({
  title,
  danger = false,
  label,
  children,
}: {
  readonly title: ReactNode;
  readonly danger?: boolean;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-registry-card={label}
      className={cn("col-span-2 rounded border p-gap", danger ? "border-danger" : "border-line")}
    >
      <div className="mb-gap flex min-h-row-loose flex-wrap items-center gap-cell border-b border-line pb-cell">
        {title}
      </div>
      <div className={LOOSE_GRID_CLASS}>{children}</div>
    </section>
  );
}

// Whole class names, so Tailwind finds them when it scans the source.
const ORIGIN_TINT: Readonly<Record<PluginOrigin, string>> = {
  builtIn: "bg-ink-muted/15 text-ink-muted",
  development: "bg-ds-orange/25 text-ink",
  managed: "bg-ds-blue/25 text-ink",
  user: "bg-ds-violet/25 text-ink",
  registry: "bg-ds-green/25 text-ink",
  registryRemoved: "bg-warning/20 text-warning",
};

/** An installed plugin's source as a tinted badge, one colour per origin. */
export function OriginBadge({ origin, children }: { readonly origin: PluginOrigin; readonly children: string }) {
  return (
    <span
      data-plugin-origin={origin}
      title={children}
      className={cn("max-w-40 min-w-24 shrink-0 truncate rounded px-cell text-center", ORIGIN_TINT[origin])}
    >
      {children}
    </span>
  );
}

export function ScopeChip({ scope, onRemove }: { readonly scope: string; readonly onRemove?: () => void }) {
  return (
    <span className="inline-flex h-segment items-center gap-1 rounded border border-line bg-raised px-cell">
      {scope}
      {onRemove === undefined ? null : (
        <button
          type="button"
          aria-label={`Remove ${scope}`}
          className="press text-ink-muted hover:text-ink"
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </span>
  );
}
