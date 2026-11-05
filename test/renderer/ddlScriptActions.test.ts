import { afterEach, describe, expect, it } from "vitest";
import type { Namespace, SchemaScript } from "@table-craft/desktop/engine/protocol.js";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  DDL_SCRIPT_ACTION_IDS,
  DDL_SCRIPT_ACTIONS,
  scriptScope,
} from "@table-craft/desktop/renderer/actions/ddlScriptActions.js";
import { namespaceKey, objectGroupKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  DDL_SCRIPT_HIDDEN_WHEN_DISABLED,
  NAMESPACE_MENU,
  SQL_SCRIPTS_MENU,
  shownEntries,
} from "@table-craft/desktop/renderer/panes/menuEntries.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { DISCONNECTED, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { LOADED_PG, PG_VIEW, PUBLIC_PATH } from "./catalogFixtures.js";
import { POSTGRES_PLUGIN } from "./datasourceViews.js";
import { IDLE_CONTEXT } from "./support.js";

const DDL_PLUGIN: PluginInfo = {
  ...POSTGRES_PLUGIN,
  capabilities: [...POSTGRES_PLUGIN.capabilities, "ddl", "currentNamespace"],
};
const HIDDEN = new Set(DDL_SCRIPT_HIDDEN_WHEN_DISABLED);
const SCRIPT: SchemaScript = { text: "CREATE TABLE customers (id integer);", relations: 1, failed: 0 };
const toConsole = DDL_SCRIPT_ACTIONS.find((action) => action.id === DDL_SCRIPT_ACTION_IDS.toConsole);
const originals = {
  open: useConsoles.getState().open,
  connect: useDatasources.getState().connect,
  ensureDescribed: useCatalog.getState().ensureDescribed,
};

function namespace(path: readonly string[], kind: Namespace["kind"]): Namespace {
  return { path, name: path.at(-1) ?? "", kind, system: false, current: false };
}

/** Stubs the engine with `targets` and the script, and answers what each opened console was given. */
function scriptingInto(targets: readonly Namespace[]): { sql: string | undefined; namespace: unknown }[] {
  const opened: { sql: string | undefined; namespace: unknown }[] = [];
  const answers: Readonly<Record<string, unknown>> = { "namespace.targets": targets, "catalog.script": SCRIPT };
  const client = { call: (method: string) => Promise.resolve(answers[method]) } as unknown as EngineClient;
  useDatasources.setState({
    datasources: [{ ...PG_VIEW, ephemeral: true }],
    connect: () => Promise.resolve(client),
  });
  useCatalog.setState({ ensureDescribed: () => Promise.resolve() });
  useConsoles.setState({
    open: (_id, _datasourceId, options) => {
      opened.push({ sql: options?.sql, namespace: options?.namespace ?? null });
      return Promise.resolve();
    },
  });
  return opened;
}

function given(plugin: PluginInfo): void {
  useDatasources.setState({ datasources: [PG_VIEW], plugins: [plugin] });
  useCatalog.setState({ catalogs: { pg: LOADED_PG } });
}

function selecting(path: readonly string[], key: string, plugin: PluginInfo = DDL_PLUGIN): ActionContext {
  return {
    ...IDLE_CONTEXT,
    focus: "database",
    inDatabasePane: true,
    datasources: [PG_VIEW],
    selection: { kind: "catalog", id: "pg", path, name: null, key },
    datasource: { view: PG_VIEW, connection: DISCONNECTED, capabilities: plugin.capabilities },
  };
}

/** The namespace menu as the Database pane shows it for `context`, every other item enabled. */
function menuFor(context: ActionContext) {
  return shownEntries(NAMESPACE_MENU, HIDDEN, (actionId) => {
    const action = DDL_SCRIPT_ACTIONS.find((candidate) => candidate.id === actionId);
    return action?.when?.(context) ?? true;
  });
}

afterEach(() => {
  useDatasources.setState({ datasources: [], plugins: [], connect: originals.connect });
  useCatalog.setState({ catalogs: {}, ensureDescribed: originals.ensureDescribed });
  useConsoles.setState({ open: originals.open });
  useTabs.setState(useTabs.getInitialState(), true);
});

describe("generate DDL actions", () => {
  it("givenNamespaceNode_whenMenuBuilt_thenSqlScriptsSubmenu", () => {
    given(DDL_PLUGIN);

    const menu = menuFor(selecting(PUBLIC_PATH, namespaceKey("pg", PUBLIC_PATH)));

    expect(menu).toContainEqual(SQL_SCRIPTS_MENU);
    expect(SQL_SCRIPTS_MENU.items).toEqual([
      DDL_SCRIPT_ACTION_IDS.toConsole,
      DDL_SCRIPT_ACTION_IDS.toClipboard,
      DDL_SCRIPT_ACTION_IDS.toFile,
    ]);
  });

  it("givenDatasourceWithoutDdl_whenMenuBuilt_thenSqlScriptsHidden", () => {
    given(POSTGRES_PLUGIN);

    const menu = menuFor(selecting(PUBLIC_PATH, namespaceKey("pg", PUBLIC_PATH), POSTGRES_PLUGIN));

    expect(
      menu.some((entry) => typeof entry === "object" && entry !== null && entry.label === SQL_SCRIPTS_MENU.label),
    ).toBe(false);
  });

  it("givenNamespaceNode_whenScoped_thenEveryRelationKind", () => {
    given(DDL_PLUGIN);

    const scope = scriptScope(selecting(PUBLIC_PATH, namespaceKey("pg", PUBLIC_PATH)));

    expect(scope).toEqual({
      datasourceId: "pg",
      title: "pg",
      path: PUBLIC_PATH,
      name: "public",
      kinds: ["table", "view", "materializedView"],
    });
  });

  it("givenUseSwitcher_whenScriptToConsoleOnSchema_thenConsoleOnItsDatabase", async () => {
    given(DDL_PLUGIN);
    const opened = scriptingInto([namespace(["table_craft"], "database")]);

    await toConsole?.run(selecting(PUBLIC_PATH, namespaceKey("pg", PUBLIC_PATH)), undefined as never);

    expect(opened).toEqual([{ sql: SCRIPT.text, namespace: ["table_craft"] }]);
  });

  it("givenPluginThatCannotSwitchNamespaces_whenScriptToConsole_thenConsoleOpensWithoutOne", async () => {
    const fixed: PluginInfo = {
      ...DDL_PLUGIN,
      capabilities: DDL_PLUGIN.capabilities.filter((capability) => capability !== "currentNamespace"),
    };
    given(fixed);
    const opened = scriptingInto([namespace(PUBLIC_PATH, "schema")]);

    await toConsole?.run(selecting(PUBLIC_PATH, namespaceKey("pg", PUBLIC_PATH), fixed), undefined as never);

    expect(opened).toEqual([{ sql: SCRIPT.text, namespace: null }]);
  });

  it("givenTablesGroupNode_whenScoped_thenTablesOnly", () => {
    given(DDL_PLUGIN);

    const scope = scriptScope(selecting(PUBLIC_PATH, objectGroupKey("pg", PUBLIC_PATH, "tables")));

    expect(scope?.kinds).toEqual(["table"]);
  });

  it("givenRoutinesGroupOrDatabaseNode_whenScoped_thenNothingToScript", () => {
    given(DDL_PLUGIN);

    expect(scriptScope(selecting(PUBLIC_PATH, objectGroupKey("pg", PUBLIC_PATH, "routines")))).toBeNull();
    expect(scriptScope(selecting(["table_craft"], namespaceKey("pg", ["table_craft"])))).toBeNull();
  });
});
