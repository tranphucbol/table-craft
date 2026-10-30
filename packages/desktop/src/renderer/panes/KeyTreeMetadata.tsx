import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyEntryNode } from "@table-craft/desktop/renderer/model/keyTree.js";
import { keyIdentity, ttlText } from "@table-craft/desktop/renderer/model/keyTree.js";
import { detectFormat, isKubernetesEnvelope, valueBytes } from "@table-craft/desktop/renderer/model/valueFormats.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import { useKeyTabs } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { KeyIcon } from "@table-craft/desktop/renderer/ui/icons.js";

const TICK_MS = 1000;
const WARNING_MS = 30_000;
const listeners = new Set<() => void>();
let clock = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => clock;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    clock = Date.now();
    timer = setInterval(() => {
      clock = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const CONTENT_TONES: Readonly<Record<string, string>> = {
  JSON: "bg-ds-blue",
  YAML: "bg-ds-violet",
  TEXT: "bg-ds-green",
  K8S: "bg-ds-orange",
  BIN: "bg-ink-muted",
};

/** Uses only values already read by an open editor, never a decoration-only value request. */
export function KeyTreeContent({ node }: { readonly node: KeyEntryNode }) {
  const tab = useKeyTabs((state) =>
    Object.values(state.tabs).find(
      (candidate) =>
        candidate.datasourceId === node.datasourceId &&
        candidate.database === node.database &&
        keyIdentity(candidate.key) === keyIdentity(node.key),
    ),
  );
  const bytes = valueBytes(tab?.value ?? undefined);
  if (bytes === null) return <KeyIcon aria-hidden className="size-icon shrink-0 text-key-icon" />;
  const format = detectFormat(bytes);
  const label = isKubernetesEnvelope(bytes)
    ? "K8S"
    : format === "json"
      ? "JSON"
      : format === "yaml"
        ? "YAML"
        : format === "text"
          ? "TEXT"
          : "BIN";
  return (
    <span
      aria-label={label}
      className={cn(
        "shrink-0 rounded-sm px-1 py-1 font-mono font-semibold text-canvas leading-none",
        CONTENT_TONES[label],
      )}
    >
      {label}
    </span>
  );
}

function LeaseCountdown({ node, leaseId }: { readonly node: KeyEntryNode; readonly leaseId: string }) {
  const ttl = useKeys((state) => state.keyspaces[node.datasourceId]?.leaseTtls?.[leaseId]);
  const now = useSyncExternalStore(subscribe, snapshot, snapshot);
  const seconds = ttl?.seconds === null || ttl?.seconds === undefined ? null : Number(ttl.seconds);
  const remaining = seconds === null ? null : Math.max(0, seconds * TICK_MS - (now - (ttl?.readAt ?? now)));
  const phase =
    remaining === null ? "unknown" : remaining === 0 ? "expired" : remaining < WARNING_MS ? "warning" : "active";
  const previous = useRef(phase);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (phase !== previous.current && (phase === "warning" || phase === "expired"))
      setAnnouncement(
        `${node.key.text}: ${phase === "expired" ? "lease expired; refresh to check the key" : "lease expires in under 30 seconds"}`,
      );
    previous.current = phase;
  }, [phase, node.key.text]);
  return (
    <>
      <span
        title={`Lease ${leaseId}${ttl === undefined ? "; reading TTL" : seconds === null ? "; TTL unknown" : "; estimated from last lease read; another client may renew it"}`}
        className={cn("tabular-nums", phase === "warning" || phase === "expired" ? "text-warning" : "text-ink-muted")}
      >
        {remaining === null
          ? "◷ lease · TTL unknown"
          : remaining === 0
            ? "◷ expired · refresh"
            : `◷ ${ttlText(remaining)}`}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

export function KeyTreeMetadata({ node }: { readonly node: KeyEntryNode }) {
  const revision = node.revision;
  return (
    <>
      {revision === undefined ? null : (
        <span
          className="text-ink-muted tabular-nums"
          title={`Version ${revision.version}; modified revision ${revision.modRevision}`}
        >
          v{revision.version}
        </span>
      )}
      {revision === undefined || revision.lease === "0" ? null : (
        <LeaseCountdown node={node} leaseId={revision.lease} />
      )}
    </>
  );
}
