import type { Capability, Session } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { KeyAdvancedCalls } from "@table-craft/desktop/engine/protocol.js";
import type { Routes } from "./types.js";
import { invalidOperation, serviceMethod } from "@table-craft/desktop/engine/keyOperations/scope.js";
import { admitCommands } from "@table-craft/desktop/engine/admission.js";

export function keyAdvancedRoutes(connection: ConnectionContext): Pick<Routes, keyof KeyAdvancedCalls> {
  const resources = () => connection.keyOperations;
  const scope = {
    run: <T>(capability: Capability, write: boolean, work: (session: Session) => Promise<T>) =>
      resources().scope.run(capability, write, work),
    capability: (capability: Capability) => resources().scope.capability(capability),
  };
  const watches = {
    start: (...args: Parameters<ConnectionContext["keyOperations"]["watches"]["start"]>) =>
      resources().watches.start(...args),
    window: (...args: Parameters<ConnectionContext["keyOperations"]["watches"]["window"]>) =>
      resources().watches.window(...args),
    stop: (id: string) => resources().watches.stop(id),
    clear: (id: string) => resources().watches.clear(id),
    list: () => resources().watches.list(),
  };
  const renewals = {
    start: (id: string) => resources().renewals.start(id),
    stop: (id: string) => resources().renewals.stop(id),
  };
  const tasks = {
    list: (family: "maintenance" | "transfer" | "watch") => resources().tasks.list(family),
    cancel: (id: string, family: "maintenance" | "transfer" | "watch") => resources().tasks.cancel(id, family),
    resume: (id: string) => resources().tasks.resume(id),
  };
  const maintenance = {
    defragment: (...args: Parameters<ConnectionContext["keyOperations"]["maintenance"]["defragment"]>) =>
      resources().maintenance.defragment(...args),
    snapshot: (...args: Parameters<ConnectionContext["keyOperations"]["maintenance"]["snapshot"]>) =>
      resources().maintenance.snapshot(...args),
    consistency: (...args: Parameters<ConnectionContext["keyOperations"]["maintenance"]["consistency"]>) =>
      resources().maintenance.consistency(...args),
  };
  const transfer = {
    preview: (...args: Parameters<ConnectionContext["keyOperations"]["transfer"]["preview"]>) =>
      resources().transfer.preview(...args),
    import: (...args: Parameters<ConnectionContext["keyOperations"]["transfer"]["import"]>) =>
      resources().transfer.import(...args),
    export: (...args: Parameters<ConnectionContext["keyOperations"]["transfer"]["export"]>) =>
      resources().transfer.export(...args),
  };
  const run = <T>(capability: Capability, write: boolean, work: (session: Session) => Promise<T>) =>
    scope.run(capability, write, work);
  const builder = () => {
    scope.capability("commands");
    const value = connection.commandLanguage()?.transactionBuilder;
    if (value === undefined) throw invalidOperation("The datasource does not provide a transaction builder.");
    return value;
  };
  return {
    "keyspace.features": () =>
      run("keyValue", false, (session) => {
        const keyspace = session.keyspace;
        if (keyspace === undefined) throw invalidOperation("The datasource has no keyspace service.");
        return Promise.resolve({
          ...keyspace.features,
          children: typeof keyspace.children === "function",
          countRange: typeof keyspace.countRange === "function",
          prepareDelete: typeof keyspace.prepareDelete === "function" && typeof keyspace.deletePrepared === "function",
          history: typeof keyspace.history === "function",
        });
      }),
    "keyspace.children": ({ database, range, parent, cursor, count, timeoutMs }) =>
      run("keyValue", false, (session) =>
        serviceMethod(session.keyspace, "children")({ database, range, parent, cursor, count, timeoutMs }),
      ),
    "keyspace.countRange": ({ database, range }) =>
      run("keyValue", false, (session) => serviceMethod(session.keyspace, "countRange")(database, range)),
    "keyspace.prepareDelete": ({ database, range }) =>
      run("keyValue", false, (session) => serviceMethod(session.keyspace, "prepareDelete")(database, range)),
    "keyspace.deletePrepared": ({ token }) =>
      run("keyValue", true, (session) => serviceMethod(session.keyspace, "deletePrepared")(token)),
    "leases.list": () =>
      run("leases", false, async (session) => resources().renewals.list(await serviceMethod(session.leases, "list")())),
    "leases.get": ({ leaseId }) => run("leases", false, (session) => serviceMethod(session.leases, "get")(leaseId)),
    "leases.keys": ({ leaseId, cursor, count }) =>
      run("leases", false, (session) => serviceMethod(session.leases, "keys")(leaseId, cursor, count)),
    "leases.grant": ({ ttlSeconds }) =>
      run("leases", true, (session) => serviceMethod(session.leases, "grant")(ttlSeconds)),
    "leases.keepAliveOnce": ({ leaseId }) =>
      run("leases", true, (session) => serviceMethod(session.leases, "keepAliveOnce")(leaseId)),
    "leases.keepAliveStart": ({ leaseId }) => renewals.start(leaseId),
    "leases.keepAliveStop": async ({ keepAliveId }) => {
      await renewals.stop(keepAliveId);
      return null;
    },
    "leases.prepareRevoke": ({ leaseId }) =>
      run("leases", false, (session) => serviceMethod(session.leases, "prepareRevoke")(leaseId)),
    "leases.revokePrepared": ({ token }) =>
      run("leases", true, async (session) => {
        await serviceMethod(session.leases, "revokePrepared")(token);
        return null;
      }),
    "watch.start": (request) => watches.start(request),
    "watch.window": (request) => Promise.resolve(watches.window(request)),
    "watch.stop": async ({ watchId }) => {
      await watches.stop(watchId);
      return null;
    },
    "watch.clear": ({ watchId }) => {
      watches.clear(watchId);
      return Promise.resolve(null);
    },
    "watch.list": () => Promise.resolve(watches.list()),
    "watch.exportStart": (request) => Promise.resolve(resources().watchExport.start(request)),
    "watch.exportList": () => Promise.resolve(tasks.list("watch")),
    "watch.exportCancel": async ({ taskId }) => {
      await tasks.cancel(taskId, "watch");
      return null;
    },
    "cluster.endpoints": () => run("members", false, (session) => serviceMethod(session.cluster, "endpoints")()),
    "cluster.members": () => run("members", false, (session) => serviceMethod(session.cluster, "members")()),
    "cluster.status": ({ endpointId }) =>
      run("maintenance", false, (session) => serviceMethod(session.cluster, "status")(endpointId)),
    "cluster.alarms": () => run("maintenance", false, (session) => serviceMethod(session.cluster, "alarms")()),
    "cluster.disarm": ({ alarm }) =>
      run("maintenance", true, async (session) => {
        await serviceMethod(session.cluster, "disarm")(alarm);
        return null;
      }),
    "cluster.compact": ({ revision, physical }) =>
      run("maintenance", true, async (session) => {
        await serviceMethod(session.cluster, "compact")(revision, physical);
        return null;
      }),
    "cluster.promote": ({ memberId }) =>
      run("members", true, async (session) => {
        await serviceMethod(session.cluster, "promote")(memberId);
        return null;
      }),
    "cluster.remove": ({ memberId }) =>
      run("members", true, async (session) => {
        await serviceMethod(session.cluster, "remove")(memberId);
        return null;
      }),
    "maintenance.defragmentStart": (request) => Promise.resolve(maintenance.defragment(request)),
    "maintenance.snapshotStart": (request) => Promise.resolve(maintenance.snapshot(request)),
    "maintenance.consistencyStart": (request) => Promise.resolve(maintenance.consistency(request)),
    "maintenance.list": () => Promise.resolve(tasks.list("maintenance")),
    "maintenance.cancel": async ({ taskId }) => {
      await tasks.cancel(taskId, "maintenance");
      return null;
    },
    "access.status": () => run("access", false, (session) => serviceMethod(session.access, "status")()),
    "access.users": () => run("access", false, (session) => serviceMethod(session.access, "users")()),
    "access.roles": () => run("access", false, (session) => serviceMethod(session.access, "roles")()),
    "access.apply": ({ change }) =>
      run("access", true, async (session) => {
        await serviceMethod(session.access, "apply")(change);
        return null;
      }),
    "coordination.prefixes": () =>
      run("coordination", false, (session) => serviceMethod(session.coordination, "prefixes")()),
    "coordination.read": ({ prefixId, cursor, count }) =>
      run("coordination", false, (session) => serviceMethod(session.coordination, "read")(prefixId, cursor, count)),
    "commands.admit": ({ commands }) => Promise.resolve(admitCommands(connection.commandLanguage(), commands)),
    "commandTxn.parse": ({ text, offset }) => Promise.resolve(builder().parse(text, offset)),
    "commandTxn.serialize": ({ transaction }) => Promise.resolve(builder().serialize(transaction)),
    "keyTransfer.previewImport": (request) => transfer.preview(request),
    "keyTransfer.importStart": (request) => Promise.resolve(transfer.import(request)),
    "keyTransfer.exportStart": (request) => Promise.resolve(transfer.export(request)),
    "keyTransfer.resume": ({ taskId }) => Promise.resolve(tasks.resume(taskId)),
    "keyTransfer.list": () => Promise.resolve(tasks.list("transfer")),
    "keyTransfer.cancel": async ({ taskId }) => {
      await tasks.cancel(taskId, "transfer");
      return null;
    },
  };
}
