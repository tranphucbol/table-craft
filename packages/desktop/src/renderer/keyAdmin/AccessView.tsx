import { useState } from "react";
import type { AccessPermission, KeyBytes, KeyRange } from "@table-craft/desktop/engine/protocol.js";
import { bytesLabel, type AdminData } from "./store.js";
import { Dropdown, type DropdownOption } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { CELL, CommandButton, INPUT } from "./controls.js";

const ACCESS_OPTIONS: readonly DropdownOption[] = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "readwrite", label: "Read & write" },
];
const RANGE_KIND_OPTIONS: readonly DropdownOption[] = [
  { value: "key", label: "Key" },
  { value: "prefix", label: "Prefix" },
  { value: "range", label: "Range" },
  { value: "all", label: "All keys" },
];

export function permissionRange(kind: KeyRange["kind"], from: string, to: string, hex: boolean): KeyRange {
  const bytes = (value: string): KeyBytes => {
    if (!hex) return { text: value, hex: null };
    if (!/^(?:[\da-fA-F]{2})*$/.test(value)) throw new Error("Hex must contain complete byte pairs.");
    return { text: "", hex: value.toLowerCase() };
  };
  if (kind === "all") return { kind };
  if (kind === "key") return { kind, key: bytes(from) };
  if (kind === "prefix") return { kind, prefix: bytes(from) };
  return { kind, from: bytes(from), to: bytes(to) };
}
export function rangeLabel(range: KeyRange, raw = false): string {
  const label = (value: KeyBytes) =>
    raw
      ? (value.hex ??
        Array.from(new TextEncoder().encode(value.text), (byte) => byte.toString(16).padStart(2, "0")).join(""))
      : bytesLabel(value);
  return range.kind === "all"
    ? "All keys"
    : range.kind === "key"
      ? `Key ${label(range.key)}`
      : range.kind === "prefix"
        ? `Prefix ${label(range.prefix)}`
        : `Range ${label(range.from)} – ${label(range.to)} (end exclusive)`;
}
function PermissionForm({
  source,
  role,
  reason,
}: {
  readonly source: string;
  readonly role: string;
  readonly reason: string | null;
}) {
  const [kind, setKind] = useState<KeyRange["kind"]>("prefix");
  const [access, setAccess] = useState<AccessPermission["access"]>("read");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hex, setHex] = useState(false);
  let range: KeyRange = { kind: "all" };
  let error: string | null = null;
  try {
    range = permissionRange(kind, from, to, hex);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return (
    <fieldset className="flex flex-wrap items-end gap-cell border-t border-line py-gap">
      <legend className="text-ink-muted">Grant permission</legend>
      <label className="flex flex-col gap-cell">
        Access
        <Dropdown
          variant="field"
          label="Access"
          value={access}
          options={ACCESS_OPTIONS}
          onChange={(value) => setAccess(value as AccessPermission["access"])}
        />
      </label>
      <label className="flex flex-col gap-cell">
        Keys
        <Dropdown
          variant="field"
          label="Keys"
          value={kind}
          options={RANGE_KIND_OPTIONS}
          onChange={(value) => setKind(value as KeyRange["kind"])}
        />
      </label>
      {kind === "all" ? null : (
        <label className="flex min-w-0 flex-col gap-cell">
          {kind === "range" ? "From (inclusive)" : "Key or prefix"}
          <input className={INPUT} value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
      )}
      {kind !== "range" ? null : (
        <label className="flex min-w-0 flex-col gap-cell">
          To (exclusive)
          <input className={INPUT} value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      )}
      <label className="flex h-row items-center gap-cell">
        <input type="checkbox" checked={hex} onChange={(event) => setHex(event.target.checked)} />
        Hex bytes
      </label>
      <CommandButton
        source={source}
        reason={reason ?? error}
        command={{ kind: "permission", role, permission: { access, range } }}
      >
        Grant Permission…
      </CommandButton>
      {error === null ? null : <p className="text-danger">{error}</p>}
    </fieldset>
  );
}
export function AccessView({
  source,
  data,
  reason,
}: {
  readonly source: string;
  readonly data: AdminData;
  readonly reason: string | null;
}) {
  const [selected, setSelected] = useState<{ readonly kind: "user" | "role"; readonly name: string } | null>(null);
  const [raw, setRaw] = useState(false);
  const user = selected?.kind === "user" ? data.users.find((item) => item.name === selected.name) : undefined;
  const role = selected?.kind === "role" ? data.roles.find((item) => item.name === selected.name) : undefined;
  return (
    <>
      <div className="flex flex-wrap items-center gap-gap border-b border-line bg-panel p-gap">
        <span className={data.auth?.enabled === false ? "text-warning" : "text-success"}>
          Authentication: {data.auth === null ? "Unknown" : data.auth.enabled ? "On" : "Off"}
        </span>
        <span className="text-ink-muted">Current user: {data.auth?.currentUser ?? "Unknown"} · Cluster-global</span>
        {data.auth === null ? null : (
          <CommandButton
            source={source}
            reason={reason}
            command={{ kind: "access", change: { kind: data.auth.enabled ? "disableAuth" : "enableAuth" } }}
          >
            {data.auth.enabled ? "Disable Authentication…" : "Enable Authentication…"}
          </CommandButton>
        )}
      </div>
      {data.auth?.enabled === false ? (
        <p className="border-b border-line p-gap text-warning">
          Anyone who can reach this cluster can read and write every key. A namespace is not an access boundary.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-wrap">
        <aside aria-label="Users and roles" className="min-w-48 border-r border-line bg-panel p-gap">
          <div className="flex items-center justify-between gap-gap">
            <h3 className="font-semibold">Users</h3>
            <CommandButton source={source} reason={reason} command={{ kind: "newUser" }}>
              New…
            </CommandButton>
          </div>
          <ul className="py-cell">
            {data.users.map((item) => (
              <li key={item.name}>
                <button
                  type="button"
                  aria-pressed={user?.name === item.name}
                  className="h-row w-full rounded px-cell text-left hover:bg-raised aria-pressed:bg-selection"
                  onClick={() => setSelected({ kind: "user", name: item.name })}
                >
                  {item.name}
                  {item.roles.includes("root") ? " · root" : ""}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-gap border-t border-line pt-gap">
            <h3 className="font-semibold">Roles</h3>
            <CommandButton source={source} reason={reason} command={{ kind: "newRole" }}>
              New…
            </CommandButton>
          </div>
          <ul className="py-cell">
            {data.roles.map((item) => (
              <li key={item.name}>
                <button
                  type="button"
                  aria-pressed={role?.name === item.name}
                  className="h-row w-full rounded px-cell text-left hover:bg-raised aria-pressed:bg-selection"
                  onClick={() => setSelected({ kind: "role", name: item.name })}
                >
                  {item.name}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="min-w-0 flex-1 p-gap">
          {user === undefined ? null : (
            <>
              <h3 className="pb-gap font-semibold">{user.name}</h3>
              {user.roles.includes("root") ? (
                <p className="pb-gap text-warning">
                  Full access to every key, users, roles and authentication settings.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-cell">
                {user.roles.map((name) => (
                  <CommandButton
                    source={source}
                    key={name}
                    reason={reason}
                    command={{ kind: "access", change: { kind: "revokeRole", user: user.name, role: name } }}
                  >
                    {name} · Revoke…
                  </CommandButton>
                ))}
              </div>
              <div className="flex flex-wrap gap-cell py-gap">
                <CommandButton source={source} reason={reason} command={{ kind: "grantRole", user: user.name }}>
                  Grant Role…
                </CommandButton>
                <CommandButton source={source} reason={reason} command={{ kind: "password", user: user.name }}>
                  Change Password…
                </CommandButton>
                <CommandButton
                  source={source}
                  reason={reason}
                  command={{ kind: "access", change: { kind: "deleteUser", user: user.name } }}
                >
                  Delete User…
                </CommandButton>
              </div>
              <p className="text-ink-muted">
                Passwords are sent through a private write-only channel. They are not saved in console text, history or
                results.
              </p>
            </>
          )}
          {role === undefined ? null : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-gap">
                <h3 className="font-semibold">{role.name}</h3>
                <CommandButton
                  source={source}
                  reason={reason}
                  command={{ kind: "access", change: { kind: "deleteRole", role: role.name } }}
                >
                  Delete Role…
                </CommandButton>
              </div>
              <label className="flex items-center gap-cell py-gap">
                <input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />
                Show raw range (hex)
              </label>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-panel">
                    <tr>
                      <th className={CELL}>Access</th>
                      <th className={CELL}>Keys</th>
                      <th className={CELL}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {role.permissions.map((permission, index) => (
                      <tr key={index}>
                        <td className={CELL}>{permission.access}</td>
                        <td className={`${CELL} select-text font-grid`}>{rangeLabel(permission.range, raw)}</td>
                        <td className={CELL}>
                          <CommandButton
                            source={source}
                            reason={reason}
                            command={{
                              kind: "access",
                              change: { kind: "revokePermission", role: role.name, range: permission.range },
                            }}
                          >
                            Revoke…
                          </CommandButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <PermissionForm key={role.name} source={source} role={role.name} reason={reason} />
            </>
          )}
          {user !== undefined || role !== undefined ? null : (
            <p className="text-ink-muted">
              Select a user or role. Permissions apply to the whole cluster, including keys outside this namespace.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
