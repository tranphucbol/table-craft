import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PluginError } from "@table-craft/plugin-api";
import { dataFileView } from "@table-craft/plugin-duckdb/dataFiles";
import { connectFailure, VC_REDIST_MESSAGE } from "@table-craft/plugin-duckdb/failures";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_ROWS, seededDuckdbFiles, type DuckdbFixtureFiles } from "../support/duckdbFixture.js";
import { openDuckdb, rowsOf } from "../support/duckdbSession.js";

describe("DuckDB data files", () => {
  let files: DuckdbFixtureFiles;

  beforeAll(async () => {
    files = await seededDuckdbFiles();
  });

  it("givenParquetPath_whenConnect_thenViewNamedAfterStem", async () => {
    const session = await openDuckdb(files.parquet);
    try {
      const rows = await rowsOf(session, "SELECT count(*) > 0 AS any FROM orders");

      expect(rows).toEqual([[true]]);
    } finally {
      await session.close();
    }
  });

  it("givenCsvZstPath_whenConnect_thenRowsReadThroughZstd", async () => {
    const session = await openDuckdb(files.csvZst);
    try {
      const rows = await rowsOf(session, "SELECT count(*) AS n, max(name) AS last FROM events");

      expect(rows).toEqual([[EVENT_ROWS, "event 999"]]);
    } finally {
      await session.close();
    }
  });

  it("givenGlobPath_whenConnect_thenViewNamedData", async () => {
    const folder = join(files.directory, "parts");
    mkdirSync(folder, { recursive: true });
    copyFileSync(files.parquet, join(folder, "a.parquet"));
    copyFileSync(files.parquet, join(folder, "b.parquet"));
    const single = await openDuckdb(files.parquet);
    const glob = await openDuckdb(join(folder, "*.parquet"));
    try {
      const [[one]] = (await rowsOf(single, "SELECT count(*) FROM orders")) as [[number]];
      const rows = await rowsOf(glob, "SELECT count(*) FROM data");

      expect(rows).toEqual([[one * 2]]);
    } finally {
      await single.close();
      await glob.close();
    }
  });

  it("givenMissingParquet_whenConnect_thenConnectionFailedWithIoMessage", async () => {
    const failure = await openDuckdb(join(files.directory, "missing.parquet")).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PluginError);
    expect(failure).toMatchObject({ code: "connectionFailed" });
    expect((failure as Error).message).toMatch(/missing\.parquet/u);
  });

  it("givenDataFile_whenConnect_thenPrivateDatabase", async () => {
    const parquet = await openDuckdb(files.parquet);
    const database = await openDuckdb(files.database);
    try {
      expect(parquet.privateDatabase).toBe(true);
      expect(database.privateDatabase ?? false).toBe(false);
    } finally {
      await parquet.close();
      await database.close();
    }
  });

  it("givenCompressedAndPlainNames_whenDataFileView_thenStemWithoutEverySuffix", () => {
    expect(dataFileView("/data/events.csv.zst")?.view).toBe("events");
    expect(dataFileView("C:\\data\\Orders 2026.parquet")?.view).toBe("Orders 2026");
    expect(dataFileView("/data/shop.duckdb")).toBeNull();
  });

  it("givenWindowsWithoutTheRuntime_whenConnectFails_thenSaysToInstallIt", () => {
    const failure = connectFailure(
      new Error("The specified module could not be found.\r\n\\?\\duckdb.node"),
      "a.duckdb",
      "win32",
    );

    expect(failure.message).toBe(VC_REDIST_MESSAGE);
  });
});
