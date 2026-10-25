import { describe, expect, it } from "vitest";
import { complete } from "@table-craft/plugin-redis/complete";
import { parseNodeAddressMap } from "@table-craft/plugin-redis/connect";
import { classify, inspect, split } from "@table-craft/plugin-redis/language";
import { readOnlyRefusal } from "@table-craft/plugin-redis/readOnly";
import { replyText, resultOf } from "@table-craft/plugin-redis/replies";
import { nodesOf } from "@table-craft/plugin-redis/routing";
import { tokenize } from "@table-craft/plugin-redis/tokens";

const NO_TABLE = new Map();

async function rowsOf(rows: AsyncIterable<readonly unknown[]>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const row of rows) collected.push(row);
  return collected;
}

describe("redis tokens", () => {
  it("givenRedisCliQuoting_whenTokenized_thenEscapesDecoded", () => {
    const tokens = tokenize(String.raw`SET "a b\x41\n" 'it\'s' plain`);
    expect(tokens.map((token) => token.text)).toEqual(["SET", "a bA\n", "it's", "plain"]);
    expect(tokens.every((token) => token.closed)).toBe(true);
  });

  it("givenUnclosedQuote_whenTokenized_thenLastTokenOpen", () => {
    expect(tokenize('GET "half').at(-1)?.closed).toBe(false);
  });
});

describe("redis language", () => {
  it("givenScript_whenSplit_thenOneSpanPerCommandLine", () => {
    const text = "# setup\nSET a 1\n\n   GET a  \n";
    expect(split(text).map((span) => [span.sql, text.slice(span.from, span.to)])).toEqual([
      ["SET a 1", "SET a 1"],
      ["GET a", "GET a"],
    ]);
  });

  it.each([
    ["FLUSHALL", { destructive: "FLUSHALL deletes every key in every database", confirmByName: true }],
    ["DEL a b", { destructive: "DEL of 2 keys" }],
    ["DEL a", { destructive: null }],
    ["config set maxmemory 1", { destructive: "CONFIG SET changes the server's configuration" }],
    ["SELECT 1", { setsNamespace: true }],
    ["GET a", { kind: "read", destructive: null }],
    ["SET a 1", { kind: "write" }],
  ])("given %s_whenClassified_thenMarked", (command, expected) => {
    expect(classify(command)).toMatchObject(expected);
  });

  it.each([
    ["HGETALL h", "HSCAN h 0 COUNT 1000"],
    ["LRANGE l 0 -1", "LRANGE l 0 99"],
    ["XRANGE s - +", "XRANGE s - + COUNT 100"],
  ])("givenCostly %s_whenInspected_thenFixRewritesIt", async (command, fixed) => {
    expect(classify(command).costly).toMatch(/\S/);
    const [problem] = await inspect({ text: command });
    const edit = problem?.fixes[0]?.edits[0];
    expect(edit === undefined ? null : command.slice(0, edit.from) + edit.insert + command.slice(edit.to)).toBe(fixed);
  });

  it("givenBoundedRange_whenClassified_thenNotCostly", () => {
    expect(classify("LRANGE l 0 99").costly ?? null).toBeNull();
    expect(classify("XRANGE s - + COUNT 10").costly ?? null).toBeNull();
  });
});

describe("redis read-only", () => {
  it("givenSnapshotFlags_whenWriteOrServerChange_thenRefusedNamingIt", () => {
    expect(readOnlyRefusal(NO_TABLE, ["HSET", "h", "f", "v"])).toMatch(
      /^read-only datasource refuses HSET, which writes/,
    );
    expect(readOnlyRefusal(NO_TABLE, ["CONFIG", "SET", "a", "b"])).toMatch(/refuses CONFIG SET/);
    expect(readOnlyRefusal(NO_TABLE, ["HGET", "h", "f"])).toBeNull();
    expect(readOnlyRefusal(NO_TABLE, ["CONFIG", "GET", "a"])).toBeNull();
  });
});

describe("redis replies", () => {
  it.each([
    [null, "(nil)"],
    [7, "(integer) 7"],
    [Buffer.from("Ann"), '"Ann"'],
    [Buffer.from([0xff, 0x00]), String.raw`"\xff\x00"`],
  ])("givenReply %j_whenText_thenRedisCliWording", (reply, text) => {
    expect(replyText(reply)).toBe(text);
  });

  it("givenMap_whenResult_thenKeyValueRows", async () => {
    const result = resultOf(new Map([[Buffer.from("name"), Buffer.from("Ann")]]));
    expect(result.columns.map((column) => column.name)).toEqual(["key", "value"]);
    expect(await rowsOf(result.rows)).toEqual([["name", "Ann"]]);
  });

  it("givenScoredPairs_whenResult_thenMemberScoreRows", async () => {
    const result = resultOf([[Buffer.from("ann"), 120]]);
    expect(result.columns.map((column) => column.name)).toEqual(["member", "score"]);
    expect(await rowsOf(result.rows)).toEqual([["ann", 120]]);
  });
});

describe("redis cluster nodes", () => {
  const CLUSTER_NODES = [
    "b4 10.0.0.4:6379@16379 slave a1 0 1 1 connected",
    "a1 10.0.0.1:6379@16379 myself,master - 0 0 1 connected 0-5460",
    "c2 10.0.0.2:6379@16379 master,fail - 0 0 2 disconnected 5461-10922 [5462->-c3]",
    "",
  ].join("\n");

  it("givenClusterNodes_whenParsed_thenPrimariesFirstWithMappedAddresses", () => {
    const nodes = nodesOf(CLUSTER_NODES, (announced) => (announced === "10.0.0.1:6379" ? "127.0.0.1:7001" : announced));
    expect(nodes).toEqual([
      { id: "c2", address: "10.0.0.2:6379", role: "primary", slots: [[5461, 10922]], primaryId: null, state: "fail" },
      { id: "a1", address: "127.0.0.1:7001", role: "primary", slots: [[0, 5460]], primaryId: null, state: "connected" },
      { id: "b4", address: "10.0.0.4:6379", role: "replica", slots: [], primaryId: "a1", state: "connected" },
    ]);
  });

  it("givenNodeAddressMap_whenParsed_thenPairsOrNamedRefusal", () => {
    expect([...parseNodeAddressMap("10.0.0.1:6379=127.0.0.1:7001,\n 10.0.0.2:6379 = localhost:7002")]).toEqual([
      ["10.0.0.1:6379", { host: "127.0.0.1", port: 7001 }],
      ["10.0.0.2:6379", { host: "localhost", port: 7002 }],
    ]);
    expect(() => parseNodeAddressMap("10.0.0.1:6379")).toThrow(/is not announced=host:port/);
  });
});

describe("redis completion offline", () => {
  it("givenCommandPrefix_whenCompleted_thenCommandsFromTheSnapshot", async () => {
    const result = await complete({ text: "hge", offset: 3 }, null);
    expect(result.from).toBe(0);
    expect(result.items.map((item) => item.label)).toContain("HGET");
  });

  it("givenContainer_whenSecondWord_thenSubcommands", async () => {
    const result = await complete({ text: "CONFIG ", offset: 7 }, null);
    expect(result.items.map((item) => item.label)).toEqual(expect.arrayContaining(["GET", "SET"]));
  });

  it("givenSetValue_whenCompleted_thenOptionsOffered", async () => {
    const result = await complete({ text: "SET k v ", offset: 8 }, null);
    expect(result.items.map((item) => item.label)).toEqual(expect.arrayContaining(["NX", "XX", "EX"]));
  });
});
