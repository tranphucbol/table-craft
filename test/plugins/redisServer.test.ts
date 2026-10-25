import { describe, expect, it } from "vitest";
import { infoSections, slowCommandOf } from "@table-craft/plugin-redis/server";
import { clientSession, parseSessionId, sessionId } from "@table-craft/plugin-redis/sessions";

const INFO = "# Server\r\nredis_version:6.2.14\r\n\r\n# Modules\r\n\r\n# Memory\r\nused_memory:1024\r\n";
const BLOCKED =
  "id=12 addr=127.0.0.1:50000 laddr=127.0.0.1:6379 fd=9 name=TableCraft age=4 idle=3 flags=b db=0 sub=0 psub=0 multi=-1 cmd=blpop user=table_craft";
const REPLICA_LINK = "id=4 addr=10.0.0.2:6380 fd=8 name= age=60 idle=1 flags=S db=0 multi=-1 cmd=replconf user=default";
const IN_MULTI = "id=7 addr=127.0.0.1:50001 fd=10 name= age=9 idle=2 flags=N db=1 multi=2 cmd=set user=default";

describe("redis server info", () => {
  it("givenOneInfo_whenSplit_thenShownSectionsOnly", () => {
    expect(infoSections(INFO)).toEqual([
      { title: "Server", entries: [{ name: "redis_version", value: "6.2.14" }] },
      { title: "Memory", entries: [{ name: "used_memory", value: "1024" }] },
    ]);
  });

  it("givenSlowLogEntry_whenRead_thenCommandAsTyped", () => {
    const entry = [
      3,
      1_700_000_000,
      12_500,
      [Buffer.from("SET"), Buffer.from("a b"), Buffer.from([0xff])],
      "127.0.0.1:1",
      "",
    ];
    expect(slowCommandOf(entry, "127.0.0.1:7001")).toEqual({
      id: 3,
      at: "2023-11-14T22:13:20.000Z",
      durationMicros: 12_500,
      command: 'SET "a b" "\\xff"',
      client: "127.0.0.1:1",
      node: "127.0.0.1:7001",
    });
  });
});

describe("redis sessions", () => {
  it("givenBlockedClient_whenListed_thenActiveWithUnblock", () => {
    expect(clientSession(BLOCKED, null)).toMatchObject({
      id: "12",
      state: "active",
      database: "db0",
      application: "TableCraft",
      queryMs: 3000,
      query: "blpop",
      cancel: "CLIENT UNBLOCK 12 ERROR",
      terminate: "CLIENT KILL ID 12",
      system: false,
    });
  });

  it("givenReplicationLinkAndMulti_whenListed_thenSystemAndIdleInTransaction", () => {
    expect(clientSession(REPLICA_LINK, "127.0.0.1:7001")).toMatchObject({
      id: "4@127.0.0.1:7001",
      database: "127.0.0.1:7001",
      system: true,
      cancel: null,
      application: null,
    });
    expect(clientSession(IN_MULTI, null)).toMatchObject({ state: "idleInTransaction", queryMs: null });
  });

  it("givenClusterId_whenParsed_thenClientAndNode", () => {
    expect(parseSessionId(sessionId("12", "127.0.0.1:7001"))).toEqual({ clientId: "12", node: "127.0.0.1:7001" });
    expect(parseSessionId("12")).toEqual({ clientId: "12", node: null });
  });
});
