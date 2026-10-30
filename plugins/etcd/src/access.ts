import { PluginError } from "@table-craft/plugin-api";
import type {
  AccessChange,
  AccessManager,
  AccessPermission,
  AccessRole,
  AccessSecretChange,
  AccessStatus,
  AccessUser,
  KeyRange,
} from "@table-craft/plugin-api";
import type { IPermission } from "etcd3";
import { keyBytesOf } from "./keyBytes.js";
import { invalid, logicalRange, refuse, writable, type RuntimeHost } from "./runtime.js";
import { NO_END, prefixEnd } from "./scan.js";

const ROOT = "root";
/** etcd reads an empty range_end in a permission as one exact key. */
const EXACT_KEY = Buffer.alloc(0);
const MAX_NAME = 1024;
const MAX_SECRET_BYTES = 16_384;
function name(value: string): void {
  if (value.length === 0 || value.length > MAX_NAME) invalid("User and role names must contain 1–1024 characters.");
}
function rangeOf(permission: IPermission): KeyRange {
  const key = permission.key;
  const end = permission.range_end;
  if (key.equals(NO_END) && end.equals(NO_END)) return { kind: "all" };
  if (end.length === 0) return { kind: "key", key: keyBytesOf(key) };
  if (prefixEnd(key).equals(end)) return { kind: "prefix", prefix: keyBytesOf(key) };
  return { kind: "range", from: keyBytesOf(key), to: keyBytesOf(end) };
}
export class EtcdAccess implements AccessManager {
  constructor(
    readonly host: RuntimeHost,
    readonly currentUser: string | null,
    readonly viableIdentity: boolean,
  ) {}
  async status(): Promise<AccessStatus> {
    this.host.state.check();
    const status = await this.host.globalCall((etcd) => etcd.auth.authStatus());
    return { enabled: status.enabled, revision: status.authRevision, currentUser: this.currentUser };
  }
  async users(): Promise<readonly AccessUser[]> {
    this.host.state.check();
    const listed = await this.host.globalCall((etcd) => etcd.auth.userList());
    const users: AccessUser[] = [];
    for (const user of listed.users) {
      const detail = await this.host.globalCall((etcd) => etcd.auth.userGet({ name: user }));
      users.push({ name: user, roles: detail.roles });
    }
    return users;
  }
  async roles(): Promise<readonly AccessRole[]> {
    this.host.state.check();
    const listed = await this.host.globalCall((etcd) => etcd.auth.roleList());
    const roles: AccessRole[] = [];
    for (const role of listed.roles) {
      const detail = await this.host.globalCall((etcd) => etcd.auth.roleGet({ role }));
      roles.push({
        name: role,
        permissions: detail.perm.map((permission): AccessPermission => ({
          access: permission.permType === "Read" ? "read" : permission.permType === "Write" ? "write" : "readwrite",
          range: rangeOf(permission),
        })),
      });
    }
    return roles;
  }
  async apply(change: AccessChange): Promise<void> {
    writable(this.host.readOnly);
    this.host.state.check();
    if ("user" in change) name(change.user);
    if ("role" in change) name(change.role);
    if (change.kind === "deleteRole" && change.role === ROOT) refuse("The root role cannot be deleted.");
    if (change.kind === "deleteRole") {
      const users = await this.users();
      if (
        this.currentUser === null ||
        users.find((user) => user.name === this.currentUser)?.roles.includes(change.role)
      )
        refuse("Deleting this role could lock out the current connection. Use another administrator.");
    }
    if (change.kind === "deleteUser" || change.kind === "revokeRole") {
      if (this.currentUser === null)
        refuse(
          "The current authenticated identity is unknown. Reconnect with an explicit administrator username before removing users or role assignments.",
        );
      const users = await this.users();
      const target = users.find((user) => user.name === change.user);
      if (change.user === this.currentUser)
        refuse("This change could lock out the current connection. Use another administrator.");
      if (
        target?.roles.includes(ROOT) &&
        (change.kind === "deleteUser" || change.role === ROOT) &&
        users.filter((user) => user.roles.includes(ROOT)).length <= 1
      )
        refuse("Auth would have no administrator. Grant root to another user first.");
      if (change.kind === "deleteUser" && change.user === ROOT)
        refuse("The root user is required to enable authentication; it cannot be deleted here.");
      if (change.kind === "revokeRole" && change.user === ROOT && change.role === ROOT)
        refuse("Keep the root user's root role so authentication remains recoverable.");
    }
    if ((change.kind === "grantPermission" || change.kind === "revokePermission") && change.role === ROOT)
      refuse("Root permissions cannot be changed.");
    if (change.kind === "revokePermission" || change.kind === "grantPermission") {
      const users = await this.users();
      if (
        this.currentUser === null ||
        users.find((user) => user.name === this.currentUser)?.roles.includes(change.role)
      )
        refuse(
          "Replacing or revoking this permission could lock out the current connection. Use another administrator.",
        );
    }
    if (change.kind === "enableAuth") {
      const users = await this.users();
      if (!users.some((user) => user.name === ROOT && user.roles.includes(ROOT)))
        refuse("Create root and grant it the root role before enabling authentication.");
      if (
        !this.viableIdentity ||
        this.currentUser === null ||
        !users.some((user) => user.name === this.currentUser && user.roles.includes(ROOT))
      )
        refuse("Reconnect with a configured root administrator identity before enabling authentication.");
      refuse(
        "etcd cannot verify a configured password while authentication is disabled. Enable authentication with etcdctl using a verified root credential, then reconnect; this operation is refused here to prevent lockout.",
      );
    }
    // Permission ranges are global: never route auth through namespace mapping.
    await this.host.globalCall(async (etcd) => {
      switch (change.kind) {
        case "deleteUser":
          await etcd.auth.userDelete({ name: change.user });
          break;
        case "grantRole":
          await etcd.auth.userGrantRole({ user: change.user, role: change.role });
          break;
        case "revokeRole":
          await etcd.auth.userRevokeRole({ name: change.user, role: change.role });
          break;
        case "createRole":
          await etcd.auth.roleAdd({ name: change.role });
          break;
        case "deleteRole":
          await etcd.auth.roleDelete({ role: change.role });
          break;
        case "grantPermission":
          await etcd.auth.roleGrantPermission({
            name: change.role,
            perm: {
              range_end: EXACT_KEY,
              ...logicalRange(change.permission.range),
              permType:
                change.permission.access === "read"
                  ? "Read"
                  : change.permission.access === "write"
                    ? "Write"
                    : "Readwrite",
            },
          });
          break;
        case "revokePermission":
          await etcd.auth.roleRevokePermission({ role: change.role, ...logicalRange(change.range) });
          break;
        case "enableAuth":
          await etcd.auth.authEnable();
          break;
        case "disableAuth":
          await etcd.auth.authDisable();
          break;
      }
    });
  }
  async applySecret(change: AccessSecretChange): Promise<void> {
    writable(this.host.readOnly);
    this.host.state.check();
    name(change.user);
    if (Buffer.byteLength(change.password) === 0 || Buffer.byteLength(change.password) > MAX_SECRET_BYTES)
      refuse("Provide a password within the credential transport limit.");
    if (change.kind === "changePassword" && (this.currentUser === null || change.user === this.currentUser))
      refuse("Change the current user's password through another administrator and reconnect with the new credential.");
    try {
      await this.host.globalCall(async (etcd) => {
        if (change.kind === "createUser") await etcd.auth.userAdd({ name: change.user, password: change.password });
        else await etcd.auth.userChangePassword({ name: change.user, password: change.password });
      });
    } catch {
      throw new PluginError(
        "statementFailed",
        "Credential operation was not confirmed. Inspect users with an administrator before trying again.",
      );
    }
  }
}
