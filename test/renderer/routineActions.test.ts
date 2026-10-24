import { afterEach, describe, expect, it } from "vitest";
import type { Routine } from "@table-craft/desktop/engine/protocol.js";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { ROUTINE_ACTION_IDS, ROUTINE_ACTIONS } from "@table-craft/desktop/renderer/actions/routineActions.js";
import { pathKey, relationKey, routineKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  initialArguments,
  parseRoutineAnswer,
  ROUTINE_CHOICES,
  routineAnswer,
  routineNote,
} from "@table-craft/desktop/renderer/model/routineCall.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { DISCONNECTED, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { LOADED_PG, PG_VIEW, PUBLIC_CATALOG, PUBLIC_PATH } from "./catalogFixtures.js";
import { POSTGRES_PLUGIN } from "./datasourceViews.js";
import { IDLE_CONTEXT } from "./support.js";

const CALC_FEE: Routine = {
  name: "calc_fee",
  kind: "function",
  signature: "amount numeric, rate numeric",
  parameters: [
    { name: "amount", type: "numeric", mode: "in", hasDefault: false },
    { name: "rate", type: "numeric", mode: "in", hasDefault: true },
  ],
  returns: "numeric",
};

const SETTLE_ORDER: Routine = {
  name: "settle_order",
  kind: "procedure",
  signature: "IN order_id integer, OUT total numeric",
  parameters: [
    { name: "order_id", type: "integer", mode: "in", hasDefault: false },
    { name: "total", type: "numeric", mode: "out", hasDefault: false },
  ],
  returns: null,
};

const ROUTINE_CALL_PLUGIN: PluginInfo = {
  ...POSTGRES_PLUGIN,
  capabilities: [...POSTGRES_PLUGIN.capabilities, "routineCall"],
};

const execute = ROUTINE_ACTIONS.find((action) => action.id === ROUTINE_ACTION_IDS.execute);

function given(plugin = ROUTINE_CALL_PLUGIN): void {
  useDatasources.setState({ datasources: [PG_VIEW], plugins: [plugin] });
  const described = { ...PUBLIC_CATALOG, catalog: { ...PUBLIC_CATALOG.catalog, routines: [CALC_FEE, SETTLE_ORDER] } };
  useCatalog.setState({
    catalogs: {
      pg: { ...LOADED_PG, namespaceStates: { [pathKey(PUBLIC_PATH)]: { described, loading: false, error: null } } },
    },
  });
}

function selecting(name: string, key: string): ActionContext {
  return {
    ...IDLE_CONTEXT,
    focus: "database",
    inDatabasePane: true,
    datasources: [PG_VIEW],
    selection: { kind: "catalog", id: "pg", path: PUBLIC_PATH, name, key },
    datasource: { view: PG_VIEW, connection: DISCONNECTED, capabilities: ROUTINE_CALL_PLUGIN.capabilities },
  };
}

function enabled(context: ActionContext): boolean {
  return (execute?.available?.(context) ?? true) && (execute?.when?.(context) ?? true);
}

afterEach(() => {
  useDatasources.setState({ datasources: [], plugins: [] });
  useCatalog.setState({ catalogs: {} });
});

describe("execute routine action", () => {
  it("givenRoutineSelected_whenActionAvailable_thenExecuteRoutineEnabled", () => {
    given();

    expect(enabled(selecting("calc_fee", routineKey("pg", PUBLIC_PATH, CALC_FEE)))).toBe(true);
    expect(enabled(selecting("settle_order", routineKey("pg", PUBLIC_PATH, SETTLE_ORDER)))).toBe(true);
  });

  it("givenRelationSelected_whenAsked_thenExecuteRoutineDisabled", () => {
    given();

    expect(enabled(selecting("orders", relationKey("pg", PUBLIC_PATH, "orders")))).toBe(false);
  });

  it("givenPluginWithoutRoutineCall_whenRoutineSelected_thenExecuteRoutineDisabled", () => {
    given(POSTGRES_PLUGIN);

    expect(enabled(selecting("calc_fee", routineKey("pg", PUBLIC_PATH, CALC_FEE)))).toBe(false);
  });

  it("givenOverloadKeyNotListed_whenAsked_thenExecuteRoutineDisabled", () => {
    given();
    const other = { ...CALC_FEE, signature: "amount numeric, currency text, rate numeric" };

    expect(enabled(selecting("calc_fee", routineKey("pg", PUBLIC_PATH, other)))).toBe(false);
  });
});

describe("routine call model", () => {
  it("givenAnswer_whenParsed_thenRoundTrips", () => {
    const answer = { choice: ROUTINE_CHOICES.run, call: { sql: "SELECT f(:a);", params: { ":a": null } } };

    expect(parseRoutineAnswer(routineAnswer(answer))).toEqual(answer);
  });

  it("givenDefaultedParameter_whenInitialArguments_thenDefaultElseEmptyValue", () => {
    expect(initialArguments(CALC_FEE)).toEqual([{ kind: "value", value: "" }, { kind: "default" }]);
  });

  it("givenFunctionOrProcedure_whenNoted_thenSaysWhatComesBack", () => {
    expect(routineNote(CALC_FEE, PUBLIC_PATH)).toBe(
      "table_craft.public.calc_fee(amount numeric, rate numeric) returns numeric.",
    );
    expect(routineNote(SETTLE_ORDER, PUBLIC_PATH)).toBe(
      "table_craft.public.settle_order(IN order_id integer, OUT total numeric) returns total numeric.",
    );
  });
});
