import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { KeyHistoryPage, KeyHistoryRequest, Session } from "@table-craft/plugin-api";
import etcd from "@table-craft/plugin-etcd";
import { describe, expect, it } from "vitest";
import { WITHOUT_ETCD } from "../support/databases.js";

const exec = promisify(execFile);
const DOCKER_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
const REQUEST_TIMEOUT_MS = 1_000;
const HISTORY_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_SECONDS = 3;
const DATABASE = 0;
const READ_WINDOW = 10;
const PAGE_EVENTS = 10;
const PAGE_BYTES = 4096;
const IMAGES = [
  { version: "3.5", image: "gcr.io/etcd-development/etcd:v3.5.21" },
  { version: "3.6", image: "gcr.io/etcd-development/etcd:v3.6.5" },
] as const;

async function docker(...args: string[]): Promise<string> {
  return (await exec("docker", args, { timeout: DOCKER_TIMEOUT_MS })).stdout.trim();
}

interface IsolatedServer {
  readonly session: Session;
  readonly put: (key: string, value: string) => Promise<string>;
  readonly remove: (key: string) => Promise<string>;
  readonly compact: (revision: string) => Promise<void>;
}

async function withIsolatedServer(image: string, use: (server: IsolatedServer) => Promise<void>): Promise<void> {
  const name = `table-craft-history-${randomUUID()}`;
  let session: Session | undefined;
  try {
    await docker(
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--publish",
      "127.0.0.1::2379",
      "--tmpfs",
      "/var/lib/etcd",
      image,
      "/usr/local/bin/etcd",
      "--name=history",
      "--data-dir=/var/lib/etcd",
      "--listen-client-urls=http://0.0.0.0:2379",
      "--advertise-client-urls=http://127.0.0.1:2379",
      "--listen-peer-urls=http://127.0.0.1:2380",
      "--initial-advertise-peer-urls=http://127.0.0.1:2380",
      "--initial-cluster=history=http://127.0.0.1:2380",
    );
    const bindings = JSON.parse(
      await docker("inspect", "--format", '{{json (index .NetworkSettings.Ports "2379/tcp")}}', name),
    ) as { HostIp: string; HostPort: string }[];
    const binding = bindings[0];
    if (bindings.length !== 1 || binding?.HostIp !== "127.0.0.1" || !/^\d+$/.test(binding.HostPort)) {
      throw new Error(`Disposable etcd did not publish one loopback port: ${JSON.stringify(bindings)}`);
    }
    const port = Number(binding.HostPort);
    console.info(`Isolated history fixture: ${name}, ${image}, 127.0.0.1:${String(port)}`);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The published port exists before etcd elects its single member.
      }
      await delay(POLL_INTERVAL_MS);
    }
    if (!ready)
      throw new Error(`Disposable etcd ${name} did not become healthy within ${String(READY_TIMEOUT_MS)} ms.`);
    session = await etcd.connect(
      { host: "127.0.0.1", port, connectTimeout: CONNECT_TIMEOUT_SECONDS },
      { readOnly: false },
    );
    const ctl = (...args: string[]) => docker("exec", name, "/usr/local/bin/etcdctl", "--command-timeout=3s", ...args);
    const revision = async (...args: string[]) => {
      const response = JSON.parse(await ctl("--write-out=json", ...args)) as { header: { revision: number } };
      return String(response.header.revision);
    };
    await use({
      session,
      put: (key, value) => revision("put", key, value),
      remove: (key) => revision("del", key),
      // No caller-supplied endpoint: compaction can only reach this named disposable container.
      compact: async (value) => {
        await ctl("compact", value, "--physical");
      },
    });
  } finally {
    try {
      await session?.close();
    } finally {
      await docker("rm", "--force", name).catch((cause: unknown) => {
        if (!(cause instanceof Error) || !cause.message.includes("No such container")) throw cause;
      });
    }
  }
}

async function lifecycle(server: IsolatedServer) {
  const key = `/history/${randomUUID()}`;
  const created = await server.put(key, "created");
  const updated = await server.put(key, "updated");
  const deleted = await server.remove(key);
  const recreated = await server.put(key, "recreated");
  const request: KeyHistoryRequest = {
    database: DATABASE,
    key: { text: key, hex: null },
    cursor: null,
    count: PAGE_EVENTS,
    maxBytes: PAGE_BYTES,
    timeoutMs: HISTORY_TIMEOUT_MS,
  };
  const keyspace = server.session.keyspace;
  if (keyspace?.history === undefined) throw new Error("etcd history capability is unavailable");
  return { key, created, updated, deleted, recreated, request, keyspace, history: keyspace.history.bind(keyspace) };
}

function assertGap(page: KeyHistoryPage, through: string): void {
  expect(page.complete).toBe(false);
  expect(page.unavailableThrough).toBe(through);
  expect(page.gaps).toEqual([{ fromRevision: "1", toRevision: through, reason: "compacted" }]);
}

function eventsOf(page: KeyHistoryPage) {
  return page.events.map((event) => [event.kind, event.modRevision, event.value?.text ?? null]);
}

describe.skipIf(WITHOUT_ETCD).each(IMAGES)("isolated etcd $version history compaction", ({ image }) => {
  it("givenCompactedPrefix_whenReplayingDeleteRecreate_thenRetainedEventsAndExplicitGap", async () => {
    await withIsolatedServer(image, async (server) => {
      const f = await lifecycle(server);
      await server.compact(f.updated);
      const page = await f.history(f.request);
      assertGap(page, f.updated);
      expect(eventsOf(page)).toEqual([
        ["DELETE", f.deleted, null],
        ["PUT", f.recreated, "recreated"],
      ]);
      expect(page).toMatchObject({ cursor: null, terminalRevision: f.recreated, stopReason: "snapshotEnd" });
      expect(BigInt(page.snapshotRevision)).toBeGreaterThanOrEqual(BigInt(f.recreated));
    });
  });

  it("givenTerminalAlreadyCompacted_whenReading_thenCurrentBaselineIsNotInventedAsHistory", async () => {
    await withIsolatedServer(image, async (server) => {
      const f = await lifecycle(server);
      const through = await server.put(`${f.key}/unrelated`, "advance revision");
      await server.compact(through);
      const page = await f.history(f.request);
      assertGap(page, through);
      expect(page).toMatchObject({ events: [], cursor: null, terminalRevision: f.recreated, stopReason: "compacted" });
      const baseline = await f.keyspace.read(DATABASE, f.request.key, { window: READ_WINDOW });
      expect(baseline.value).toBe("recreated");
      expect(baseline.details.revision?.modRevision).toBe(f.recreated);
    });
  });

  it("givenContinuationCompactedBetweenPages_whenResumed_thenPinnedSnapshotAndGapNotFalseCompletion", async () => {
    await withIsolatedServer(image, async (server) => {
      const f = await lifecycle(server);
      const first = await f.history({ ...f.request, count: 1 });
      expect(first).toMatchObject({ complete: false, gaps: [], unavailableThrough: null, stopReason: "pageLimit" });
      expect(first.cursor).not.toBeNull();
      expect(eventsOf(first)).toEqual([["PUT", f.created, "created"]]);
      await server.compact(f.deleted);
      await server.put(f.key, "after pinned snapshot");
      const page = await f.history({ ...f.request, cursor: first.cursor });
      assertGap(page, f.deleted);
      expect(page).toMatchObject({
        cursor: null,
        snapshotRevision: first.snapshotRevision,
        terminalRevision: first.terminalRevision,
        stopReason: "snapshotEnd",
      });
      expect(eventsOf(page)).toEqual([["PUT", f.recreated, "recreated"]]);
    });
  });
});
