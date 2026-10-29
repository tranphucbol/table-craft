import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createLogger, enabled, serializeError, type LogRecord } from "@table-craft/desktop/log/record.js";
import { diagnosticsEntries, diagnosticsFileName } from "@table-craft/desktop/main/log/diagnostics.js";
import { createLogHub, LOG_RECORD_BYTES } from "@table-craft/desktop/main/log/hub.js";
import { readRecent } from "@table-craft/desktop/main/log/read.js";
import { createRedactor, REDACTED } from "@table-craft/desktop/main/log/redact.js";
import { createLogWriter, logFileNames, nodeLogFiles, type LogFiles } from "@table-craft/desktop/main/log/writer.js";
import { zip } from "@table-craft/desktop/main/log/zip.js";
import type { Datasource, PluginInfo } from "@table-craft/desktop/preload/bridge.js";

const NOW = new Date("2026-10-23T08:09:10.000Z");
const PASSWORD = "hunter2-secret";
/** Generous for a linear scan of a megabyte; a quadratic one takes minutes. */
const LINEAR_REDACTION_MS = 1_000;

function memoryFiles(): LogFiles & { readonly contents: Map<string, string>; failing: boolean } {
  const contents = new Map<string, string>();
  const files = {
    contents,
    failing: false,
    append: (path: string, text: string) => {
      if (files.failing) return Promise.reject(new Error("ENOSPC: no space left on device"));
      contents.set(path, (contents.get(path) ?? "") + text);
      return Promise.resolve();
    },
    size: (path: string) => {
      const text = contents.get(path);
      return Promise.resolve(text === undefined ? null : Buffer.byteLength(text));
    },
    rename: (from: string, to: string) => {
      contents.set(to, contents.get(from) ?? "");
      contents.delete(from);
      return Promise.resolve();
    },
    remove: (path: string) => {
      contents.delete(path);
      return Promise.resolve();
    },
    makeDirectory: () => Promise.resolve(),
  };
  return files;
}

function record(fields: Partial<LogRecord> = {}): LogRecord {
  return { ts: NOW.toISOString(), level: "info", process: "main", scope: "app", msg: "hello", ...fields };
}

describe("log records", () => {
  it("givenNestedCause_whenSerialized_thenCauseChainKept", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const outer = new Error("Could not connect", { cause: inner });

    const serialized = serializeError(outer);

    expect(serialized).toMatchObject({
      name: "Error",
      message: "Could not connect",
      cause: { message: "connect ECONNREFUSED", code: "ECONNREFUSED" },
    });
    expect(serialized.stack).toContain("Could not connect");
  });

  it("givenCauseCycle_whenSerialized_thenDepthBounded", () => {
    const error = new Error("loop");
    (error as { cause?: unknown }).cause = error;

    let depth = 0;
    for (let at = serializeError(error); at.cause !== undefined; at = at.cause) depth += 1;

    expect(depth).toBe(4);
  });

  it("givenLevels_whenCompared_thenOrderIsErrorWarnInfoDebug", () => {
    expect(enabled("warn", "info")).toBe(true);
    expect(enabled("debug", "info")).toBe(false);
    expect(enabled("debug", "debug")).toBe(true);
  });

  it("givenChildLogger_whenWriting_thenScopeFieldsAndErrMerged", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ process: "main", scope: "app", sink: (r) => records.push(r), now: () => NOW });

    logger.child("connection", { datasourceId: "pg" }).warn("connect failed", { err: new Error("no"), msg: "x" });

    expect(records[0]).toMatchObject({
      ts: NOW.toISOString(),
      level: "warn",
      process: "main",
      scope: "connection",
      msg: "connect failed",
      datasourceId: "pg",
      err: { message: "no" },
    });
  });
});

describe("log redaction", () => {
  it("givenPasswordField_whenRedacted_thenReplaced", () => {
    const redacted = createRedactor().record(
      record({
        config: { host: "db", password: PASSWORD, nested: [{ apiKey: "k-123456" }] },
        secretModes: { password: "forever" },
      }),
    );

    expect(redacted.config).toEqual({ host: "db", password: REDACTED, nested: [{ apiKey: REDACTED }] });
    expect(redacted.secretModes).toEqual({ password: REDACTED });
  });

  it("givenUrlWithUserinfo_whenRedacted_thenStripped", () => {
    expect(createRedactor().text("dial postgres://admin:pw@db:5432/app failed")).toBe(
      "dial postgres://db:5432/app failed",
    );
  });

  it("givenRememberedSecret_whenInsideMessageOrStack_thenReplaced", () => {
    const redactor = createRedactor();
    redactor.remember(PASSWORD);

    const redacted = redactor.record(
      record({ msg: `bad ${PASSWORD}`, err: { name: "Error", message: "x", stack: `at ${PASSWORD}` } }),
    );

    expect(JSON.stringify(redacted)).not.toContain(PASSWORD);
    expect(redacted.msg).toBe(`bad ${REDACTED}`);
  });

  it("givenLongLetterRun_whenRedacted_thenLinearTime", () => {
    const redactor = createRedactor();
    redactor.remember(PASSWORD);
    const long = `${"x".repeat(1_000_000)} postgres://user:${PASSWORD}@db/x`;

    const started = performance.now();
    const redacted = redactor.text(long);

    expect(performance.now() - started).toBeLessThan(LINEAR_REDACTION_MS);
    expect(redacted).not.toContain(PASSWORD);
    expect(redacted.endsWith("postgres://db/x")).toBe(true);
  });

  it("givenShortSecret_whenRemembered_thenIgnored", () => {
    const redactor = createRedactor();
    redactor.remember("a");

    expect(redactor.text("a table")).toBe("a table");
  });
});

describe("log writer", () => {
  it("givenFileAtLimit_whenAppended_thenRotated", async () => {
    const files = memoryFiles();
    const writer = createLogWriter({ directory: "/logs", files, maxBytes: 10, onFailure: () => {} });

    writer.append("123456789\n");
    writer.append("abc\n");
    await writer.drain();

    expect(files.contents.get("/logs/table-craft.log")).toBe("abc\n");
    expect(files.contents.get("/logs/table-craft.1.log")).toBe("123456789\n");
  });

  it("givenBurstOfRecords_whenAppended_thenCoalescedIntoFewWrites", async () => {
    const files = memoryFiles();
    let appends = 0;
    const counting = { ...files, append: (path: string, text: string) => ((appends += 1), files.append(path, text)) };
    const writer = createLogWriter({ directory: "/logs", files: counting, onFailure: () => {} });

    for (let index = 0; index < 1000; index += 1) writer.append(`${String(index)}\n`);
    await writer.drain();

    expect(appends).toBe(1);
    expect(files.contents.get("/logs/table-craft.log")?.split("\n")).toHaveLength(1001);
  });

  it("givenFourRotated_whenRotating_thenOldestDropped", async () => {
    const files = memoryFiles();
    const writer = createLogWriter({ directory: "/logs", files, maxBytes: 2, onFailure: () => {} });

    for (const line of ["1\n", "2\n", "3\n", "4\n", "5\n", "6\n"]) writer.append(line);
    await writer.drain();

    expect([...files.contents.keys()].sort()).toEqual(
      logFileNames()
        .map((name) => `/logs/${name}`)
        .sort(),
    );
    expect(files.contents.get("/logs/table-craft.log")).toBe("6\n");
    expect(files.contents.get("/logs/table-craft.4.log")).toBe("2\n");
  });

  it("givenWriteFails_whenAppending_thenDisabledOnce", async () => {
    const files = memoryFiles();
    files.failing = true;
    const failures: unknown[] = [];
    const writer = createLogWriter({ directory: "/logs", files, onFailure: (cause) => failures.push(cause) });

    writer.append("one\n");
    writer.append("two\n");
    await writer.drain();
    files.failing = false;
    writer.append("three\n");
    await writer.drain();

    expect(failures).toHaveLength(1);
    expect(files.contents.size).toBe(0);
  });

  it("givenRealDirectory_whenAppended_thenFileCreated", async () => {
    const directory = join(mkdtempSync(join(tmpdir(), "tc-log-")), "logs");
    const writer = createLogWriter({ directory, files: nodeLogFiles, onFailure: () => {} });

    writer.append("line\n");
    await writer.drain();

    expect(readFileSync(join(directory, "table-craft.log"), "utf8")).toBe("line\n");
  });
});

describe("log hub", () => {
  function hub(level: () => "info" | "debug" = () => "info") {
    const files = memoryFiles();
    const writer = createLogWriter({ directory: "/logs", files, onFailure: () => {} });
    const seen: LogRecord[] = [];
    const logHub = createLogHub({ writer, redactor: createRedactor(), level });
    logHub.subscribe((r) => seen.push(r));
    const lines = async () => {
      await writer.drain();
      return (files.contents.get("/logs/table-craft.log") ?? "").trim().split("\n").filter(Boolean);
    };
    return { logHub, seen, lines };
  }

  it("givenInfoLevel_whenDebugRecord_thenDropped", async () => {
    const { logHub, lines } = hub();

    logHub.write(record({ level: "debug" }));
    logHub.write(record({ level: "warn" }));

    expect(await lines()).toHaveLength(1);
  });

  it("givenLevelChanged_whenDebugRecord_thenWritten", async () => {
    let level: "info" | "debug" = "info";
    const { logHub, lines, seen } = hub(() => level);

    logHub.write(record({ level: "debug" }));
    level = "debug";
    logHub.write(record({ level: "debug", msg: "kept" }));

    expect((await lines()).map((line) => (JSON.parse(line) as LogRecord).msg)).toEqual(["kept"]);
    expect(seen.map((r) => r.msg)).toEqual(["kept"]);
  });

  it("givenOversizedRecord_whenWritten_thenCappedAndMarked", async () => {
    const { logHub, lines } = hub();

    logHub.write(record({ msg: "x".repeat(LOG_RECORD_BYTES * 2), extra: "y".repeat(LOG_RECORD_BYTES) }));

    const [line] = await lines();
    expect(Buffer.byteLength(line ?? "")).toBeLessThanOrEqual(LOG_RECORD_BYTES);
    expect(JSON.parse(line ?? "{}")).toMatchObject({ truncated: true, scope: "app" });
  });

  it("givenRotatedFiles_whenReadRecent_thenNewestFirst", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tc-log-"));
    const paths = logFileNames().map((name) => join(directory, name));
    writeFileSync(
      paths[1] as string,
      `${JSON.stringify(record({ msg: "a" }))}\n${JSON.stringify(record({ msg: "b" }))}\n`,
    );
    writeFileSync(paths[0] as string, `not json\n${JSON.stringify(record({ msg: "c" }))}\n`);

    expect((await readRecent(paths, 10)).map((r) => r.msg)).toEqual(["c", "b", "a"]);
    expect((await readRecent(paths, 2)).map((r) => r.msg)).toEqual(["c", "b"]);
  });
});

function unzipEntries(archive: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(archive);
  const entries = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength;
    const body = buffer.subarray(start, start + compressed);
    entries.set(name, (method === 8 ? inflateRawSync(body) : body).toString("utf8"));
    offset = start + compressed;
  }
  return entries;
}

describe("zip writer", () => {
  const entries = [
    { name: "logs/table-craft.log", data: new TextEncoder().encode("line\n".repeat(1000)) },
    { name: "about.json", data: new TextEncoder().encode("{}") },
  ];

  it("givenEntries_whenZipped_thenInflateRoundTrips", () => {
    const unzipped = unzipEntries(zip(entries, NOW));

    expect(unzipped.get("logs/table-craft.log")).toBe("line\n".repeat(1000));
    expect(unzipped.get("about.json")).toBe("{}");
  });

  it("givenZip_whenUnzipT_thenValid", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tc-zip-")), "d.zip");
    writeFileSync(path, zip(entries, NOW));
    let output: string;
    try {
      output = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    expect(output).toContain("No errors detected");
    expect(readdirSync(join(path, ".."))).toContain("d.zip");
  });
});

describe("diagnostics", () => {
  const plugin: PluginInfo = {
    id: "postgres",
    name: "PostgreSQL",
    source: "managed",
    version: "1.0.0",
    unavailableReason: null,
    capabilities: [],
    highlight: "postgresql",
    brands: [{ id: "postgresql", name: "PostgreSQL" }],
    url: null,
    network: null,
    tls: null,
    fields: [
      { key: "host", label: "Host", kind: "text" },
      { key: "password", label: "Password", kind: "password", secret: true },
    ],
  };
  const datasource: Datasource = {
    id: "pg",
    name: "Main",
    pluginId: "postgres",
    folder: null,
    color: null,
    readOnly: false,
    comment: "",
    config: { host: "db", password: PASSWORD },
    secretModes: { password: "forever" },
  };

  it("givenDatasources_whenDiagnostics_thenNoSecretAnywhere", () => {
    const redactor = createRedactor();
    redactor.remember(PASSWORD);
    const entries = diagnosticsEntries({
      logs: [{ name: "table-craft.log", text: `${JSON.stringify(record({ msg: `oops ${PASSWORD}` }))}\n` }],
      about: { version: "1.0.0" },
      settings: '{"version":1}',
      datasources: [datasource],
      plugins: [plugin],
      runs: [
        {
          datasourceId: "pg",
          startedAt: 0,
          durationMs: 3,
          outcome: "error",
          rowCount: null,
          source: "console",
          warnings: null,
        },
      ],
      redactor,
    });

    const unzipped = unzipEntries(zip(entries, NOW));
    expect([...unzipped.keys()]).toEqual([
      "logs/table-craft.log",
      "about.json",
      "settings.json",
      "datasources.json",
      "history.json",
    ]);
    for (const text of unzipped.values()) expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(unzipped.get("datasources.json") ?? "{}")).toMatchObject({
      datasources: [{ id: "pg", config: { host: "db" }, secretModes: { password: "forever" } }],
    });
    expect(JSON.parse(unzipped.get("history.json") ?? "{}")).toEqual({
      runs: [
        {
          datasourceId: "pg",
          startedAt: "1970-01-01T00:00:00.000Z",
          durationMs: 3,
          outcome: "error",
          rowCount: null,
          source: "console",
          warnings: null,
        },
      ],
    });
  });

  it("givenDate_whenNamed_thenLocalTimestamp", () => {
    expect(diagnosticsFileName(new Date(2026, 9, 3, 4, 5, 6))).toBe("table-craft-diagnostics-20261003-040506.zip");
  });
});
