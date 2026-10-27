import etcd from "@table-craft/plugin-etcd";
import type { KeyName, Session } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { describe, expect, it } from "vitest";
import {
  databaseEnabled,
  ETCD35_CONFIG,
  ETCD_CONFIG,
  ETCD_LIMITED_USER,
  withWrongPassword,
} from "../support/databases.js";
import { ETCD_COMMANDS, ETCD_KEYSPACE } from "../support/etcdFixture.js";
import { ETCD_MANIFEST } from "../support/manifests.js";

const DATABASE = 0;
const READ_WINDOW = 100;
const EXPIRY_MS = 60_000;
const RENAMED_FROM = text("/contract/rename/from");
const RENAMED_TO = text("/contract/rename/to");
const SCRATCH = text("/contract/scratch");
const BOM_KEY = text("\uFEFF/contract/bom");
const BOM_VALUE = "\uFEFFvalue";
const SCAN_BATCH = 7;

function text(value: string): KeyName {
  return { text: value, hex: null };
}

function keyspaceOf(session: Session) {
  if (session.keyspace === undefined) throw new Error("no keyspace");
  return session.keyspace;
}

async function withEtcd(config: unknown, use: (session: Session) => Promise<void>, readOnly = false): Promise<void> {
  const session = await etcd.connect(etcd.connectionSchema.parse(config), { readOnly });
  try {
    await use(session);
  } finally {
    await session.close();
  }
}

async function rejectionCode(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => null,
    (error: unknown) => (error as { code?: unknown }).code ?? error,
  );
}

/** Every key a glob matches, read batch by batch to the end of the pass. */
async function scanAll(session: Session, match: string): Promise<KeyName[]> {
  const keys: KeyName[] = [];
  let cursor: string | null = null;
  do {
    const scan = await keyspaceOf(session).scan({ database: DATABASE, cursor, match, type: null, count: SCAN_BATCH });
    keys.push(...scan.keys);
    cursor = scan.cursor;
  } while (cursor !== null);
  return keys;
}

async function rowsOf(session: Session, command: string): Promise<unknown[]> {
  const result = await session.execute(command);
  const rows: unknown[] = [];
  for await (const row of result.rows) rows.push(row);
  return rows;
}

async function valueOf(session: Session, key: KeyName): Promise<unknown> {
  return (await keyspaceOf(session).read(DATABASE, key, { window: READ_WINDOW })).value;
}

async function put(session: Session, key: KeyName, value: string, original: string | null, guard: boolean) {
  return keyspaceOf(session).apply(
    DATABASE,
    key,
    [{ kind: "setString", value: text(value), original: original === null ? null : text(original) }],
    { type: "string", guard },
  );
}

const SERVERS = [
  { version: "3.6", config: ETCD_CONFIG, auth: true },
  { version: "3.5", config: ETCD35_CONFIG, auth: false },
] as const;

describe.runIf(databaseEnabled("etcd")).each(SERVERS)("etcd $version server", ({ config, auth }) => {
  runPluginContract(etcd, {
    manifest: ETCD_MANIFEST,
    config,
    ...(auth ? { wrongPasswordConfig: withWrongPassword(config) } : {}),
    commands: ETCD_COMMANDS,
    keyspace: ETCD_KEYSPACE,
  });

  describe("keyspace", () => {
    it("givenKeyChangedSinceRead_whenGuardedSave_thenConflictAndValueKept", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await keyspace.remove(DATABASE, [SCRATCH]);
        try {
          await put(session, SCRATCH, "read", null, true);
          await put(session, SCRATCH, "theirs", "read", false);
          expect(await rejectionCode(put(session, SCRATCH, "mine", "read", true))).toBe("conflict");
          expect(await valueOf(session, SCRATCH)).toBe("theirs");
        } finally {
          await keyspace.remove(DATABASE, [SCRATCH]);
        }
      });
    });

    it("givenKey_whenRenamed_thenValueMovesAndOldKeyGone", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await keyspace.remove(DATABASE, [RENAMED_FROM, RENAMED_TO]);
        try {
          await put(session, RENAMED_FROM, "moving", null, true);
          await keyspace.rename(DATABASE, RENAMED_FROM, RENAMED_TO, false);
          expect(await valueOf(session, RENAMED_TO)).toBe("moving");
          const [from] = await keyspace.describe(DATABASE, [RENAMED_FROM]);
          expect(from?.type).toBeNull();
        } finally {
          await keyspace.remove(DATABASE, [RENAMED_FROM, RENAMED_TO]);
        }
      });
    });

    it("givenTargetExists_whenRenamedWithoutOverwrite_thenRefusedAndBothKept", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await keyspace.remove(DATABASE, [RENAMED_FROM, RENAMED_TO]);
        try {
          await put(session, RENAMED_FROM, "from", null, true);
          await put(session, RENAMED_TO, "to", null, true);
          expect(await rejectionCode(keyspace.rename(DATABASE, RENAMED_FROM, RENAMED_TO, false))).toBe(
            "statementFailed",
          );
          expect([await valueOf(session, RENAMED_FROM), await valueOf(session, RENAMED_TO)]).toEqual(["from", "to"]);
        } finally {
          await keyspace.remove(DATABASE, [RENAMED_FROM, RENAMED_TO]);
        }
      });
    });

    it("givenKey_whenExpireSetThenCleared_thenTtlFollowsAndValueKept", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await keyspace.remove(DATABASE, [SCRATCH]);
        try {
          await put(session, SCRATCH, "lasting", null, true);
          await keyspace.expire(DATABASE, SCRATCH, { inMs: EXPIRY_MS });
          const [leased] = await keyspace.describe(DATABASE, [SCRATCH]);
          expect(leased?.ttlMs).toBeGreaterThan(0);
          expect(leased?.ttlMs).toBeLessThanOrEqual(EXPIRY_MS);

          await keyspace.expire(DATABASE, SCRATCH, null);
          const [persistent] = await keyspace.describe(DATABASE, [SCRATCH]);
          expect(persistent?.ttlMs).toBeNull();
          expect(await valueOf(session, SCRATCH)).toBe("lasting");
        } finally {
          await keyspace.remove(DATABASE, [SCRATCH]);
        }
      });
    });

    it("givenLeasedKey_whenSaved_thenKeepsItsLease", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await keyspace.remove(DATABASE, [SCRATCH]);
        try {
          await put(session, SCRATCH, "one", null, true);
          await keyspace.expire(DATABASE, SCRATCH, { inMs: EXPIRY_MS });
          await put(session, SCRATCH, "two", "one", true);
          const [info] = await keyspace.describe(DATABASE, [SCRATCH]);
          expect(info?.ttlMs).toBeGreaterThan(0);
        } finally {
          await keyspace.remove(DATABASE, [SCRATCH]);
        }
      });
    });

    it("givenSeededJson_whenRead_thenValueAndRevisionAttributes", async () => {
      await withEtcd(config, async (session) => {
        const contents = await keyspaceOf(session).read(DATABASE, text("/app/config/db.json"), {
          window: READ_WINDOW,
        });
        expect(contents.details).toMatchObject({ type: "string", typeName: "string", ttlMs: null });
        expect(typeof contents.value).toBe("string");
        expect(JSON.parse(typeof contents.value === "string" ? contents.value : "null")).toMatchObject({
          host: "db.internal",
          port: 5432,
        });
        const names = (contents.details.attributes ?? []).map((attribute) => attribute.name);
        expect(names).toEqual(expect.arrayContaining(["create_revision", "mod_revision", "version", "lease"]));
      });
    });

    it("givenGlobWithoutLiteralPrefix_whenScannedToTheEnd_thenEveryMatchingKey", async () => {
      await withEtcd(config, async (session) => {
        const names = (await scanAll(session, "*")).map((key) => key.text);
        expect(names).toEqual(expect.arrayContaining(["/app/config/db.json", "/app/feature/flags", "/bulk/key-30"]));
        expect((await scanAll(session, "?app/config/*")).map((key) => key.text)).toEqual(
          expect.arrayContaining(["/app/config/db.json", "/app/config/app.properties"]),
        );
        expect((await scanAll(session, "[/]bulk/key-0[1-3]")).map((key) => key.text).sort()).toEqual([
          "/bulk/key-01",
          "/bulk/key-02",
          "/bulk/key-03",
        ]);
      });
    });

    it("givenEmptyKeyRangeInConsole_whenRun_thenWholeKeyspaceRead", async () => {
      await withEtcd(config, async (session) => {
        const counted = await session.execute('get "" --prefix --count-only');
        expect(Number(counted.reply?.value)).toBeGreaterThan(0);
        expect(await rowsOf(session, 'get "" --from-key --keys-only --limit=1')).toHaveLength(1);
        const suggested = await (session as unknown as { suggestKeys(prefix: string): Promise<string[]> }).suggestKeys(
          "",
        );
        expect(suggested.length).toBeGreaterThan(0);
      });
    });

    it("givenKeyAndValueStartingWithBom_whenScannedSavedAndRemoved_thenSameKeyThroughout", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await keyspace.remove(DATABASE, [BOM_KEY]);
        try {
          await put(session, BOM_KEY, BOM_VALUE, null, true);
          const [scanned] = await scanAll(session, BOM_KEY.text);
          expect(scanned).toEqual(BOM_KEY);
          const key = scanned ?? BOM_KEY;
          expect(await valueOf(session, key)).toBe(BOM_VALUE);
          await put(session, key, "saved", BOM_VALUE, true);
          expect(await valueOf(session, key)).toBe("saved");
          expect(await keyspace.remove(DATABASE, [key])).toBe(1);
        } finally {
          await keyspace.remove(DATABASE, [BOM_KEY]);
        }
      });
    });

    it("givenSameKeyTwice_whenRemoved_thenRemovedOnce", async () => {
      await withEtcd(config, async (session) => {
        await put(session, SCRATCH, "twice", null, false);
        expect(await keyspaceOf(session).remove(DATABASE, [SCRATCH, SCRATCH])).toBe(1);
      });
    });

    it("givenExpiryAlreadyPast_whenSet_thenKeyDeletedAndMissingKeyRefused", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await put(session, SCRATCH, "short", null, false);
        await keyspace.expire(DATABASE, SCRATCH, { at: new Date(Date.now() - EXPIRY_MS).toISOString() });
        const [gone] = await keyspace.describe(DATABASE, [SCRATCH]);
        expect(gone?.type).toBeNull();
        expect(await rejectionCode(keyspace.expire(DATABASE, SCRATCH, { inMs: 0 }))).toBe("statementFailed");
      });
    });

    it("givenSameName_whenRenamed_thenRefusedAndKeyKept", async () => {
      await withEtcd(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await put(session, SCRATCH, "kept", null, false);
        try {
          await expect(keyspace.rename(DATABASE, SCRATCH, SCRATCH, true)).rejects.toThrow(/already has that name/);
          expect(await valueOf(session, SCRATCH)).toBe("kept");
        } finally {
          await keyspace.remove(DATABASE, [SCRATCH]);
        }
      });
    });

    it("givenReadOnly_whenKeyspaceChanges_thenRefusedAndNothingWritten", async () => {
      await withEtcd(
        config,
        async (session) => {
          const keyspace = keyspaceOf(session);
          const key = text("/probe/string");
          const refused = /read-only datasource refuses \w+/;
          await expect(put(session, key, "x", "hello", false)).rejects.toThrow(refused);
          await expect(keyspace.rename(DATABASE, key, text("/probe/renamed"), false)).rejects.toThrow(refused);
          await expect(keyspace.expire(DATABASE, key, { inMs: EXPIRY_MS })).rejects.toThrow(refused);
          await expect(keyspace.remove(DATABASE, [key])).rejects.toThrow(refused);
          expect(await valueOf(session, key)).toBe("hello");
        },
        true,
      );
    });
  });
});

describe.runIf(databaseEnabled("etcd"))("etcd 3.6 limited user", () => {
  const limited = { ...ETCD_CONFIG, ...ETCD_LIMITED_USER };

  it("givenReadOnAppPrefix_whenReadingUnderApp_thenValueRead", async () => {
    await withEtcd(limited, async (session) => {
      expect(await valueOf(session, text("/app/feature/flags"))).toBe("dark-mode,beta-search");
    });
  });

  it("givenReadOnAppPrefix_whenReadingOutsideApp_thenRefused", async () => {
    await withEtcd(limited, async (session) => {
      const read = keyspaceOf(session).read(DATABASE, text("/registry/pods/default/web-0"), { window: READ_WINDOW });
      await expect(read).rejects.toThrow(/permission denied/i);
    });
  });

  it("givenReadOnAppPrefix_whenDatabasesListed_thenTreeOpensWithoutACount", async () => {
    await withEtcd(limited, async (session) => {
      expect(await keyspaceOf(session).databases()).toEqual([{ index: DATABASE, keys: 0, expires: 0, current: true }]);
    });
  });

  it("givenReadOnAppPrefix_whenScanningEverything_thenRefusedNamingAPrefixFilter", async () => {
    await withEtcd(limited, async (session) => {
      const scan = keyspaceOf(session).scan({ database: DATABASE, cursor: null, match: "*", type: null });
      await expect(scan).rejects.toThrow(/Filter the keys by a prefix its role can read/);
      expect(await rejectionCode(scan)).toBe("statementFailed");
      expect((await scanAll(session, "/app/*")).map((key) => key.text)).toContain("/app/feature/flags");
    });
  });

  it("givenReadOnAppPrefix_whenWritingUnderApp_thenRefused", async () => {
    await withEtcd(limited, async (session) => {
      await expect(put(session, text("/app/feature/flags"), "x", "dark-mode,beta-search", true)).rejects.toThrow(
        /permission denied/i,
      );
      expect(await valueOf(session, text("/app/feature/flags"))).toBe("dark-mode,beta-search");
    });
  });
});
