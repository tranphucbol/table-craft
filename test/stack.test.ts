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
  for (const folder of ["schema", "tls"])
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
    const env = seedEnv({ postgres: "a", mysql: "b", "postgres-tls": "c", "mysql-tls": "d", oracle: "e", mssql: "f" });

    expect(env).toEqual({
      [SEED_ENV.postgres]: "a",
      [SEED_ENV.mysql]: "b",
      [SEED_ENV["postgres-tls"]]: "c",
      [SEED_ENV["mysql-tls"]]: "d",
      [SEED_ENV.oracle]: "e",
      [SEED_ENV.mssql]: "f",
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
});

const REMOTE_TIDB: TidbTarget = { remote: true, env: {}, description: "remote" };
const LOCAL_TIDB: TidbTarget = { remote: false, env: {}, description: "local" };

describe("database selector (decision 099)", () => {
  it("givenSelectorUnset_whenTestDbRuns_thenOnlyMysqlAndTidb", () => {
    const databases = selectedDatabases({});

    expect(databases).toEqual(["mysql", "tidb"]);
    expect(stackFor(databases, REMOTE_TIDB)).toEqual({
      profiles: ["--profile", "mysql"],
      services: ["mysql", "mysql-tls"],
    });
    expect(describeSelection(databases, {})).toBe(
      `Databases: mysql, tidb (from ${DATABASES_ENV} unset, the normal flow); not started: postgres, oracle, mssql`,
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
      profiles: ["mysql", "tidb", "postgres", "oracle", "mssql"].flatMap((profile) => ["--profile", profile]),
      services: ["mysql", "mysql-tls", "postgres", "postgres-tls", "oracle", "mssql"],
    });
    expect(stackFor(databases, REMOTE_TIDB).profiles).not.toContain("tidb");
  });

  it("givenSelectorInAnyCaseAndOrder_whenRead_thenKnownOrderWithoutDuplicates", () => {
    expect(selectedDatabases({ [DATABASES_ENV]: " MSSQL, mysql ,tidb,mysql" })).toEqual(["mysql", "tidb", "mssql"]);
  });

  it("givenUnknownDatabaseInSelector_whenUp_thenErrorNamesKnownIds", () => {
    expect(() => selectedDatabases({ [DATABASES_ENV]: "mysql,sybase" })).toThrow(
      `${DATABASES_ENV} names sybase, which is not a test database; list any of mysql, tidb, postgres, oracle, mssql, all, separated by commas.`,
    );
  });
});
