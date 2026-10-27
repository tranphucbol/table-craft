import { useEffect, useState } from "react";
import { attributeFacts, keyInfoParts, ttlLabel } from "@table-craft/desktop/renderer/model/keyHeader.js";
import { databaseLabel } from "@table-craft/desktop/renderer/model/keyTree.js";
import { remainingTtl, type KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { KeyTypeBadge } from "@table-craft/desktop/renderer/ui/KeyTypeBadge.js";

const TICK_MS = 1000;

/** The TTL left now; it ticks each second while the key expires. */
function useRemainingTtl(tab: KeyTab): number | null {
  const [now, setNow] = useState(() => Date.now());
  const expires = tab.details?.ttlMs != null;
  useEffect(() => {
    if (!expires) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [expires]);
  return remainingTtl(tab.details, tab.readAt, now);
}

interface KeyHeaderProps {
  readonly tab: KeyTab;
  readonly datasourceName: string;
  /** Called once when the countdown reaches zero, so the tab rereads the key the server dropped. */
  readonly onExpired: () => void;
}

/** The key tab's header (plan 058 decision 18): type, name, live TTL and what the server says of the key. */
export function KeyHeader({ tab, datasourceName, onExpired }: KeyHeaderProps) {
  const remaining = useRemainingTtl(tab);
  const expired = remaining === 0;
  const readAt = tab.readAt;
  useEffect(() => {
    if (expired) onExpired();
  }, [expired, readAt, onExpired]);
  const compact = tab.details?.attributes !== undefined;
  const parts = tab.details === null || compact ? [] : keyInfoParts(tab.details);
  const facts = tab.details === null ? [] : attributeFacts(tab.details);
  const showTtl = tab.details?.type != null && (!compact || remaining !== null);
  return (
    <div data-testid="key-header" className="flex shrink-0 flex-col gap-1 border-b border-line bg-panel p-gap">
      <div className="flex min-w-0 items-center gap-gap">
        <KeyTypeBadge info={tab.details} />
        <span data-testid="key-name" className="truncate font-mono text-ink" title={tab.key.text}>
          {tab.key.text}
        </span>
        {facts.length === 0 ? null : (
          <span data-testid="key-facts" className="shrink-0 text-ink-muted tabular-nums">
            {facts.join(" · ")}
          </span>
        )}
        {!showTtl ? null : (
          <span data-testid="key-ttl" className="shrink-0 text-ink-muted">
            {ttlLabel(remaining)}
          </span>
        )}
        <span className="ml-auto shrink-0 truncate text-ink-muted">
          {datasourceName} · {databaseLabel(tab.database)}
        </span>
      </div>
      {parts.length === 0 ? null : (
        <div data-testid="key-info" className="truncate text-ink-muted">
          {parts.join(" · ")}
        </div>
      )}
    </div>
  );
}
