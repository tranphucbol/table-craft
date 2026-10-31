import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSelection, SEED_ENV, seedEnv, seedHashes, stackFor } from "./db/stack.js";
import type { TidbTarget } from "./db/tidbTarget.js";
import { databaseEnabled, DATABASES_ENV, selectedDatabases, WITHOUT_POSTGRES } from "./support/databases.js";

const DB_DIRECTORY = join(import.meta.dirname, "db");

function copyOfSeeds(): string {
  const directory = mkdtempSync(join(tmpdir(), "table-craft-seeds-"));
  for (const folder of ["schema", "tls", "redis", "etcd"])
    cpSync(join(DB_DIRECTORY, folder), join(directory, folder), { recursive: true });
  return directory;
}

describe("seed hashes (test/db/stack.ts)", () => {
  it("givenSeedFileEdited_whenHashed_thenOnlyItsServiceHashChanges", () => {
    const directory = copyOfSeeds();
    const before = seedHashes(directory);

    appendFileSync(join(directory, "schema", "postgres.sql"), "\n-- edited\n");
    const after = seedHashes(directory);

    expect(after.postgres).not.toBe(before.postgres);
    expect({ ...after, postgres: before.postgres }).toEqual(before);
  });

  it("givenTlsCertificateReplaced_whenHashed_thenBothTlsServicesChange", () => {
    const directory = copyOfSeeds();
    const before = seedHashes(directory);

    appendFileSync(join(directory, "tls", "server.crt"), "\n");
    const after = seedHashes(directory);

    expect(after["postgres-tls"]).not.toBe(before["postgres-tls"]);
    expect(after["mysql-tls"]).not.toBe(before["mysql-tls"]);
    expect([after.postgres, after.mysql]).toEqual([before.postgres, before.mysql]);
  });

  it("givenSameFiles_whenHashedTwice_thenEqual", () => {
    expect(seedHashes()).toEqual(seedHashes(copyOfSeeds()));
  });

  it("givenHashes_whenTurnedIntoEnv_thenOneLabelVariablePerService", () => {
    const env = seedEnv({
      postgres: "a",
      mysql: "b",
      "postgres-tls": "c",
      "mysql-tls": "d",
      oracle: "e",
      mssql: "f",
      redis: "g",
      "redis-tls": "h",
      "redis-6": "i",
      "redis-cluster": "j",
      "redis-6-cluster": "k",
      "redis-5": "l",
      "redis-5-cluster": "m",
      mariadb: "n",
      etcd: "o",
      "etcd-3-5": "p",
      "etcd-tls": "q",
      "redis-sentinel": "r",
    });

    expect(env).toEqual({
      [SEED_ENV.postgres]: "a",
      [SEED_ENV.mysql]: "b",
      [SEED_ENV["postgres-tls"]]: "c",
      [SEED_ENV["mysql-tls"]]: "d",
      [SEED_ENV.oracle]: "e",
      [SEED_ENV.mssql]: "f",
      [SEED_ENV.redis]: "g",
      [SEED_ENV["redis-tls"]]: "h",
      [SEED_ENV["redis-6"]]: "i",
      [SEED_ENV["redis-cluster"]]: "j",
      [SEED_ENV["redis-6-cluster"]]: "k",
      [SEED_ENV["redis-5"]]: "l",
      [SEED_ENV["redis-5-cluster"]]: "m",
      [SEED_ENV.mariadb]: "n",
      [SEED_ENV.etcd]: "o",
      [SEED_ENV["etcd-3-5"]]: "p",
      [SEED_ENV["etcd-tls"]]: "q",
      [SEED_ENV["redis-sentinel"]]: "r",
    });
  });

  it("givenOracleSeedDirectoryGainsAFile_whenHashed_thenOnlyOracleChanges", () => {
    const directory = copyOfSeeds();
    const before = seedHashes(directory);

    appendFileSync(join(directory, "schema", "oracle", "02-more.sql"), "SELECT 1 FROM dual;\n");
    const after = seedHashes(directory);

    expect(after.oracle).not.toBe(before.oracle);
    expect({ ...after, oracle: before.oracle }).toEqual(before);
  });

  it("givenRedisClusterScriptEdited_whenHashed_thenOnlyTheClustersChange", () => {
    const directory = copyOfSeeds();
    const before = seedHashes(directory);

    appendFileSync(join(directory, "redis", "cluster.sh"), "\n# edited\n");
    const after = seedHashes(directory);

    expect(after["redis-cluster"]).not.toBe(before["redis-cluster"]);
    expect(after["redis-6-cluster"]).not.toBe(before["redis-6-cluster"]);
    expect(after["redis-5-cluster"]).not.toBe(before["redis-5-cluster"]);
    expect({
      ...after,
      "redis-cluster": before["redis-cluster"],
      "redis-6-cluster": before["redis-6-cluster"],
      "redis-5-cluster": before["redis-5-cluster"],
    }).toEqual(before);
  });
});

const REMOTE_TIDB: TidbTarget = { remote: true, env: {}, description: "remote" };
const LOCAL_TIDB: TidbTarget = { remote: false, env: {}, description: "local" };

describe("database selector (decision 099)", () => {
  it("givenSelectorUnset_whenTestDbRuns_thenEveryMysqlPluginServer", () => {
    const databases = selectedDatabases({});

    expect(databases).toEqual(["mysql", "tidb", "mariadb"]);
    expect(stackFor(databases, REMOTE_TIDB)).toEqual({
      profiles: ["mysql", "mariadb"].flatMap((profile) => ["--profile", profile]),
      services: ["mysql", "mysql-tls", "mariadb"],
    });
    expect(describeSelection(databases, {})).toBe(
      `Databases: mysql, tidb, mariadb (from ${DATABASES_ENV} unset, the normal flow); not started: postgres, oracle, mssql, redis, etcd`,
    );
  });

  it("givenSelectorUnset_whenSmokeRuns_thenPostgresScenariosSkipped", () => {
    expect(databaseEnabled("postgres", {})).toBe(false);
    expect(WITHOUT_POSTGRES).toBe(!databaseEnabled("postgres"));
  });

  it("givenSelectorPostgres_whenUp_thenOnlyPostgresStarted", () => {
    const databases = selectedDatabases({ [DATABASES_ENV]: "postgres" });

    expect(stackFor(databases, LOCAL_TIDB)).toEqual({
      profiles: ["--profile", "postgres"],
      services: ["postgres", "postgres-tls"],
    });
  });

  it("givenSelectorAll_whenUp_thenEveryServiceStarted", () => {
    const databases = selectedDatabases({ [DATABASES_ENV]: "all" });

    expect(stackFor(databases, LOCAL_TIDB)).toEqual({
      profiles: ["mysql", "tidb", "mariadb", "postgres", "oracle", "mssql", "redis", "etcd"].flatMap((profile) => [
        "--profile",
        profile,
      ]),
      services: [
        "mysql",
        "mysql-tls",
        "mariadb",
        "postgres",
        "postgres-tls",
        "oracle",
        "mssql",
        "redis",
        "redis-tls",
        "redis-6",
        "redis-cluster",
        "redis-6-cluster",
        "redis-5",
        "redis-5-cluster",
        "redis-sentinel",
        "etcd",
        "etcd-3-5",
        "etcd-tls",
      ],
    });
    expect(stackFor(databases, REMOTE_TIDB).profiles).not.toContain("tidb");
  });

  it("givenSelectorInAnyCaseAndOrder_whenRead_thenKnownOrderWithoutDuplicates", () => {
    expect(selectedDatabases({ [DATABASES_ENV]: " MSSQL, mysql ,tidb,mysql" })).toEqual(["mysql", "tidb", "mssql"]);
  });

  it("givenUnknownDatabaseInSelector_whenUp_thenErrorNamesKnownIds", () => {
    expect(() => selectedDatabases({ [DATABASES_ENV]: "mysql,sybase" })).toThrow(
      `${DATABASES_ENV} names sybase, which is not a test database; list any of mysql, tidb, mariadb, postgres, oracle, mssql, redis, etcd, all, separated by commas.`,
    );
  });
});
