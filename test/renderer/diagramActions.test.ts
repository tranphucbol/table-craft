import { afterEach, describe, expect, it } from "vitest";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  DIAGRAM_ACTION_IDS,
  DIAGRAM_ACTIONS,
  diagramScope,
} from "@table-craft/desktop/renderer/actions/diagramActions.js";
import { namespaceKey, objectGroupKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { DISCONNECTED, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { LOADED_PG, PG_VIEW, PUBLIC_PATH } from "./catalogFixtures.js";
import { POSTGRES_PLUGIN, REDIS_PLUGIN } from "./datasourceViews.js";
import { IDLE_CONTEXT } from "./support.js";

const SHOW = DIAGRAM_ACTIONS.find((action) => action.id === DIAGRAM_ACTION_IDS.show);

function given(plugin: PluginInfo): void {
  useDatasources.setState({ datasources: [PG_VIEW], plugins: [{ ...plugin, id: PG_VIEW.pluginId }] });
  useCatalog.setState({ catalogs: { pg: LOADED_PG } });
}

function selecting(key: string, plugin: PluginInfo): ActionContext {
  return {
    ...IDLE_CONTEXT,
    focus: "database",
    inDatabasePane: true,
    datasources: [PG_VIEW],
    selection: { kind: "catalog", id: "pg", path: PUBLIC_PATH, name: null, key },
    datasource: { view: PG_VIEW, connection: DISCONNECTED, capabilities: plugin.capabilities },
  };
}

afterEach(() => {
  useDatasources.setState({ datasources: [], plugins: [] });
  useCatalog.setState({ catalogs: {} });
});

describe("diagram actions", () => {
  it.each([
    ["schema", namespaceKey("pg", PUBLIC_PATH)],
    ["Tables group", objectGroupKey("pg", PUBLIC_PATH, "tables")],
  ])("givenSchemaTreeDatasource_whenItsShownOnThe%sNode_thenShowDiagramScopesTheSchema", (_node, key) => {
    given(POSTGRES_PLUGIN);
    const context = selecting(key, POSTGRES_PLUGIN);

    expect(SHOW?.available?.(context)).toBe(true);
    expect(diagramScope(context)).toEqual({ datasourceId: "pg", path: PUBLIC_PATH, namespace: "public" });
  });

  it("givenDatasourceWithoutSchemaTree_whenActionsListed_thenNoDiagramActionAvailable", () => {
    given(REDIS_PLUGIN);
    const context = selecting(namespaceKey("pg", PUBLIC_PATH), REDIS_PLUGIN);

    expect(SHOW?.available?.(context)).toBe(false);
    expect(DIAGRAM_ACTIONS.filter((action) => action.available?.(context) !== false)).toEqual([]);
    expect(diagramScope(context)).toBeNull();
  });
});
