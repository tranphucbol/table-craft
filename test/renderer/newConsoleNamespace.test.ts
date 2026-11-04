import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { ACTION_IDS, APP_ACTIONS } from "@table-craft/desktop/renderer/actions/appActions.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { relationKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useConsoles, type OpenOptions } from "@table-craft/desktop/renderer/state/consoles.js";
import { DISCONNECTED, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { PG_NAMESPACES, PG_VIEW, PUBLIC_PATH } from "./catalogFixtures.js";
import { POSTGRES_PLUGIN } from "./datasourceViews.js";
import { IDLE_CONTEXT } from "./support.js";

const SWITCHING_PLUGIN: PluginInfo = {
  ...POSTGRES_PLUGIN,
  capabilities: [...POSTGRES_PLUGIN.capabilities, "currentNamespace"],
};
const VIEW = { ...PG_VIEW, ephemeral: true };
const TARGETS: readonly Namespace[] = PG_NAMESPACES.filter((namespace) => namespace.kind === "schema");

const newConsole = APP_ACTIONS.find((action) => action.id === ACTION_IDS.newConsole);
const originalOpen = useConsoles.getState().open;
const originalConnect = useDatasources.getState().connect;
let opened: { datasourceId: string; options: OpenOptions | undefined }[] = [];
let call: ReturnType<typeof vi.fn>;

function given(
  plugin: PluginInfo,
  targets: () => Promise<readonly Namespace[]> = () => Promise.resolve(TARGETS),
): void {
  call = vi.fn((method: string) => (method === "namespace.targets" ? targets() : Promise.reject(new Error(method))));
  const client = { call } as unknown as EngineClient;
  useDatasources.setState({ datasources: [VIEW], plugins: [plugin], connect: () => Promise.resolve(client) });
}

function context(overrides: Partial<ActionContext>, plugin: PluginInfo = SWITCHING_PLUGIN): ActionContext {
  return {
    ...IDLE_CONTEXT,
    focus: "database",
    inDatabasePane: true,
    datasources: [VIEW],
    datasource: { view: VIEW, connection: DISCONNECTED, capabilities: plugin.capabilities },
    ...overrides,
  };
}

const ON_TABLE: Partial<ActionContext> = {
  selection: {
    kind: "catalog",
    id: "pg",
    path: PUBLIC_PATH,
    name: "customers",
    key: relationKey("pg", PUBLIC_PATH, "customers"),
  },
};

async function run(on: ActionContext): Promise<void> {
  await newConsole?.run(on, undefined as never);
}

beforeEach(() => {
  opened = [];
  useConsoles.setState({
    open: (_id, datasourceId, options) => {
      opened.push({ datasourceId, options });
      return Promise.resolve();
    },
  });
});

afterEach(() => {
  useConsoles.setState({ open: originalOpen });
  useDatasources.setState({ datasources: [], plugins: [], connect: originalConnect });
  useTabs.setState(useTabs.getInitialState(), true);
});

describe("new console from the Database pane", () => {
  it("givenTableSelectedInDatabasePane_whenNewConsole_thenConsolePendsItsNamespace", async () => {
    given(SWITCHING_PLUGIN);

    await run(context(ON_TABLE));

    expect(opened).toHaveLength(1);
    expect(opened[0]?.options?.namespace).toEqual(PUBLIC_PATH);
  });

  it("givenDatasourceSelected_whenNewConsole_thenNoNamespace", async () => {
    given(SWITCHING_PLUGIN);

    await run(context({ selection: { kind: "datasource", id: "pg" } }));

    expect(opened[0]?.options?.namespace ?? null).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("givenConsoleFocused_whenNewConsole_thenNoNamespace", async () => {
    given(SWITCHING_PLUGIN);

    await run(context({ ...ON_TABLE, focus: "editor", inDatabasePane: false }));

    expect(opened[0]?.options?.namespace ?? null).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("givenPluginWithoutCurrentNamespace_whenNewConsole_thenNoTargetsCall", async () => {
    given(POSTGRES_PLUGIN);

    await run(context(ON_TABLE, POSTGRES_PLUGIN));

    expect(opened[0]?.options?.namespace ?? null).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("givenTargetsCallRejects_whenNewConsole_thenConsoleStillOpens", async () => {
    given(SWITCHING_PLUGIN, () => Promise.reject(new Error("connection refused")));

    await run(context(ON_TABLE));

    expect(opened).toHaveLength(1);
    expect(opened[0]?.options?.namespace ?? null).toBeNull();
  });
});
