import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERIAL_SMOKE_FILES } from "../serialFiles.js";
import {
  displayFor,
  resolveWorkers,
  SMOKE_WORKERS_DEFAULT,
  SMOKE_WORKERS_MIN_VM_BYTES,
  WORKERS_ENV,
} from "./workers.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const FOUR_GIB = 4 * 1024 ** 3;
/** `docker info --format '{{.MemTotal}}'` after `orb config set memory_mib 8192`. */
const ORBSTACK_8192_MIB_MEM_TOTAL = 8_393_289_728;

describe("smoke workers (workers.ts)", () => {
  it("givenWorkersEnv_whenResolved_thenUsedAsIs", () => {
    expect(resolveWorkers("5", FOUR_GIB).workers).toBe(5);
    expect(resolveWorkers("1", SMOKE_WORKERS_MIN_VM_BYTES).workers).toBe(1);
  });

  it("givenWorkersEnvNotAPositiveWholeNumber_whenResolved_thenThrowsNamingIt", () => {
    expect(() => resolveWorkers("0", undefined)).toThrow(WORKERS_ENV);
    expect(() => resolveWorkers("two", undefined)).toThrow(WORKERS_ENV);
  });

  it("givenVmBelowEightGib_whenResolved_thenOneWorkerAndHowToRaise", () => {
    const choice = resolveWorkers(undefined, FOUR_GIB);

    expect(choice.workers).toBe(1);
    expect(choice.reason).toContain("4.0 GiB");
    expect(choice.reason).toContain("orb config set memory_mib 8192");
    expect(choice.reason).toContain(WORKERS_ENV);
  });

  it("givenVmAtEightGib_whenResolved_thenThreeWorkers", () => {
    expect(resolveWorkers(undefined, SMOKE_WORKERS_MIN_VM_BYTES).workers).toBe(SMOKE_WORKERS_DEFAULT);
    expect(SMOKE_WORKERS_DEFAULT).toBe(3);
  });

  it("givenOrbStackSetToEightGib_whenResolved_thenThreeWorkers", () => {
    expect(resolveWorkers(undefined, ORBSTACK_8192_MIB_MEM_TOTAL).workers).toBe(SMOKE_WORKERS_DEFAULT);
  });

  it("givenVmSizeUnknown_whenResolved_thenOneWorker", () => {
    expect(resolveWorkers("", undefined).workers).toBe(1);
  });

  it("givenPoolIds_whenMappedToDisplays_thenOnePerWorkerWithinRange", () => {
    expect(["1", "2", "3"].map((id) => displayFor(id, 3))).toEqual([":1", ":2", ":3"]);
    expect(displayFor("4", 3)).toBe(":1");
    expect(displayFor(undefined, 3)).toBe(":1");
  });

  it("givenSerialList_whenChecked_thenEveryEntryExistsUnderTestE2eWithAReason", () => {
    const entries = Object.entries(SERIAL_SMOKE_FILES);

    expect(entries.length).toBeGreaterThan(0);
    for (const [file, reason] of entries) {
      expect(file).toMatch(/^test\/e2e\/[^/]+\.test\.ts$/);
      expect(existsSync(resolve(REPOSITORY_ROOT, file)), file).toBe(true);
      expect(reason.length, file).toBeGreaterThan(0);
    }
  });
});
