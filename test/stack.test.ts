import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEED_ENV, seedEnv, seedHashes } from "./db/stack.js";

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
    const env = seedEnv({ postgres: "a", mysql: "b", "postgres-tls": "c", "mysql-tls": "d" });

    expect(env).toEqual({
      [SEED_ENV.postgres]: "a",
      [SEED_ENV.mysql]: "b",
      [SEED_ENV["postgres-tls"]]: "c",
      [SEED_ENV["mysql-tls"]]: "d",
    });
  });
});
