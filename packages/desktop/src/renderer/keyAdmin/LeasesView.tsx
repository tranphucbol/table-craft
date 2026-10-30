import { useEffect, useRef, useState } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { bytesLabel, remainingTtl, useKeyAdmin, type AdminData } from "./store.js";
import { CommandButton, Fact, INPUT } from "./controls.js";

const TICK_MS = 1_000;
const CELL = "border-b border-line px-gap py-cell text-left align-top whitespace-normal break-words";
export function LeasesView({
  source,
  data,
  reason,
  initialLease,
}: {
  readonly source: string;
  readonly data: AdminData;
  readonly reason: string | null;
  readonly initialLease: string | undefined;
}) {
  const [selected, setSelected] = useState<string | null>(initialLease ?? null);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(Date.now);
  const renewing = Object.keys(data.renewals).length > 0;
  useEffect(() => {
    if (!renewing) return;
    const timer = setInterval(() => void useKeyAdmin.getState().refresh(source, "leases"), TICK_MS);
    return () => clearInterval(timer);
  }, [source, renewing]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const requested = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    requested.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const lease = data.leases.find((item) => item.id === selected);
  const page = selected === null ? undefined : data.leaseKeys[selected];
  const missing = initialLease !== undefined && selected === initialLease && lease === undefined && !data.loading;
  return (
    <>
      <div className="flex flex-wrap items-center gap-cell border-b border-line p-cell">
        <CommandButton source={source} command={{ kind: "grant" }} reason={reason}>
          Grant Lease…
        </CommandButton>
        {lease === undefined ? null : (
          <>
            <CommandButton source={source} command={{ kind: "once", leaseId: lease.id }} reason={reason}>
              Keep Alive Once
            </CommandButton>
            <CommandButton
              source={source}
              command={{ kind: "renew", leaseId: lease.id }}
              reason={reason}
              pressed={data.renewals[lease.id] !== undefined}
            >
              Keep Alive
            </CommandButton>
            <CommandButton source={source} command={{ kind: "revoke", leaseId: lease.id }} reason={reason}>
              Revoke…
            </CommandButton>
          </>
        )}
        <input
          aria-label="Search lease IDs"
          className={`${INPUT} ml-auto`}
          placeholder="Search lease IDs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed font-grid tabular-nums">
          <thead className="sticky top-0 bg-panel text-ink-muted">
            <tr>
              {["Lease ID", "Granted TTL", "Remaining", "Keys in namespace / global", "Kept alive by"].map((label) => (
                <th className={CELL} key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.leases
              .filter((item) => item.id.includes(search))
              .map((item) => (
                <tr
                  key={item.id}
                  ref={item.id === initialLease ? requested : undefined}
                  aria-selected={selected === item.id}
                  className={selected === item.id ? "bg-grid-selection" : "hover:bg-raised"}
                >
                  <td className={CELL}>
                    <button
                      type="button"
                      className="max-w-full select-text text-left break-all"
                      onClick={() => setSelected(item.id)}
                    >
                      {item.id} <span className="block text-ink-muted">0x{BigInt(item.id).toString(16)}</span>
                    </button>
                  </td>
                  <td className={CELL}>{item.grantedTtlSeconds ?? "Unknown"} s</td>
                  <td className={CELL}>
                    <span
                      className={
                        item.remainingTtlSeconds !== null && BigInt(item.remainingTtlSeconds) < 30n
                          ? "text-warning"
                          : ""
                      }
                    >
                      {remainingTtl(item, data.leaseReadAt, now)}
                    </span>
                  </td>
                  <td className={CELL}>
                    {item.scopedKeyCount ?? "Unknown"} / {item.totalKeyCount ?? "Unknown"}
                  </td>
                  <td className={CELL}>
                    {data.renewalStops[item.id] !== undefined
                      ? `Renewal stopped: ${data.renewalStops[item.id]}`
                      : data.renewals[item.id] === undefined
                        ? "Unknown"
                        : "TableCraft"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {data.leases.length === 0 ? (
        <p className="p-gap text-ink-muted">No leases. Grant a lease to set an expiry for attached keys.</p>
      ) : null}
      {missing ? (
        <p role="status" className="p-gap text-warning">
          Lease {initialLease} is not in the list. It may have expired or been revoked; refresh to check.
        </p>
      ) : lease === undefined ? (
        <p className="p-gap text-ink-muted">Select a lease to inspect its attached keys.</p>
      ) : (
        <section aria-label="Lease details" className="border-t border-line p-gap">
          <div className="flex flex-wrap items-center justify-between gap-gap">
            <h3 className="font-semibold">Lease {lease.id}</h3>
            <div className="flex gap-cell">
              <CommandButton source={source} command={{ kind: "keys", leaseId: lease.id }}>
                Read Attached Keys
              </CommandButton>
              <CommandButton source={source} reason={reason} command={{ kind: "attach", leaseId: lease.id }}>
                Attach Key…
              </CommandButton>
            </div>
          </div>
          <Fact name="State" value={lease.state} />
          <Fact
            name="Outside this namespace"
            value={lease.outsideNamespaceKeyCount ?? "Unknown — revocation may delete unseen keys"}
          />
          <p className="py-cell text-warning">
            Revoking is global and deletes all attached keys, including keys outside this namespace. Stopping renewal
            never revokes; the lease may then expire.
          </p>
          <ul>
            {page?.keys.map((key) => (
              <li key={key.hex ?? key.text}>
                <button
                  type="button"
                  className="h-row max-w-full truncate font-grid hover:bg-raised"
                  onClick={() => invoke(KEY_ACTION_IDS.open, { datasourceId: source, database: 0, key })}
                >
                  {bytesLabel(key)}
                </button>
              </li>
            ))}
          </ul>
          {page?.cursor == null ? null : (
            <CommandButton source={source} command={{ kind: "moreKeys", leaseId: lease.id }}>
              Load More Attached Keys
            </CommandButton>
          )}
        </section>
      )}
    </>
  );
}
