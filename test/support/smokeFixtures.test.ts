import { describe, expect, it } from "vitest";
import {
  SENTINELS,
  sentinelsFor,
  servicesMissingSentinels,
  servicesOf,
  smokeSelectionProblem,
  staleServices,
  type SentinelQuery,
} from "./smokeFixtures.js";

const NEWEST_POSTGRES = "SELECT 1 FROM pg_proc p JOIN pg_namespace n";

describe("smoke fixture sentinels (smokeFixtures.ts)", () => {
  it("givenEverySentinelPresent_whenChecked_thenNothingStale", async () => {
    expect(await staleServices(() => Promise.resolve(true))).toEqual([]);
  });

  it("givenOldPostgresContainer_whenChecked_thenNamesServiceObjectAndFix", async () => {
    const query: SentinelQuery = (service, sql) =>
      Promise.resolve(!(service === "postgres" && sql.startsWith(NEWEST_POSTGRES)));

    expect(await staleServices(query)).toEqual([
      "the `postgres` container predates its seed (no procedure settle_order); run `bun test/db/up.ts`",
    ]);
  });

  it("givenServerDown_whenChecked_thenReportedOnceAndOthersStillChecked", async () => {
    const query: SentinelQuery = (service) =>
      service === "mysql"
        ? Promise.reject(new Error("connect ECONNREFUSED"))
        : Promise.resolve(service !== "mysql-tls");

    expect(await staleServices(query)).toEqual([
      "the `mysql` server did not answer (connect ECONNREFUSED); run `bun test/db/up.ts`",
      "the `mysql-tls` container predates its seed (no table tls_probe); run `bun test/db/up.ts`",
    ]);
  });

  it("givenRefusedOnEveryAddress_whenChecked_thenReasonIsTheCode", async () => {
    const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    const query: SentinelQuery = (service) =>
      service === "postgres-tls" ? Promise.reject(refused) : Promise.resolve(true);

    expect(await staleServices(query)).toEqual([
      "the `postgres-tls` server did not answer (ECONNREFUSED); run `bun test/db/up.ts`",
    ]);
  });

  it("givenMissingAndUnreachableServices_whenListedForReseed_thenOnlyTheMissingOnes", async () => {
    const query: SentinelQuery = (service, sql) =>
      service === "mysql"
        ? Promise.reject(new Error("connect ECONNREFUSED"))
        : Promise.resolve(!(service === "postgres" && sql.startsWith(NEWEST_POSTGRES)));

    expect(await servicesMissingSentinels(query)).toEqual(["postgres"]);
  });

  it("givenSentinels_whenListed_thenEverySeededServiceHasOne", () => {
    expect(new Set(SENTINELS.map((sentinel) => sentinel.service))).toEqual(
      new Set([
        "postgres",
        "mysql",
        "mariadb",
        "postgres-tls",
        "mysql-tls",
        "oracle",
        "mssql",
        "redis",
        "redis-tls",
        "redis-6",
        "redis-cluster",
        "redis-6-cluster",
        "redis-5",
        "redis-5-cluster",
      ]),
    );
  });

  it("givenServiceNotSelected_whenSeedStale_thenNotChecked", async () => {
    const asked = new Set<string>();
    const query: SentinelQuery = (service) => {
      asked.add(service);
      return Promise.resolve(service !== "postgres" && service !== "oracle");
    };

    const sentinels = sentinelsFor(servicesOf(["mysql", "tidb"]));

    expect(await staleServices(query, sentinels)).toEqual([]);
    expect([...asked].sort()).toEqual(["mysql", "mysql-tls"]);
  });

  it("givenSmokeSelectionWithoutMysql_whenChecked_thenNamesWhatItNeeds", () => {
    expect(smokeSelectionProblem(["mysql", "tidb", "postgres"])).toBeNull();
    expect(smokeSelectionProblem(["postgres"])).toBe(
      "TABLE_CRAFT_DATABASES leaves out mysql, tidb, which every smoke run needs; add to mysql,tidb instead",
    );
  });
});
