import { describe, expect, it } from "vitest";
import { PluginError } from "@table-craft/plugin-api";
import type { Client } from "@table-craft/plugin-redis/connect";
import {
  discoverPrimary,
  droppedWhenDemoted,
  parseSentinels,
  replicasOfInfo,
  type Address,
  type SentinelDial,
} from "@table-craft/plugin-redis/sentinel";

type Answer = unknown;

/** A client answering each command by its first two words; an `Error` answer is thrown. */
function stubClient(answers: Readonly<Record<string, Answer>>, log: string[] = []): Client & { destroyed: boolean } {
  const client = {
    destroyed: false,
    get isReady() {
      return !client.destroyed;
    },
    sendCommand<T>(args: readonly (string | Buffer)[]): Promise<T> {
      const words = args.map(String);
      log.push(words.join(" "));
      const answer = answers[words.slice(0, 2).join(" ")] ?? answers[words[0] ?? ""];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer as T);
    },
    close: () => Promise.resolve(),
    destroy: () => {
      client.destroyed = true;
    },
  };
  return client;
}

const SENTINEL_A = { host: "a", port: 26379 };
const SENTINEL_B = { host: "b", port: 26379 };
const PRIMARY = { "INFO replication": "role:master\r\n", ROLE: ["master", 0, []] };
const REPLICA = { ROLE: ["slave", "x", 6379, "connected", 0] };
const identity = (announced: string): string => announced;

function dialOf(
  sentinels: Readonly<Record<string, Readonly<Record<string, Answer>> | Error>>,
  primaries: Readonly<Record<string, Readonly<Record<string, Answer>> | Error>>,
  dialled: string[] = [],
): SentinelDial {
  const key = (address: Address): string => `${address.host}:${String(address.port)}`;
  return {
    sentinel: (address) => {
      const answers = sentinels[key(address)];
      if (answers === undefined || answers instanceof Error) {
        return Promise.reject(answers ?? new Error("connect ECONNREFUSED"));
      }
      return Promise.resolve(stubClient(answers));
    },
    primary: (address) => {
      dialled.push(key(address));
      const answers = primaries[key(address)];
      if (answers === undefined || answers instanceof Error) {
        return Promise.reject(answers ?? new Error("connect ECONNREFUSED"));
      }
      return Promise.resolve({ client: stubClient(answers), resp: 3 });
    },
  };
}

async function failureOf(work: Promise<unknown>): Promise<PluginError> {
  const error = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PluginError);
  return error as PluginError;
}

describe("redis sentinel discovery", () => {
  it("givenSentinelList_whenParsed_thenHostPortPairsInOrder", () => {
    expect(parseSentinels(" 10.0.1.6:26379,\n10.0.1.7:26380 , ")).toEqual([
      { host: "10.0.1.6", port: 26379 },
      { host: "10.0.1.7", port: 26380 },
    ]);
    expect(parseSentinels("")).toEqual([]);
  });

  it("givenBadSentinelEntry_whenParsed_thenConnectionFailedNamingTheField", () => {
    expect(() => parseSentinels("10.0.1.6")).toThrow(/Other sentinels entry "10\.0\.1\.6" is not host:port/);
  });

  it("givenFirstSentinelDown_whenDiscovered_thenSecondAnswers", async () => {
    const dial = dialOf(
      { "b:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": ["10.0.0.5", "6379"] } },
      {
        "10.0.0.5:6379": PRIMARY,
      },
    );

    const primary = await discoverPrimary(dial, [SENTINEL_A, SENTINEL_B], "mymaster", identity);

    expect(primary.address).toBe("10.0.0.5:6379");
  });

  it("givenEverySentinelUnreachable_whenDiscovered_thenFailureNamesEach", async () => {
    const failure = await failureOf(discoverPrimary(dialOf({}, {}), [SENTINEL_A, SENTINEL_B], "mymaster", identity));

    expect(failure.message).toBe(
      "No Sentinel answered: a:26379 (connect ECONNREFUSED); b:26379 (connect ECONNREFUSED).",
    );
  });

  it("givenNoSentinelKnowsName_whenDiscovered_thenFailureListsMonitoredMasters", async () => {
    const masters = [new Map([["name", "cache"]]), ["name", "sessions", "ip", "10.0.0.1"]];
    const dial = dialOf({ "a:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": null, "SENTINEL MASTERS": masters } }, {});

    const failure = await failureOf(discoverPrimary(dial, [SENTINEL_A], "foo", identity));

    expect(failure.message).toBe("No Sentinel monitors a master named foo. a:26379 monitors cache, sessions.");
  });

  it("givenDataServerAsSentinel_whenDiscovered_thenFailureSays26379", async () => {
    const dial = dialOf({ "a:6379": { SENTINEL: new Error("ERR unknown command 'SENTINEL'") } }, {});

    const failure = await failureOf(discoverPrimary(dial, [{ host: "a", port: 6379 }], "mymaster", identity));

    expect(failure.message).toBe(
      "a:6379 is not a Sentinel. Sentinels usually listen on 26379; or choose Standalone mode.",
    );
  });

  it("givenSentinelRefusesLogin_whenDiscovered_thenFailureNamesSentinelLogin", async () => {
    const dial = dialOf({ "a:26379": new Error("NOAUTH Authentication required.") }, {});

    const failure = await failureOf(discoverPrimary(dial, [SENTINEL_A], "mymaster", identity));

    expect(failure.message).toBe(
      "Sentinel a:26379 (NOAUTH Authentication required.) refused the login. Fill Sentinel username and password.",
    );
  });

  it("givenAnnouncedPrimaryUnreachable_whenDiscovered_thenFailureNamesAddressMapEntry", async () => {
    const dial = dialOf({ "a:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": ["172.18.0.5", "6379"] } }, {});

    const failure = await failureOf(discoverPrimary(dial, [SENTINEL_A], "mymaster", identity));

    expect(failure.message).toBe(
      "Sentinel names 172.18.0.5:6379 the master of mymaster, which cannot be reached: connect ECONNREFUSED. Add it to Node address map as 172.18.0.5:6379=<host:port you can reach>.",
    );
  });

  it("givenMappedPrimary_whenDiscovered_thenDialsMappedAddress", async () => {
    const dialled: string[] = [];
    const dial = dialOf(
      { "a:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": ["172.18.0.5", "6379"] } },
      { "127.0.0.1:47031": PRIMARY },
      dialled,
    );
    const map = (announced: string): string => (announced === "172.18.0.5:6379" ? "127.0.0.1:47031" : announced);

    const primary = await discoverPrimary(dial, [SENTINEL_A], "mymaster", map);

    expect(dialled).toEqual(["127.0.0.1:47031"]);
    expect(primary.address).toBe("127.0.0.1:47031");
  });

  it("givenNamedPrimaryIsReplica_whenDiscovered_thenNextSentinelAsked", async () => {
    const dial = dialOf(
      {
        "a:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": ["10.0.0.5", "6379"] },
        "b:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": ["10.0.0.6", "6379"] },
      },
      { "10.0.0.5:6379": REPLICA, "10.0.0.6:6379": PRIMARY },
    );

    const primary = await discoverPrimary(dial, [SENTINEL_A, SENTINEL_B], "mymaster", identity);

    expect(primary.address).toBe("10.0.0.6:6379");
  });

  it("givenEveryNamedPrimaryIsReplica_whenDiscovered_thenFailoverInProgress", async () => {
    const dial = dialOf(
      { "a:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": ["10.0.0.5", "6379"] } },
      { "10.0.0.5:6379": REPLICA },
    );

    const failure = await failureOf(discoverPrimary(dial, [SENTINEL_A], "mymaster", identity));

    expect(failure.message).toBe(
      "The master Sentinel names for mymaster, 10.0.0.5:6379, is a replica: a failover is in progress. Connect again in a few seconds.",
    );
  });

  it("givenDataLoginRefused_whenDiscovered_thenRefusalThrownAsIs", async () => {
    const refused = new Error("WRONGPASS invalid username-password pair or user is disabled.");
    const dial = dialOf(
      { "a:26379": { "SENTINEL GET-MASTER-ADDR-BY-NAME": ["10.0.0.5", "6379"] } },
      { "10.0.0.5:6379": refused },
    );

    await expect(discoverPrimary(dial, [SENTINEL_A], "mymaster", identity)).rejects.toBe(refused);
  });

  it("givenReplicationInfo_whenParsed_thenReplicaAddressesAndStates", () => {
    const info =
      "# Replication\r\nrole:master\r\nconnected_slaves:2\r\nslave0:ip=127.0.0.1,port=47032,state=online,offset=10,lag=0\r\nslave1:ip=10.0.0.7,port=6379,state=wait_bgsave,offset=0,lag=1\r\nmaster_repl_offset:10\r\n";

    expect(replicasOfInfo(info)).toEqual([
      { announced: "127.0.0.1:47032", state: "online" },
      { announced: "10.0.0.7:6379", state: "wait_bgsave" },
    ]);
  });

  it("givenDemotedMaster_whenWrite_thenStatementFailedAndClientDropped", async () => {
    const inner = stubClient({
      SET: new Error("READONLY You can't write against a read only replica."),
      GET: "v",
    });
    const client = droppedWhenDemoted(inner, "127.0.0.1:47031", "mymaster");

    expect(await client.sendCommand(["GET", "k"])).toBe("v");
    const failure = await failureOf(client.sendCommand(["SET", "k", "v"]));

    expect(failure.code).toBe("statementFailed");
    expect(failure.message).toBe(
      "127.0.0.1:47031 is no longer the master of mymaster (READONLY): Sentinel moved it. Run again to reconnect.",
    );
    expect(client.isReady).toBe(false);
  });
});
