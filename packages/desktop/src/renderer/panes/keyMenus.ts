import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { KEY_EDIT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyEditActions.js";
import { OBJECT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/objectActions.js";
import type { ExplorerNode } from "@table-craft/desktop/renderer/model/explorerTree.js";

/** Key-tree items that only datasources taking changes offer, left out rather than greyed. */
export const KEY_HIDDEN_WHEN_DISABLED: readonly string[] = [
  KEY_EDIT_ACTION_IDS.newKey,
  KEY_EDIT_ACTION_IDS.setTtl,
  KEY_EDIT_ACTION_IDS.persist,
  KEY_EDIT_ACTION_IDS.deleteFolder,
];

/** A key's context menu (plan 058 decision 17). */
export const KEY_MENU = [
  KEY_ACTION_IDS.open,
  ACTION_IDS.newConsole,
  null,
  OBJECT_ACTION_IDS.rename,
  KEY_EDIT_ACTION_IDS.setTtl,
  KEY_EDIT_ACTION_IDS.persist,
  OBJECT_ACTION_IDS.drop,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  KEY_ACTION_IDS.goTo,
  null,
  KEY_ACTION_IDS.toggleEmptyDatabases,
] as const;
/** A database, folder or other key-tree row's context menu. */
export const KEYSPACE_MENU = [
  ACTION_IDS.newConsole,
  KEY_EDIT_ACTION_IDS.newKey,
  KEY_ACTION_IDS.goTo,
  KEY_ACTION_IDS.filter,
  KEY_ACTION_IDS.loadMore,
  null,
  KEY_EDIT_ACTION_IDS.deleteFolder,
  null,
  ACTION_IDS.synchronize,
  null,
  KEY_ACTION_IDS.toggleEmptyDatabases,
] as const;
export const KEY_TREE_KINDS: ReadonlySet<ExplorerNode["kind"]> = new Set([
  "keyDatabase",
  "keyFilter",
  "keyFolder",
  "keyLoadMore",
  "clusterNodes",
  "clusterNode",
]);
