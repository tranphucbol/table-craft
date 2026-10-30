import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import type { KeyEventLike } from "@table-craft/desktop/renderer/actions/keymap.js";

export const IDLE_CONTEXT: ActionContext = {
  tabs: [],
  activeTab: null,
  console: null,
  table: null,
  ddl: null,
  sessions: null,
  keyTab: null,
  serverTab: null,
  result: null,
  datasources: [],
  selection: null,
  datasource: null,
  capabilities: ["sql"],
  focus: "editor",
  inDatabasePane: false,
  toolWindows: { database: true, services: true, log: false, watch: false },
  paletteOpen: false,
  speedSearching: false,
  customTitleBar: true,
};

export interface FakeKey extends KeyEventLike {
  readonly prevented: () => boolean;
}

/** A keydown as the keymap sees it; `code` defaults from a single-character key. */
export function keydown(
  init: Partial<Omit<KeyEventLike, "preventDefault" | "stopPropagation">> & { key: string },
): FakeKey {
  let prevented = false;
  const code = init.code ?? (init.key.length === 1 ? `Key${init.key.toUpperCase()}` : init.key);
  return {
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: init.key === "Shift",
    repeat: false,
    timeStamp: 0,
    ...init,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => undefined,
    prevented: () => prevented,
  };
}
