import { createHash } from "node:crypto";
import type { KeyWatchEvent } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import { EtcdSession } from "@table-craft/plugin-etcd/session";
import type { EtcdKeyspace } from "@table-craft/plugin-etcd/keyspace";
import { connectionSchema } from "@table-craft/plugin-etcd/config";
import { databaseEnabled } from "../support/databases.js";
import { withIsolatedEtcd, type IsolatedEtcd } from "../support/etcdIsolated.js";

const FIXTURE_TIMEOUT_MS = 180_000;
const WATCH_LIMITS = { count: 100, maxBytes: 1_048_576, timeoutMs: 5000 };
const text = (value: string) => ({ text: value, hex: null });
const ALL = { kind: "all" as const };
const NAMESPACE = "/private-runtime/";

function keyspaceOf(opened: EtcdSession): EtcdKeyspace {
  return opened.services.keyValue as EtcdKeyspace;
}

async function session(fixture: IsolatedEtcd, namespace = NAMESPACE, readOnly = false) {
  const credentials = fixture.credentials?.root;
  const config = connectionSchema.parse({
    endpoints: fixture.plan.members.map((member) => `127.0.0.1:${String(member.port)}`).join(","),
    namespace,
    user: credentials?.username ?? "",
    password: credentials?.password ?? "",
  });
  return EtcdSession.open(config, { readOnly });
}

describe.skipIf(!databaseEnabled("etcd"))("etcd advanced runtime on disposable servers only", () => {
  it.each(["3.5", "3.6"] as const)(
    "givenIsolatedEtcd%s_whenUsingAdvancedRuntime_thenScopedAndGuarded",
    async (version) => {
      await withIsolatedEtcd({ version }, async (fixture) => {
        const connected = await session(fixture);
        const raw = fixture.client;
        try {
          await raw.kv.put({ key: Buffer.from("/outside"), value: Buffer.from("untouched") });
          const lease = await connected.services.leases.grant("60");
          await keyspaceOf(connected).apply(
            0,
            text("folder/key"),
            [{ kind: "setString", value: text("first"), original: null }],
            { type: "string", guard: true, lease: { kind: "attach", leaseId: lease.id } },
          );
          let stored = await raw.kv.range({ key: Buffer.from(`${NAMESPACE}folder/key`) });
          expect(stored.kvs[0]?.lease).toBe(lease.id);
          await keyspaceOf(connected).apply(
            0,
            text("folder/key"),
            [{ kind: "setString", value: text("second"), original: text("first") }],
            { type: "string", guard: true },
          );
          stored = await raw.kv.range({ key: Buffer.from(`${NAMESPACE}folder/key`) });
          expect(stored.kvs[0]?.lease).toBe(lease.id);
          await keyspaceOf(connected).apply(0, text("folder/key"), [], {
            type: "string",
            guard: false,
            lease: { kind: "detach" },
          });
          stored = await raw.kv.range({ key: Buffer.from(`${NAMESPACE}folder/key`) });
          expect(stored.kvs[0]?.lease).toBe("0");
          expect(stored.kvs[0]?.value.toString()).toBe("second");

          const watch = await connected.services.watch.open({ database: 0, range: ALL, from: { kind: "now" } });
          await connected.execute('put "watched" "new"');
          const events: KeyWatchEvent[] = [];
          const maxPulls = 3;
          for (let pull = 0; pull < maxPulls && !events.some((event) => event.key.text === "watched"); pull++)
            events.push(...(await watch.next(WATCH_LIMITS)).events);
          expect(events.some((event) => event.key.text === "watched")).toBe(true);
          expect(events.every((event) => !event.key.text.startsWith(NAMESPACE))).toBe(true);
          await watch.close();

          const children = await keyspaceOf(connected).children({
            database: 0,
            range: ALL,
            parent: text(""),
            cursor: null,
            count: 100,
            timeoutMs: 5000,
          });
          expect(children.children).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: "folder", key: text("folder/") })]),
          );
          expect(children.children.some((child) => child.key.text === "/outside")).toBe(false);

          const first = await connected.services.bulkTransfer.exportPage({
            database: 0,
            range: ALL,
            cursor: null,
            count: 1,
            maxBytes: 4096,
          });
          expect(first.namespace.text).toBe(NAMESPACE);
          expect(first.cursor).not.toBeNull();
          await connected.execute('put "zzz-after-snapshot" "late"');
          const rest = await connected.services.bulkTransfer.exportPage({
            database: 0,
            range: ALL,
            cursor: first.cursor,
            count: 100,
            maxBytes: 4096,
          });
          expect(rest.revision).toBe(first.revision);
          expect(rest.records.some((record) => record.key.text === "zzz-after-snapshot")).toBe(false);

          const stale = await keyspaceOf(connected).prepareDelete(0, { kind: "prefix", prefix: text("folder/") });
          await connected.execute('put "folder/new" "racing"');
          await expect(keyspaceOf(connected).deletePrepared(stale.token)).rejects.toThrow("modified after preview");
          const ready = await keyspaceOf(connected).prepareDelete(0, { kind: "prefix", prefix: text("folder/") });
          await expect(keyspaceOf(connected).deletePrepared(ready.token)).resolves.toMatchObject({ deleted: "2" });
          expect((await raw.kv.range({ key: Buffer.from("/outside") })).kvs[0]?.value.toString()).toBe("untouched");

          await expect(
            connected.services.bulkTransfer.importChunk(
              [{ key: text("watched"), value: text("overwrite"), expectedModRevision: null }],
              "ifUnchanged",
            ),
          ).rejects.toThrow("expected revision");
          await expect(
            connected.services.bulkTransfer.importChunk(
              [{ key: text("watched"), value: text("skipped"), expectedModRevision: null }],
              "skipExisting",
            ),
          ).resolves.toMatchObject({ written: "0", skipped: "1" });
          await expect(
            connected.services.bulkTransfer.importChunk(
              [{ key: text("imported"), value: { text: "", hex: "ff00" }, expectedModRevision: "0" }],
              "ifUnchanged",
            ),
          ).resolves.toMatchObject({ written: "1" });

          const leaseKeys = await connected.services.leases.keys(lease.id, null, 100);
          expect(leaseKeys.lease.totalKeyCount).toBe("0");
          await connected.services.leases.keepAliveOnce(lease.id);
          const revoke = await connected.services.leases.prepareRevoke(lease.id);
          await connected.services.leases.revokePrepared(revoke.token);
        } finally {
          await connected.close();
        }
      });
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "givenIsolatedThreeMemberCluster_whenMaintaining_thenPinnedStatusHashAndVerifiedSnapshot",
    async () => {
      await withIsolatedEtcd({ members: 3 }, async (fixture) => {
        const connected = await session(fixture);
        try {
          const endpoints = await connected.services.maintenance.endpoints();
          expect(endpoints).toHaveLength(3);
          expect(endpoints.every((endpoint) => endpoint.reachable)).toBe(true);
          const status = await connected.services.maintenance.status(endpoints[0]!.id);
          await expect(connected.services.maintenance.status("advertised-url")).rejects.toThrow("configured");
          await expect(connected.services.members.remove(status.leaderId!)).rejects.toThrow("current leader");
          const hash = await connected.services.maintenance.hash(endpoints[0]!.id, "0");
          expect(hash.endpointId).toBe(endpoints[0]!.id);
          expect(hash.hash).toMatch(/^\d+$/);
          await connected.services.maintenance.defragment(endpoints[0]!.id);
          const snapshot = await connected.services.maintenance.snapshot(endpoints[0]!.id);
          const chunks: Buffer[] = [];
          try {
            for await (const chunk of snapshot.chunks) chunks.push(Buffer.from(chunk));
          } finally {
            await snapshot.close();
          }
          const bytes = Buffer.concat(chunks);
          const checksumBytes = 32;
          const pageBytes = 512;
          expect((bytes.length - checksumBytes) % pageBytes).toBe(0);
          expect(createHash("sha256").update(bytes.subarray(0, -checksumBytes)).digest()).toEqual(
            bytes.subarray(-checksumBytes),
          );
          await connected.services.maintenance.compact(status.revision, false);
        } finally {
          await connected.close();
        }
      });
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "givenIsolatedAuthenticatedServer_whenChangingAccess_thenGlobalRangesAndSelfLockoutGuards",
    async () => {
      await withIsolatedEtcd({ auth: true }, async (fixture) => {
        const connected = await session(fixture);
        try {
          expect(await connected.services.access.status()).toMatchObject({ enabled: true, currentUser: "root" });
          await expect(connected.services.access.apply({ kind: "deleteUser", user: "root" })).rejects.toThrow(
            "lock out",
          );
          await connected.services.access.apply({ kind: "createRole", role: "runtime-reader" });
          await connected.services.access.apply({
            kind: "grantPermission",
            role: "runtime-reader",
            permission: { access: "read", range: { kind: "prefix", prefix: text("/global/") } },
          });
          const role = (await connected.services.access.roles()).find((entry) => entry.name === "runtime-reader");
          expect(role?.permissions[0]?.range).toEqual({ kind: "prefix", prefix: text("/global/") });
          await connected.services.access.applySecret({
            kind: "createUser",
            user: "runtime-user",
            password: "isolated-secret",
          });
          await connected.services.access.apply({ kind: "grantRole", user: "runtime-user", role: "runtime-reader" });
          const users = await connected.services.access.users();
          expect(users.find((user) => user.name === "runtime-user")?.roles).toContain("runtime-reader");
          expect(JSON.stringify(users)).not.toContain("isolated-secret");
          await connected.services.access.apply({ kind: "deleteUser", user: "runtime-user" });
          await connected.services.access.apply({ kind: "deleteRole", role: "runtime-reader" });
        } finally {
          await connected.close();
        }
      });
    },
    FIXTURE_TIMEOUT_MS,
  );
});
