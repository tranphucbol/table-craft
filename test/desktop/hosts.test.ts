import { describe, expect, it } from "vitest";
import {
  ENGINE_HOST_KEY_ANSWER_MESSAGE,
  ENGINE_HOST_KEY_MESSAGE,
  ENGINE_LOG_MESSAGE,
  ENGINE_PROBED_MESSAGE,
  ENGINE_SHUTDOWN_MESSAGE,
} from "@table-craft/desktop/engine/protocol.js";
import type { HostKeyOffer, HostKeyVerdict } from "@table-craft/desktop/engine/protocol.js";
import { createLogger, type LogRecord } from "@table-craft/desktop/log/record.js";
import { createHostRegistry, PROBE_TIMEOUT_MS } from "@table-craft/desktop/main/hosts.js";
import { fakeHostDependencies } from "../support/fakeHosts.js";

const DATASOURCE = { id: "pg", pluginId: "postgres", config: { host: "db" }, readOnly: true, keepAliveSeconds: 0 };

function registry(hostKeys?: (offer: HostKeyOffer) => Promise<HostKeyVerdict>) {
  const dependencies = fakeHostDependencies();
  const exits: [string, number, boolean][] = [];
  const hosts = createHostRegistry({
    pluginRoots: ["/plugins"],
    dependencies,
    onExit: (id, code, clean) => exits.push([id, code, clean]),
    ...(hostKeys === undefined ? {} : { hostKeys }),
  });
  return { dependencies, exits, hosts };
}

describe("host registry", () => {
  it("givenTwoOpens_whenSameDatasource_thenOneHostTwoPorts", () => {
    const { dependencies, hosts } = registry();

    hosts.open(DATASOURCE, "window-1");
    hosts.open(DATASOURCE, "window-1");

    expect(dependencies.forked).toHaveLength(1);
    expect(dependencies.forked[0]?.posted[0]).toMatchObject({
      kind: "engine.boot",
      mode: "serve",
      datasource: DATASOURCE,
    });
    expect(dependencies.ports).toEqual([
      ["pg", "window-1"],
      ["pg", "window-1"],
    ]);
  });

  it("givenRunningHost_whenStopped_thenShutdownPostedAndExitReportedClean", async () => {
    const { dependencies, exits, hosts } = registry();
    hosts.open(DATASOURCE, "window-1");
    const host = dependencies.forked[0];

    const stopped = hosts.stop("pg");
    expect(host?.posted).toContainEqual({ kind: ENGINE_SHUTDOWN_MESSAGE });
    host?.exit(0);
    await stopped;

    expect(hosts.isRunning("pg")).toBe(false);
    expect(exits).toEqual([["pg", 0, true]]);
  });

  it("givenStoppingHostIgnoresShutdown_whenGraceElapses_thenKilledAndStillClean", async () => {
    const { dependencies, exits, hosts } = registry();
    hosts.open(DATASOURCE, "window-1");

    const stopped = hosts.stop("pg");
    dependencies.elapse();
    await stopped;

    expect(dependencies.forked[0]?.killed).toBe(true);
    expect(exits).toEqual([["pg", 1, true]]);
  });

  it("givenHostDiesUnasked_whenExitReported_thenNotClean", () => {
    const { dependencies, exits, hosts } = registry();
    hosts.open(DATASOURCE, "window-1");

    dependencies.forked[0]?.exit(15);

    expect(exits).toEqual([["pg", 15, false]]);
    expect(hosts.isRunning("pg")).toBe(false);
  });

  it("givenProbeAnswers_whenProbed_thenResolvesWithItsResult", async () => {
    const { dependencies, hosts } = registry();
    const probing = hosts.probe(DATASOURCE);
    const probe = dependencies.forked[0];
    const result = { ok: true, pluginName: "PostgreSQL", serverVersion: "17.4", elapsedMs: 38 } as const;

    probe?.answer({ kind: ENGINE_PROBED_MESSAGE, result });

    expect(probe?.posted[0]).toMatchObject({ kind: "engine.boot", mode: "probe" });
    expect(await probing).toEqual(result);
    expect(hosts.isRunning("pg")).toBe(false);
  });

  it("givenProbeHangs_whenTimeoutElapses_thenProbeKilledAndTimeoutError", async () => {
    const { dependencies, hosts } = registry();
    const probing = hosts.probe(DATASOURCE);

    dependencies.elapse();

    expect(dependencies.forked[0]?.killed).toBe(true);
    expect(await probing).toMatchObject({
      ok: false,
      error: { code: "timedOut", message: expect.stringContaining(String(PROBE_TIMEOUT_MS / 1_000)) as unknown },
    });
  });

  it("givenProbeCrashes_whenExited_thenFailsWithoutWaitingForTimeout", async () => {
    const { dependencies, hosts } = registry();
    const probing = hosts.probe(DATASOURCE);

    dependencies.forked[0]?.exit(9);

    expect(await probing).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("givenEngineLogMessage_whenPosted_thenForwardedWithItsProcess", () => {
    const { dependencies, forwarded, hosts, protectedConfigs } = loggedRegistry();

    hosts.open(DATASOURCE, "window-1");
    dependencies.forked[0]?.answer({ kind: ENGINE_LOG_MESSAGE, record: { msg: "hi" } });
    dependencies.forked[0]?.answer({ kind: "something.else" });

    expect(forwarded).toEqual([[{ msg: "hi" }, "engine:pg"]]);
    expect(protectedConfigs).toEqual([DATASOURCE]);
  });

  it("givenEngineDies_whenExited_thenWarnRecordWithCodeAndUptime", () => {
    const { dependencies, hosts, records } = loggedRegistry();

    hosts.open(DATASOURCE, "window-1");
    dependencies.forked[0]?.exit(137);

    expect(records.map((record) => [record.level, record.msg])).toEqual([
      ["info", "engine host started"],
      ["warn", "engine host exited unexpectedly"],
    ]);
    expect(records[1]).toMatchObject({ scope: "engine", datasourceId: "pg", code: 137, clean: false, uptimeMs: 0 });
  });
});

function loggedRegistry() {
  const dependencies = fakeHostDependencies();
  const records: LogRecord[] = [];
  const forwarded: [unknown, string][] = [];
  const protectedConfigs: unknown[] = [];
  const hosts = createHostRegistry({
    pluginRoots: ["/plugins"],
    dependencies,
    onExit: () => {},
    now: () => 0,
    log: {
      logger: createLogger({ process: "main", scope: "app", sink: (record) => records.push(record) }),
      forward: (record, process) => forwarded.push([record, process]),
      protect: (datasource) => protectedConfigs.push(datasource),
    },
  });
  return { dependencies, forwarded, hosts, protectedConfigs, records };
}

const OFFER: HostKeyOffer = {
  host: "bastion",
  port: 22,
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:abc",
  key: "AAAA",
};

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("host registry host keys", () => {
  it("givenEngineOffersHostKey_whenRuled_thenVerdictPostedBack", async () => {
    const asked: HostKeyOffer[] = [];
    const { dependencies, hosts } = registry((offer) => {
      asked.push(offer);
      return Promise.resolve({ verdict: "trusted" });
    });
    hosts.open(DATASOURCE, "window-1");
    const host = dependencies.forked[0];

    host?.answer({ kind: ENGINE_HOST_KEY_MESSAGE, requestId: 7, offer: OFFER });
    await settle();

    expect(asked).toEqual([OFFER]);
    expect(host?.posted).toContainEqual({ kind: ENGINE_HOST_KEY_ANSWER_MESSAGE, requestId: 7, verdict: "trusted" });
  });

  it("givenNoHostKeyRuling_whenEngineOffersKey_thenRejected", async () => {
    const { dependencies, hosts } = registry();
    hosts.open(DATASOURCE, "window-1");
    const host = dependencies.forked[0];

    host?.answer({ kind: ENGINE_HOST_KEY_MESSAGE, requestId: 1, offer: OFFER });
    await settle();

    expect(host?.posted).toContainEqual({ kind: ENGINE_HOST_KEY_ANSWER_MESSAGE, requestId: 1, verdict: "rejected" });
  });

  it("givenHostKeyAsked_whenProbeTimerRuns_thenPausedUntilAnswered", async () => {
    let answer: (verdict: HostKeyVerdict) => void = () => undefined;
    const { dependencies, hosts } = registry(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    let result: unknown = null;
    void hosts.probe(DATASOURCE).then((probed) => (result = probed));
    const probe = dependencies.forked[0];

    probe?.answer({ kind: ENGINE_HOST_KEY_MESSAGE, requestId: 1, offer: OFFER });
    dependencies.elapse();
    await settle();
    expect(result).toBeNull();
    expect(probe?.killed).toBe(false);

    answer({ verdict: "trusted" });
    await settle();
    dependencies.elapse();
    await settle();
    expect(result).toMatchObject({ ok: false, error: { code: "timedOut" } });
  });
});
