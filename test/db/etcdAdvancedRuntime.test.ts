import { describe, expect, it } from "vitest";
import { EtcdSession } from "@table-craft/plugin-etcd/session";
import { connectionSchema } from "@table-craft/plugin-etcd/config";
import { databaseEnabled } from "../support/databases.js";
import { withIsolatedEtcd, type IsolatedEtcd } from "../support/etcdIsolated.js";

const FIXTURE_TIMEOUT_MS = 180_000;
const NAMESPACE = "/tenant-advanced/";
const OUTSIDE = "/outside-advanced";
const WATCH_LIMITS = { count: 100, maxBytes: 1_048_576, timeoutMs: 2000 };
const text = (value: string) => ({ text: value, hex: null });
const ALL = { kind: "all" as const };
const NESTED_TXN = 'txn\nthen: txn\nif: version("a") = 0\nthen: put a b\nelse: get a\nend\nelse: del a\nend';

async function open(fixture: IsolatedEtcd, extra: Record<string, unknown> = {}, readOnly = false) {
  const config = connectionSchema.parse({
    endpoints: fixture.plan.members.map((member) => `127.0.0.1:${String(member.port)}`).join(","),
    namespace: NAMESPACE,
    ...extra,
  });
  return EtcdSession.open(config, { readOnly });
}

async function rawValue(fixture: IsolatedEtcd, key: string): Promise<string | undefined> {
  return (await fixture.client.kv.range({ key: Buffer.from(key) })).kvs[0]?.value.toString();
}

describe.skipIf(!databaseEnabled("etcd"))("etcd runtime integration on an isolated server", () => {
  it(
    "givenNamespacedSession_whenRunningConsoleAndCompletion_thenEveryRawPathIsScoped",
    async () => {
      await withIsolatedEtcd({}, async (fixture) => {
        await fixture.client.kv.put({ key: Buffer.from(OUTSIDE), value: Buffer.from("untouched") });
        const session = await open(fixture);
        try {
          await session.execute(NESTED_TXN);
          expect(await rawValue(fixture, `${NAMESPACE}a`)).toBe("b");
          expect(await rawValue(fixture, "a")).toBeUndefined();

          await session.execute('put "suggest/one" "1"');
          expect(await session.suggestKeys("sugg")).toEqual(["suggest/one"]);
          expect(await session.suggestKeys("")).not.toContain(OUTSIDE);

          await session.execute('del "" --prefix');
          expect(await rawValue(fixture, OUTSIDE)).toBe("untouched");
          expect(await rawValue(fixture, `${NAMESPACE}a`)).toBeUndefined();

          const lease = await session.leases.grant("60");
          const leaseHex = BigInt.asUintN(64, BigInt(lease.id)).toString(16);
          const leases = await session.suggestConsoleValues("lease", "");
          expect(leases.map((entry) => entry.apply)).toContain(leaseHex);
          const [revision] = await session.suggestConsoleValues("revision", "");
          expect(revision?.apply).toMatch(/^\d+$/);
          await session.leases.revokePrepared((await session.leases.prepareRevoke(lease.id)).token);
        } finally {
          await session.close();
        }
      });
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "givenConfiguredPrefixesAndCursors_whenBrowsing_thenNamespaceRelativeAndPinned",
    async () => {
      await withIsolatedEtcd({}, async (fixture) => {
        const session = await open(fixture, { lockPrefix: "/locks/", electionPrefix: "" });
        try {
          const lease = await session.leases.grant("60");
          const leaseHex = BigInt.asUintN(64, BigInt(lease.id)).toString(16);
          await fixture.client.kv.put({
            key: Buffer.from(`${NAMESPACE}/locks/job/${leaseHex}`),
            value: Buffer.from(""),
            lease: lease.id,
          });
          await fixture.client.kv.put({ key: Buffer.from(`/locks/job/${leaseHex}`), value: Buffer.from("global") });
          expect((await session.coordination.prefixes()).map((prefix) => prefix.id)).toEqual(["locks"]);
          const page = await session.coordination.read("locks", null, 10);
          expect(page.queues).toHaveLength(1);
          expect(page.queues[0]).toMatchObject({ name: text("/locks/job"), kind: "lock", complete: true });
          expect(page.queues[0]?.candidates).toHaveLength(1);
          await expect(session.coordination.read("elections", null, 10)).rejects.toThrow("configured");

          for (const name of ["c/1", "c/2", "c/3"]) await session.execute(`put "${name}" "v"`);
          const first = await session.keyspace.children({
            database: 0,
            range: ALL,
            parent: text("c/"),
            cursor: null,
            count: 1,
            timeoutMs: 5000,
          });
          expect(first.children).toHaveLength(1);
          expect(first.cursor).not.toBeNull();
          await session.execute('put "c/0" "late"');
          const rest = await session.keyspace.children({
            database: 0,
            range: ALL,
            parent: text("c/"),
            cursor: first.cursor,
            count: 10,
            timeoutMs: 5000,
          });
          expect(rest.revision).toBe(first.revision);
          expect([...first.children, ...rest.children].map((child) => child.key.text)).toEqual(["c/1", "c/2", "c/3"]);
          await expect(
            session.keyspace.children({
              database: 0,
              range: ALL,
              parent: text("other/"),
              cursor: first.cursor,
              count: 10,
              timeoutMs: 5000,
            }),
          ).rejects.toThrow("cursor");
          await session.leases.revokePrepared((await session.leases.prepareRevoke(lease.id)).token);
        } finally {
          await session.close();
        }
      });
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "givenReadModeAndReadOnly_whenUsingSession_thenStaleMarkedAndWritesRefused",
    async () => {
      await withIsolatedEtcd({}, async (fixture) => {
        const serializable = await open(fixture, { readMode: "serializable" });
        try {
          const info = await serializable.serverInfo(null);
          const connection = info.sections.find((section) => section.title === "Connection");
          expect(connection?.entries).toEqual(
            expect.arrayContaining([
              { name: "read_mode", value: "serializable (may be stale)" },
              { name: "namespace_base64", value: Buffer.from(NAMESPACE).toString("base64") },
            ]),
          );
        } finally {
          await serializable.close();
        }

        const readOnly = await open(fixture, {}, true);
        try {
          await expect(readOnly.execute('put "x" "y"')).rejects.toThrow(/read-only/i);
          await expect(readOnly.execute(NESTED_TXN)).rejects.toThrow(/read-only/i);
          await expect(readOnly.keyTransfer.importChunk([], "overwrite")).rejects.toThrow(/read-only/i);
          expect(await rawValue(fixture, `${NAMESPACE}x`)).toBeUndefined();
        } finally {
          await readOnly.close();
        }
      });
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "givenOpenResources_whenSessionCloses_thenStreamsTokensAndRenewalsEndWithoutRevoking",
    async () => {
      await withIsolatedEtcd({}, async (fixture) => {
        const session = await open(fixture);
        const lease = await session.leases.grant("60");
        await session.execute('put "doomed/a" "1"');
        const watch = await session.watch.open({ database: 0, range: ALL, from: { kind: "now" } });
        const preview = await session.keyspace.prepareDelete(0, { kind: "prefix", prefix: text("doomed/") });
        await session.close();

        await expect(watch.next(WATCH_LIMITS)).resolves.toMatchObject({ state: "stopped", events: [] });
        await expect(session.keyspace.deletePrepared(preview.token)).rejects.toThrow();
        await expect(session.execute('get "doomed/a"')).rejects.toThrow("closed");
        expect(await rawValue(fixture, `${NAMESPACE}doomed/a`)).toBe("1");
        const ttl = await fixture.client.leaseClient.leaseTimeToLive({ ID: lease.id });
        expect(Number(ttl.TTL)).toBeGreaterThan(0);
      });
    },
    FIXTURE_TIMEOUT_MS,
  );
});
