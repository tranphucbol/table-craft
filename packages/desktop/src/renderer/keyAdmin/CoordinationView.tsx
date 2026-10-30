import { useState } from "react";
import type { CoordinationCandidate } from "@table-craft/desktop/engine/protocol.js";
import { bytesLabel, type AdminData } from "./store.js";
import { CELL, CommandButton } from "./controls.js";

export function orderedCandidates(candidates: readonly CoordinationCandidate[]): readonly CoordinationCandidate[] {
  return [...candidates].sort((left, right) =>
    BigInt(left.createRevision) < BigInt(right.createRevision)
      ? -1
      : BigInt(left.createRevision) > BigInt(right.createRevision)
        ? 1
        : 0,
  );
}
export function CoordinationView({
  source,
  data,
  reason,
}: {
  readonly source: string;
  readonly data: AdminData;
  readonly reason: string | null;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="p-gap">
      <p className="pb-gap text-ink-muted">
        Only configured prefixes are shown. Queue order uses creation revisions, not elapsed time. Incomplete queues
        cannot establish the holder.
      </p>
      {data.prefixes.length === 0 ? (
        <p>No lock or election prefixes set. Add prefixes in Data Sources → Advanced.</p>
      ) : null}
      {data.prefixes.map((prefix) => {
        const page = data.queues[prefix.id];
        return (
          <section className="mb-gap border border-line" key={prefix.id}>
            <header className="flex flex-wrap items-center justify-between gap-gap bg-panel p-cell">
              <h3 className="font-grid">
                {prefix.kind}: {bytesLabel(prefix.prefix)}
              </h3>
              <CommandButton source={source} command={{ kind: "queue", prefixId: prefix.id }}>
                Read Queues
              </CommandButton>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    {["Name", "Holder / leader", "Waiting", "Held for", "Lease"].map((label) => (
                      <th className={CELL} key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page?.queues.map((queue) => {
                    const key = bytesLabel(queue.name);
                    const candidates = orderedCandidates(queue.candidates);
                    const holder = queue.complete ? candidates[0] : undefined;
                    const open = expanded.has(key);
                    return (
                      <tr key={key}>
                        <td className={CELL}>
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() =>
                              setExpanded(
                                new Set(open ? [...expanded].filter((name) => name !== key) : [...expanded, key]),
                              )
                            }
                          >
                            {open ? "▾" : "▸"} {key}
                          </button>
                          {open ? (
                            <ol className="py-cell">
                              {candidates.map((candidate) => (
                                <li key={bytesLabel(candidate.key)} className="select-text py-cell font-grid">
                                  {bytesLabel(candidate.key)} · created rev {candidate.createRevision} · lease{" "}
                                  {candidate.leaseId}
                                </li>
                              ))}
                            </ol>
                          ) : null}
                        </td>
                        <td className={`${CELL} font-grid`}>
                          {holder === undefined
                            ? "Unknown — incomplete queue"
                            : queue.kind === "election"
                              ? bytesLabel(holder.value)
                              : bytesLabel(holder.key)}
                        </td>
                        <td className={CELL}>{queue.complete ? Math.max(0, candidates.length - 1) : "Unknown"}</td>
                        <td className={CELL}>
                          {holder === undefined
                            ? "Unknown"
                            : `${BigInt(page?.revision ?? holder.createRevision) - BigInt(holder.createRevision)} revisions`}
                        </td>
                        <td className={CELL}>
                          {holder === undefined ? (
                            "Unknown"
                          ) : (
                            <CommandButton
                              source={source}
                              reason={reason}
                              command={{ kind: "revoke", leaseId: holder.leaseId }}
                            >
                              Release by Revoking {holder.leaseId}…
                            </CommandButton>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {page?.cursor == null ? null : (
              <CommandButton source={source} command={{ kind: "moreQueue", prefixId: prefix.id }}>
                Load More Queues
              </CommandButton>
            )}
          </section>
        );
      })}
    </div>
  );
}
