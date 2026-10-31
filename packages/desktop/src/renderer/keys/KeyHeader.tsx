import { useEffect } from "react";
import { attributeFacts, keyInfoParts, ttlLabel } from "@table-craft/desktop/renderer/model/keyHeader.js";
import { databaseLabel } from "@table-craft/desktop/renderer/model/keyTree.js";
import type { KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { KeyTypeBadge } from "@table-craft/desktop/renderer/ui/KeyTypeBadge.js";
import {
  keyValueSize,
  DEFAULT_REQUEST_BYTES,
  SIZE_WARNING_RATIO,
  SIZE_DANGER_RATIO,
  SIZE_REFERENCE_NOTICE,
} from "@table-craft/desktop/renderer/keys/keyValueFacts.js";
import { formatBytes } from "@table-craft/desktop/renderer/model/format.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { useRemainingLease, LEASE_WARNING_MS } from "@table-craft/desktop/renderer/keys/useLeaseClock.js";

interface KeyHeaderProps {
  readonly tab: KeyTab;
  readonly datasourceName: string;
  /** Called once when the countdown reaches zero, so the tab rereads the key the server dropped. */
  readonly onExpired: () => void;
}

/** The key tab's header (plan 058 decision 18): type, name, live TTL and what the server says of the key. */
export function KeyHeader({ tab, datasourceName, onExpired }: KeyHeaderProps) {
  const remaining = useRemainingLease(tab);
  const urgent = remaining !== null && remaining < LEASE_WARNING_MS;
  const expired = remaining === 0;
  const readAt = tab.readAt;
  useEffect(() => {
    if (expired) onExpired();
  }, [expired, readAt, onExpired]);
  const announcement = expired
    ? "The key's lease has expired."
    : urgent
      ? "The key's lease expires in less than 30 seconds."
      : "";
  const compact = tab.details?.attributes !== undefined;
  const parts = tab.details === null || compact ? [] : keyInfoParts(tab.details);
  const size = keyValueSize(tab);
  const shownDetails = tab.details === null || size === null ? tab.details : { ...tab.details, length: size };
  const facts = shownDetails === null ? [] : attributeFacts(shownDetails);
  const pending = tab.stringValue !== null || tab.merge != null;
  const showTtl = tab.details?.type != null && (!compact || remaining !== null);
  return (
    <div data-testid="key-header" className="flex shrink-0 flex-col gap-1 border-b border-line bg-panel p-gap">
      <div className="flex min-w-0 items-center gap-gap">
        <KeyTypeBadge info={tab.details} />
        <span data-testid="key-name" className="truncate font-grid text-ink" title={tab.key.text}>
          {tab.key.text}
        </span>
        {facts.length === 0 ? null : (
          <span
            data-testid="key-facts"
            className={cn(
              "shrink-0 text-ink-muted tabular-nums",
              size !== null && size >= DEFAULT_REQUEST_BYTES * SIZE_DANGER_RATIO
                ? "text-danger"
                : size !== null && size >= DEFAULT_REQUEST_BYTES * SIZE_WARNING_RATIO && "text-warning",
            )}
            title={
              size === null
                ? undefined
                : `${pending ? "Pending value: " : "Value: "}${formatBytes(size)}. ${SIZE_REFERENCE_NOTICE}${tab.stringProblem != null ? " Showing the last valid value." : ""}`
            }
          >
            {facts.join(" · ")}
          </span>
        )}
        {!showTtl ? null : (
          <span data-testid="key-ttl" className={cn("shrink-0 text-ink-muted tabular-nums", urgent && "text-warning")}>
            {ttlLabel(remaining)}
          </span>
        )}
        <span className="ml-auto shrink-0 truncate text-ink-muted">
          {datasourceName} · {databaseLabel(tab.database)}
        </span>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {parts.length === 0 ? null : (
        <div data-testid="key-info" className="truncate text-ink-muted">
          {parts.join(" · ")}
        </div>
      )}
    </div>
  );
}
