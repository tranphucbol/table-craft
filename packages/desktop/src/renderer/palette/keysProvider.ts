import type { KeyName } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { score } from "@table-craft/desktop/renderer/model/fuzzy.js";
import {
  databaseLabel,
  keyIdentity,
  loadedKeys,
  type DatasourceKeyspace,
} from "@table-craft/desktop/renderer/model/keyTree.js";
import type { SearchItem, SearchProvider } from "@table-craft/desktop/renderer/model/palette.js";

export const KEYS_PROVIDER_ID = "keys";
const KEY_ITEM_PREFIX = "key:";
const PATH_SEPARATOR = " › ";

/** A key to open, as the Keys tab and Go to Key name one. */
export interface OpenKeyArgs {
  readonly datasourceId: string;
  readonly database: number;
  readonly key: KeyName;
}

export interface KeysSource {
  readonly keyspaces: () => Readonly<Record<string, DatasourceKeyspace>>;
  readonly datasources: () => readonly DatasourceView[];
  /** Whether any datasource's plugin declares `keyValue`; the tab shows only then. */
  readonly browsesKeys: () => boolean;
  /** Opens the key; the provider never touches a store itself (decision 015). */
  readonly open: (args: OpenKeyArgs) => void;
}

/**
 * Keys of every keyspace scanned so far, titled by name with `datasource › db0` as detail. It never
 * scans: a database nobody expanded is not searched; Go to Key asks the server.
 */
export function keysProvider(source: KeysSource): SearchProvider {
  return {
    id: KEYS_PROVIDER_ID,
    title: "Keys",
    shown: source.browsesKeys,
    search(query) {
      const names = new Map(source.datasources().map((datasource) => [datasource.id, datasource.name]));
      return loadedKeys(source.keyspaces()).flatMap(({ datasourceId, database, key }): SearchItem[] => {
        const matched = score(query, key.text);
        const datasourceName = names.get(datasourceId);
        if (matched === null || datasourceName === undefined) return [];
        return [
          {
            key: `${KEY_ITEM_PREFIX}${JSON.stringify([datasourceId, database, keyIdentity(key)])}`,
            title: key.text,
            detail: [datasourceName, databaseLabel(database)].join(PATH_SEPARATOR),
            enabled: true,
            score: matched,
            run: () => source.open({ datasourceId, database, key }),
          },
        ];
      });
    },
  };
}
