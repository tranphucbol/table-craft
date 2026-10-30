/**
 * When compaction has reached a key's current version, History still shows that version and says
 * once, below the list, that older ones were compacted. It compacts the `etcd-tls` server, which no
 * history scenario reads, so the `etcd` servers keep their full history:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/remember-prompted-secrets bun run test:smoke:db:headless:etcd test/e2e/etcdHistoryCompaction.smoke.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ETCD_TLS_CONFIG, WITHOUT_ETCD } from "../support/databases.js";
import {
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  waitUntilReady,
} from "./harness.js";
import { attributes, keyButton, keyTab, openKey } from "./redisLive.js";

const captureWindow = evidenceFor("remember-prompted-secrets");
const CONNECT_TIMEOUT_MS = 5_000;
const VALUES = ["first", "second", "current"] as const;
const CURRENT_VERSION = VALUES.length;

interface EtcdWrite {
  readonly header: { readonly revision: string };
}

interface EtcdConnection {
  readonly kv: {
    put(request: { key: Buffer; value: Buffer }): Promise<EtcdWrite>;
    deleteRange(request: { key: Buffer }): Promise<EtcdWrite>;
    compact(request: { revision: string; physical: boolean }): Promise<unknown>;
  };
  close(): void;
}

const etcd = createRequire(new URL("../../plugins/etcd/package.json", import.meta.url))("etcd3") as {
  Etcd3: new (options: Record<string, unknown>) => EtcdConnection;
};

function connectTls(): EtcdConnection {
  return new etcd.Etcd3({
    hosts: [`https://${ETCD_TLS_CONFIG.host}:${String(ETCD_TLS_CONFIG.port)}`],
    credentials: {
      rootCertificate: readFileSync(ETCD_TLS_CONFIG.tlsCa),
      certChain: readFileSync(ETCD_TLS_CONFIG.tlsCert),
      privateKey: readFileSync(ETCD_TLS_CONFIG.tlsKey),
    },
    dialTimeout: CONNECT_TIMEOUT_MS,
  });
}

describe.runIf(DATABASES_ENABLED && !WITHOUT_ETCD)("etcd History after compaction", () => {
  it(
    "givenCompactionPastCurrentVersion_whenHistoryOpened_thenCurrentVersionAndOneCompactionLine",
    async () => {
      const key = `/live/etcd-compaction/${randomUUID()}`;
      const advance = `${key}/advance`;
      const connection = connectTls();
      try {
        for (const value of VALUES) await connection.kv.put({ key: Buffer.from(key), value: Buffer.from(value) });
        const through = (await connection.kv.put({ key: Buffer.from(advance), value: Buffer.from("1") })).header
          .revision;
        await connection.kv.compact({ revision: through, physical: true });

        const running = await launchApp({ id: "etcd-compacted", pluginId: "etcd", config: ETCD_TLS_CONFIG });
        try {
          const { page } = running;
          await setWindowSize(running.app, EVIDENCE_WINDOW);
          await waitUntilReady(page);
          await openKey(page, key);
          await keyButton(page, "History").click();
          const history = keyTab(page).getByTestId("key-history");
          const versions = history.getByRole("complementary", { name: "Key versions" }).locator("button[aria-pressed]");

          await expect.poll(() => versions.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);
          expect(await attributes(versions, "title")).toEqual([
            expect.stringMatching(new RegExp(`^PUT · v${String(CURRENT_VERSION)} · rev \\d+ · lease 0$`)),
          ]);
          expect(await history.getByTestId("key-history-footer").textContent()).toBe(
            `Older versions were removed by etcd compaction (through rev ${through}).`,
          );
          await history.getByRole("button", { name: "About compaction", exact: true }).hover();
          await expect
            .poll(() => page.getByRole("tooltip").textContent())
            .toContain("compacted versions cannot be recovered");
          await captureWindow(page, "09-etcd-history-current-version-after-compaction");
        } finally {
          await closeApp(running.app);
        }
      } finally {
        try {
          await connection.kv.deleteRange({ key: Buffer.from(key) });
          await connection.kv.deleteRange({ key: Buffer.from(advance) });
        } finally {
          connection.close();
        }
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
