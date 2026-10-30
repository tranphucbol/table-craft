import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDdl } from "@table-craft/desktop/renderer/state/ddl.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useKeyTabs } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { useServer } from "@table-craft/desktop/renderer/state/server.js";
import { useSessions } from "@table-craft/desktop/renderer/state/sessions.js";
import { useTables } from "@table-craft/desktop/renderer/state/tables.js";

/** The datasource a console, table, DDL or Sessions tab works on; undefined once it is deleted, until its tab closes. */
export function useConsoleDatasource(tabId: string): DatasourceView | undefined {
  const consoleDatasource = useConsoles((state) => state.consoles[tabId]?.datasourceId);
  const tableDatasource = useTables((state) => state.tables[tabId]?.datasourceId);
  const ddlDatasource = useDdl((state) => state.ddls[tabId]?.datasourceId);
  const sessionsDatasource = useSessions((state) => state.tabs[tabId]?.datasourceId);
  const keyDatasource = useKeyTabs((state) => state.tabs[tabId]?.datasourceId);
  const serverDatasource = useServer((state) => state.tabs[tabId]?.datasourceId);
  const adminDatasource = useKeyAdmin((state) => state.tabs[tabId]?.datasourceId);
  return useDatasources((state) =>
    datasourceById(
      state,
      consoleDatasource ??
        tableDatasource ??
        ddlDatasource ??
        sessionsDatasource ??
        keyDatasource ??
        serverDatasource ??
        adminDatasource,
    ),
  );
}
