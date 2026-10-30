import { useState } from "react";
import type { ClusterStatus } from "@table-craft/desktop/engine/protocol.js";
import { memberLag, removalBlocked, type AdminData, type AdminView } from "./store.js";
import { CELL, CommandButton, Fact, INPUT } from "./controls.js";
import { TaskRows } from "./TaskRows.js";

export function endpointOrder(data: AdminData): readonly string[] {
  return [...data.endpoints]
    .sort((a, b) => {
      const leader = (id: string) =>
        data.statuses.some((status) => status.endpointId === id && status.memberId === status.leaderId);
      return Number(leader(a.id)) - Number(leader(b.id));
    })
    .map((endpoint) => endpoint.id);
}
function Storage({ status }: { readonly status: ClusterStatus | undefined }) {
  const allocated = status?.dbBytes ?? null;
  const used = status?.inUseBytes ?? null;
  const quota = status?.quotaBytes ?? null;
  const percent =
    allocated !== null && quota !== null && BigInt(quota) > 0n
      ? Number((BigInt(allocated) * 100n) / BigInt(quota))
      : null;
  return (
    <div>
      <span>
        {allocated ?? "Unknown"} bytes / {quota ?? "Unknown quota"} · {used ?? "Unknown"} in use
      </span>
      {percent === null ? null : (
        <meter aria-label="Database quota used" min={0} max={100} value={percent} className="block w-full" />
      )}
    </div>
  );
}
export function ClusterView({
  source,
  data,
  view,
  reason,
}: {
  readonly source: string;
  readonly data: AdminData;
  readonly view: AdminView;
  readonly reason: string | null;
}) {
  const [revision, setRevision] = useState("");
  const [physical, setPhysical] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const ids = endpointOrder(data);
  const selected = endpoint || ids[0] || "";
  const current = data.statuses.reduce(
    (max, status) => (BigInt(status.revision) > BigInt(max) ? status.revision : max),
    "0",
  );
  const invalidRevision = !/^[1-9]\d{0,19}$/.test(revision) || BigInt(revision || "0") > BigInt(current);
  return (
    <>
      {data.alarms.map((alarm) => (
        <div
          role="status"
          key={`${alarm.memberId}-${alarm.kind}`}
          className="flex flex-wrap items-center gap-gap border-b border-line bg-panel p-gap text-danger"
        >
          <strong>
            ⚠ {alarm.kind} on {data.members.find((member) => member.id === alarm.memberId)?.name ?? alarm.memberId}
          </strong>
          <span>
            {alarm.kind === "NOSPACE"
              ? "Writes are refused. Compact, defragment every member, then disarm."
              : alarm.kind === "CORRUPT"
                ? "Stop writing and restore from a verified snapshot."
                : "Inspect the member before disarming."}
          </span>
          <CommandButton source={source} reason={reason} command={{ kind: "disarm", alarm }}>
            Disarm…
          </CommandButton>
        </div>
      ))}
      {data.statuses.length > 0 && data.statuses.every((status) => status.leaderId === null) ? (
        <p role="alert" className="p-gap text-danger">
          No leader: the cluster cannot accept writes. {data.statuses.length} of {data.members.length} members answered
          through configured endpoints.
        </p>
      ) : null}
      {view === "members" ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full font-grid">
              <thead className="sticky top-0 bg-panel text-ink-muted">
                <tr>
                  {[
                    "Member",
                    "Role",
                    "Configured endpoint",
                    "Version",
                    "Database / quota",
                    "Raft term / index",
                    "Applied / lag",
                    "Actions",
                  ].map((label) => (
                    <th className={CELL} key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => {
                  const status = data.statuses.find((item) => item.memberId === member.id);
                  const target = data.endpoints.find(
                    (item) => item.memberId === member.id || item.id === status?.endpointId,
                  );
                  const lag = status === undefined ? null : memberLag(status, data.statuses);
                  return (
                    <tr key={member.id}>
                      <td className={CELL}>
                        <span className={status === undefined ? "text-warning" : "text-success"}>
                          {status === undefined ? "Unknown health" : "Reachable"}
                        </span>
                        <div>{member.name || "Unnamed"}</div>
                        <div className="select-text text-ink-muted">{member.id}</div>
                      </td>
                      <td className={CELL}>
                        {member.learner
                          ? "Learner"
                          : status?.leaderId === member.id
                            ? "Leader"
                            : status?.leaderId == null
                              ? "Unknown"
                              : "Follower"}
                      </td>
                      <td className={CELL}>
                        {target?.label ?? "Not configured — not contacted"}
                        <div className="text-ink-muted" title="Advertised addresses are informational only">
                          {member.clientUrls.join(", ")}
                        </div>
                      </td>
                      <td className={CELL}>{status?.version ?? "Unknown"}</td>
                      <td className={CELL}>
                        <Storage status={status} />
                      </td>
                      <td className={CELL}>
                        {status?.raftTerm ?? "Unknown"} / {status?.raftIndex ?? "Unknown"}
                      </td>
                      <td className={CELL}>
                        {status?.appliedIndex ?? "Unknown"}
                        <div className={lag !== null && BigInt(lag) > 1000n ? "text-warning" : "text-ink-muted"}>
                          {lag === null ? "Lag unknown" : `${lag} behind leader`}
                        </div>
                      </td>
                      <td className={CELL}>
                        <div className="flex gap-cell">
                          {member.learner ? (
                            <CommandButton
                              source={source}
                              reason={reason ?? (lag !== "0" ? "Learner lag is unknown or has not caught up" : null)}
                              command={{ kind: "promote", memberId: member.id }}
                            >
                              Promote…
                            </CommandButton>
                          ) : null}
                          <CommandButton
                            source={source}
                            reason={
                              reason ?? (target === undefined ? "Only configured endpoints can be maintained" : null)
                            }
                            command={{ kind: "defragment", endpointIds: target === undefined ? [] : [target.id] }}
                          >
                            Defragment…
                          </CommandButton>
                          <CommandButton
                            source={source}
                            reason={reason ?? removalBlocked(member.id, data)}
                            command={{ kind: "remove", memberId: member.id }}
                          >
                            Remove…
                          </CommandButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <section className="p-gap">
            <h3 className="pb-cell font-semibold">Configured endpoints</h3>
            {data.endpoints.map((item) => (
              <Fact
                key={item.id}
                name={item.label}
                value={
                  item.reachable ? `Reachable · member ${item.memberId ?? "unknown"}` : (item.error ?? "Unreachable")
                }
              />
            ))}
            <p className="text-ink-muted">
              Advertised addresses are never followed. Missing measurements and quotas stay unknown.
            </p>
          </section>
        </>
      ) : null}
      {view === "alarms" && data.alarms.length === 0 ? (
        <p className="p-gap text-ink-muted">No alarms reported. Disarming clears the alarm, not its cause.</p>
      ) : null}
      {view === "maintenance" ? (
        <div className="grid gap-gap p-gap lg:grid-cols-2">
          <section className="rounded border border-line bg-panel p-gap">
            <h3 className="pb-gap font-semibold">Compact cluster history</h3>
            <p className="pb-gap text-ink-muted">
              Permanent, global history removal. Current revision {current}. Last compaction is unknown until
              consistency is checked.
            </p>
            <div className="flex flex-wrap gap-cell">
              {[1000n, 10000n, 100000n].map((keep) => (
                <button
                  key={String(keep)}
                  type="button"
                  className="h-row rounded border border-line px-cell hover:bg-raised"
                  onClick={() => setRevision(String(BigInt(current) > keep ? BigInt(current) - keep : 1n))}
                >
                  Keep last {String(keep)}
                </button>
              ))}
            </div>
            <label className="my-gap flex flex-col gap-cell">
              Revision
              <input
                className={INPUT}
                inputMode="numeric"
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-cell pb-gap">
              <input type="checkbox" checked={physical} onChange={(event) => setPhysical(event.target.checked)} />
              Physical compaction
            </label>
            <CommandButton
              source={source}
              reason={
                reason ?? (invalidRevision ? "Enter a positive revision no greater than the current revision" : null)
              }
              command={{ kind: "compact", revision, physical }}
            >
              Compact History…
            </CommandButton>
          </section>
          <section className="rounded border border-line bg-panel p-gap">
            <h3 className="pb-gap font-semibold">Defragment</h3>
            <p className="pb-gap text-warning">
              A member blocks reads and writes while it defragments. Only configured endpoints run, sequentially,
              followers first and leader last.
            </p>
            <ol className="pb-gap font-grid">
              {ids.map((id) => (
                <li key={id}>{data.endpoints.find((item) => item.id === id)?.label ?? id}</li>
              ))}
            </ol>
            <CommandButton
              source={source}
              reason={reason ?? (ids.length === 0 ? "Refresh configured endpoints first" : null)}
              command={{ kind: "defragment", endpointIds: ids }}
            >
              Defragment Configured Members…
            </CommandButton>
          </section>
          <section className="rounded border border-line bg-panel p-gap">
            <h3 className="pb-gap font-semibold">Full sensitive backend snapshot</h3>
            <p className="pb-gap text-ink-muted">
              Contains every namespace and authentication data. The host streams to a private temporary file, checks
              SHA-256 and publishes only after verification.
            </p>
            <label className="flex flex-col gap-cell pb-gap">
              Configured endpoint
              <select className={INPUT} value={selected} onChange={(event) => setEndpoint(event.target.value)}>
                {data.endpoints.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <CommandButton
              source={source}
              reason={reason ?? (!selected ? "Select a configured endpoint" : null)}
              command={{ kind: "snapshot", endpointId: selected }}
            >
              Save Snapshot…
            </CommandButton>
          </section>
          <section className="rounded border border-line bg-panel p-gap">
            <h3 className="pb-gap font-semibold">Check consistency</h3>
            <p className="pb-gap text-ink-muted">
              Hash every configured endpoint at the explicit revision entered in Compact. This does not write. A
              compacted revision will fail, not silently move forward.
            </p>
            <CommandButton
              source={source}
              reason={invalidRevision || ids.length === 0 ? "Enter a revision and refresh endpoints first" : null}
              command={{ kind: "consistency", endpointIds: ids, revision }}
            >
              Check at Revision {revision || "…"}
            </CommandButton>
          </section>
        </div>
      ) : null}
      <TaskRows source={source} data={data} />
    </>
  );
}
