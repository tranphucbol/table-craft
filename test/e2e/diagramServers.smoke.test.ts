/**
 * Plan 152's live test on the servers: declared keys and a cross-schema ghost on Postgres, the theme
 * repainting the open diagram, export in Light and Dark, the undeclared `erd` schema inferred on
 * MySQL, and no diagram on Redis. Gated, because it needs a display, a fresh build and the servers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/152 bun run test:smoke:db:headless:all test/e2e/diagramServers.smoke.test.ts
 *
 * `diagram.smoke.test.ts` covers SQLite.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import mysql from "@table-craft/plugin-mysql";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MYSQL_ROOT_CONFIG,
  POSTGRES_CONFIG,
  REDIS_CONFIG,
  TIDB_SCRATCH_PREFIX,
  WITHOUT_POSTGRES,
  WITHOUT_REDIS,
} from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  paletteInput,
  paletteRows,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import {
  captureWindow,
  diagramEdges,
  ERD_TABLES_GROUP,
  exportBoth,
  INFERRED_EDGES,
  setTheme,
  showDiagram,
  treeRow,
} from "./diagramLive.js";
import { treeRow as keyTreeRow } from "./redisLive.js";

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const REDIS: Datasource = { id: "redis", pluginId: "redis", config: REDIS_CONFIG };
const PG_TABLES_GROUP = "tables 6";
const ARCHIVE = "archive";
const RANDOM_BYTES = 4;
/** On the local MySQL container only; the prefix keeps it recognisable as a run's own. */
const SCRATCH_DATABASE = `${TIDB_SCRATCH_PREFIX}152_${randomBytes(RANDOM_BYTES).toString("hex")}`;
const ERD_SCHEMA = new URL("../support/erd.sqlite.sql", import.meta.url);
/** The one column of the `erd` seed MySQL cannot index as SQLite's `TEXT` does. */
const UNIQUE_TEXT = "email TEXT NOT NULL UNIQUE";
const UNIQUE_VARCHAR = "email VARCHAR(255) NOT NULL UNIQUE";
const THEMES = [
  ["Dark", "08-postgres-dark"],
  ["Light", "08-postgres-light"],
  ["High contrast", "08-postgres-high-contrast"],
  ["Dracula Dark", "08-postgres-dracula-dark"],
] as const;

/** The `erd` seed's statements in MySQL's dialect, one `CREATE TABLE` each. */
function erdStatements(): readonly string[] {
  return readFileSync(ERD_SCHEMA, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .replace(UNIQUE_TEXT, UNIQUE_VARCHAR)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

async function asMysqlRoot(statements: readonly string[], database?: string): Promise<void> {
  const config = database === undefined ? MYSQL_ROOT_CONFIG : { ...MYSQL_ROOT_CONFIG, database };
  const session = await mysql.connect(config, { readOnly: false });
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const row of result.rows) void row;
    }
  } finally {
    await session.close();
  }
}

/**
 * The first table's computed background and the theme's current `--tc-panel` as the diagram's surface
 * resolves it, through a probe so both sides are computed colours. Evaluated as text, because the e2e program is compiled
 * without the DOM lib.
 */
const TABLE_IN_PANEL = `(() => {
  const table = document.querySelector('[data-testid="diagram-table"]');
  const surface = document.querySelector('[data-testid="diagram-canvas"]');
  if (table === null || surface === null) return null;
  const probe = document.createElement("div");
  probe.style.background = "var(--tc-panel)";
  surface.append(probe);
  const panel = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const painted = getComputedStyle(table).backgroundColor;
  return { panel, painted };
})()`;

function tablePaint(page: Page): Promise<{ readonly panel: string; readonly painted: string } | null> {
  return page.evaluate<{ panel: string; painted: string } | null>(TABLE_IN_PANEL);
}

describe.runIf(DATABASES_ENABLED)("ER diagram on the servers", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, tablesGroup: string | null): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    if (tablesGroup !== null) await treeRow(running.page, tablesGroup).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDeclaredKeys_whenShowDiagram_thenSolidEdgesAndACrossSchemaGhost",
    async () => {
      const page = await launch(POSTGRES, PG_TABLES_GROUP);

      await showDiagram(page, PG_TABLES_GROUP);
      await expect.poll(() => diagramEdges(page, "declared").count()).toBe(1);
      expect(await page.locator('[data-edge-id^="declared:orders:"]').count()).toBe(1);
      expect(await page.locator('[data-testid="diagram-table"][data-kind="external"]').count()).toBe(0);
      await captureWindow(page, "02-postgres-declared");

      await showDiagram(page, ARCHIVE);
      await expect.poll(() => diagramEdges(page, "declared").count()).toBe(1);
      const ghost = page.locator('[data-testid="diagram-table"][data-kind="external"]');
      await expect.poll(() => ghost.count()).toBe(1);
      expect(await ghost.textContent()).toContain("public.customers");
      await captureWindow(page, "02-postgres-archive-ghost");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDiagramOpen_whenThemeSwitched_thenItRepaintsInEachTheme",
    async () => {
      const page = await launch(POSTGRES, PG_TABLES_GROUP);
      await showDiagram(page, PG_TABLES_GROUP);
      await expect.poll(() => diagramEdges(page, "declared").count()).toBe(1);

      const painted = new Set<string>();
      for (const [theme, evidence] of THEMES) {
        await setTheme(page, theme);
        await expect
          .poll(async () => {
            const paint = await tablePaint(page);
            return paint !== null && paint.painted === paint.panel;
          })
          .toBe(true);
        painted.add((await tablePaint(page))?.painted ?? "");
        await captureWindow(page, evidence);
      }
      expect(painted.size).toBe(THEMES.length);
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresDiagramInLightThenDark_whenExported_thenEachFileIsInTheShownTheme",
    async () => {
      const page = await launch(POSTGRES, PG_TABLES_GROUP);
      if (running === null) throw new Error("The app is not running.");
      await showDiagram(page, PG_TABLES_GROUP);
      await expect.poll(() => diagramEdges(page, "declared").count()).toBe(1);

      for (const theme of ["Light", "Dark"] as const) {
        await setTheme(page, theme);
        await exportBoth(running.app, page, `06-postgres-${theme.toLowerCase()}`);
      }
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenUndeclaredMysqlSchema_whenShowDiagram_thenTheSameKeysAreInferred",
    async () => {
      await asMysqlRoot([`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`, `CREATE DATABASE ${SCRATCH_DATABASE}`]);
      try {
        await asMysqlRoot(erdStatements(), SCRATCH_DATABASE);
        const page = await launch(
          { id: "mysql-erd", pluginId: "mysql", config: { ...MYSQL_ROOT_CONFIG, database: SCRATCH_DATABASE } },
          ERD_TABLES_GROUP,
        );

        await showDiagram(page, ERD_TABLES_GROUP);
        await expect.poll(() => page.getByTestId("diagram-table").count()).toBe(8);
        await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(INFERRED_EDGES);
        expect(await diagramEdges(page, "declared").count()).toBe(0);
        await captureWindow(page, "03-mysql-inferred");
      } finally {
        await asMysqlRoot([`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`]);
      }
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedisDatasource_whenMenusAndPaletteListed_thenNoShowDiagram",
    async () => {
      const page = await launch(REDIS, null);
      const database = keyTreeRow(page, "keyDatabase", /^db0/).first();
      await database.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await database.click({ button: "right" });
      await page.getByRole("menuitem").first().waitFor();
      expect(await page.getByRole("menuitem", { name: "Diagrams" }).count()).toBe(0);
      expect(await page.getByRole("menuitem", { name: /Show Diagram/ }).count()).toBe(0);
      await page.keyboard.press("Escape");

      await database.click();
      await pressChord(page, "Shift+A");
      await paletteInput(page, "Find Action").fill("Diagram");
      await expect.poll(() => paletteRows(page).count()).toBeGreaterThan(0);
      expect(await paletteRows(page).filter({ hasText: "Show Diagram" }).count()).toBe(0);
      await captureWindow(page, "07-redis-no-diagram");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
