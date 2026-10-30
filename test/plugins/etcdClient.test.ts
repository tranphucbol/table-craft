import { describe, expect, it } from "vitest";
import { EtcdClient, type ClientSettings } from "@table-craft/plugin-etcd/client";
import { keyBytesOf, bytesOf } from "@table-craft/plugin-etcd/keyBytes";
import { bytesCell } from "@table-craft/plugin-etcd/results";

/** The driver's client, as the plugin's own types name it; the tests stand in fakes for it. */
type Etcd3 = Parameters<Parameters<EtcdClient["call"]>[0]>[0];

const SETTINGS: ClientSettings = {
  address: "127.0.0.1:2379",
  tls: null,
  user: "",
  password: "",
  maxMessageMb: 1,
  connectTimeoutMs: 1,
};
const STALE = "etcdserver: revision of auth store is old";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface FakeEtcd {
  readonly id: number;
  closed: boolean;
  close(): void;
}

/** A client whose first instance fails every call on a stale token, the rest answer with their id. */
function fakeClient() {
  const made: FakeEtcd[] = [];
  const client = new EtcdClient(SETTINGS, () => {
    const fake: FakeEtcd = { id: made.length, closed: false, close: () => (fake.closed = true) };
    made.push(fake);
    return fake as unknown as Etcd3;
  });
  const work = (delayMs: number) => async (etcd: Etcd3) => {
    const fake = etcd as unknown as FakeEtcd;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (fake.closed) throw new Error("used after close");
    if (fake.id === 0) throw new Error(STALE);
    return fake.id;
  };
  return { client, made, work };
}

describe("etcd client", () => {
  it("givenParallelCallsOnStaleToken_whenRetried_thenOneRebuildAndAllSucceed", async () => {
    const { client, made, work } = fakeClient();
    const results = await Promise.all([work(1), work(5), work(10), work(20)].map((each) => client.call(each)));
    expect(results).toEqual([1, 1, 1, 1]);
    expect(made).toHaveLength(2);
    expect(made[0]?.closed).toBe(true);
    expect(made[1]?.closed).toBe(false);
  });

  it("givenRebuildWhileOtherCallsRun_whenTheyFinish_thenOldClientClosesOnlyAfterTheLast", async () => {
    const { client, made, work } = fakeClient();
    const slow = client.call(work(30));
    await client.call(work(1));
    expect(made[0]?.closed).toBe(false);
    await expect(slow).resolves.toBe(1);
    expect(made[0]?.closed).toBe(true);
    client.close();
    expect(made[1]?.closed).toBe(true);
  });

  it("givenOtherFailure_whenCalled_thenNoRebuild", async () => {
    const { client, made } = fakeClient();
    await expect(client.call(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(made).toHaveLength(1);
  });

  it("givenConfiguredPool_whenPinned_thenOnlyNamedConfiguredAddressAndAllClose", async () => {
    const made: { address: string; closed: boolean }[] = [];
    const client = new EtcdClient(
      {
        ...SETTINGS,
        endpoints: [
          { id: "a", address: "127.0.0.1:40001", tls: null },
          { id: "b", address: "127.0.0.1:40002", tls: null },
        ],
      },
      (settings) => {
        const fake = {
          address: settings.address,
          closed: false,
          close() {
            fake.closed = true;
          },
        };
        made.push(fake);
        return fake as unknown as Etcd3;
      },
    );
    await expect(
      client.pinned("b").call((etcd) => Promise.resolve((etcd as unknown as { address: string }).address)),
    ).resolves.toBe("127.0.0.1:40002");
    expect(() => client.pinned("advertised-member")).toThrow("configured");
    client.close();
    expect(made.every((item) => item.closed)).toBe(true);
  });

  it("givenAmbiguousMutationFailure_whenCalled_thenNeverRetried", async () => {
    const { client } = fakeClient();
    let writes = 0;
    await expect(
      client.call(async () => {
        await Promise.resolve();
        writes += 1;
        throw new Error("deadline exceeded after send");
      }),
    ).rejects.toMatchObject({ code: "statementFailed", outcome: "unknown" });
    expect(writes).toBe(1);
  });
});

describe("etcd byte order marks", () => {
  it("givenKeyStartingWithBom_whenShownAndRebuilt_thenSameBytes", () => {
    const key = Buffer.concat([BOM, Buffer.from("/app/a")]);
    const shown = keyBytesOf(key);
    expect(shown.text.startsWith("\uFEFF")).toBe(true);
    expect(bytesOf(shown)).toEqual(key);
  });

  it("givenValueStartingWithBom_whenCelled_thenBomKept", () => {
    expect(bytesCell(Buffer.concat([BOM, Buffer.from("v")]))).toBe("\uFEFFv");
  });
});
