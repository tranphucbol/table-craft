import { create } from "zustand";
import type { EngineError, KeyName, ServerNode } from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { datasourceKey, keyTreeKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  appendKeys,
  EMPTY_KEYSPACE,
  keyIdentity,
  keyStartsWith,
  KEYS_PER_PASS,
  NO_KEY_FILTER,
  UNSCANNED_KEYS,
  UNLISTED_FOLDER,
  ROOT_KEY,
  CHILDREN_PER_PAGE,
  CHILDREN_TIMEOUT_MS,
  keyFilterRange,
  type DatabaseKeys,
  type DatasourceKeyspace,
  type KeyFilter,
} from "@table-craft/desktop/renderer/model/keyTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useServer } from "@table-craft/desktop/renderer/state/server.js";

/** Visible keys are described this many at a time (pipelined `TYPE` + `PTTL` in the plugin). */
const DESCRIBE_BATCH = 200;

export interface KeysState {
  /** By datasource id; a datasource without an entry has listed nothing since it last attached. */
  readonly keyspaces: Readonly<Record<string, DatasourceKeyspace>>;
  /** Expands the datasource, connecting it first; the first listing also opens the configured database. */
  readonly expandDatasource: (datasourceId: string) => Promise<void>;
  /** Expands the database, starting its scan when none has, unless the datasource loads on demand. */
  readonly expandDatabase: (datasourceId: string, database: number) => Promise<void>;
  /** Scans one more pass of up to 10,000 keys; on a database not loaded yet, its first pass. */
  readonly loadMore: (datasourceId: string, database: number) => Promise<void>;
  readonly expandFolder: (datasourceId: string, database: number, parent: KeyName) => Promise<void>;
  readonly loadChildren: (datasourceId: string, database: number, parent: KeyName, restart?: boolean) => Promise<void>;
  readonly countFolder: (datasourceId: string, database: number, parent: KeyName) => Promise<void>;
  readonly readLeaseTtl: (datasourceId: string, leaseId: string) => Promise<void>;
  /** Forgets the database's keys and scans again under `filter`. */
  readonly setFilter: (datasourceId: string, database: number, filter: KeyFilter) => Promise<void>;
  /** Reads the type and expiry of the keys not described yet; the tree asks for its visible rows. */
  readonly describe: (datasourceId: string, database: number, keys: readonly KeyName[]) => Promise<void>;
  /** Lists the databases again and rescans every database scanned so far. */
  readonly synchronize: (datasourceId: string) => Promise<void>;
  /** Puts keys found some other way, by Go to Key say, in the loaded list. */
  readonly remember: (datasourceId: string, database: number, keys: readonly KeyName[]) => void;
  /**
   * Relists only the shallowest loaded folders that showed something under `prefix`, and drops
   * every folder count, since an ancestor's count changed too. Without listed children it
   * falls back to `synchronize`.
   */
  readonly refreshRange: (datasourceId: string, database: number, prefix: KeyName) => Promise<void>;
  /** Drops keys deleted or renamed away from the loaded list. */
  readonly forget: (datasourceId: string, database: number, keys: readonly KeyName[]) => void;
  /** Forgets the datasource's keyspace; its engine is gone. */
  readonly clear: (datasourceId: string) => void;
}

export interface KeysDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly expand: (keys: readonly string[]) => void;
  readonly collapse: (key: string) => void;
  /** The datasource's servers; empty unless its plugin declares `nodes`. */
  readonly nodes: (datasourceId: string) => Promise<readonly ServerNode[]>;
  /** The datasource lists its databases but loads keys only when asked (decision 144). */
  readonly loadsOnDemand: (datasourceId: string) => boolean;
}

function toEngineError(cause: unknown): EngineError {
  if (cause instanceof EngineRequestError) return { code: cause.code, message: cause.message, hint: cause.hint };
  return {
    code: "internal",
    message: cause instanceof Error ? cause.message : String(cause),
    hint: "Choose Synchronize (⌥⌘Y) to try again; if it happens again, report it.",
  };
}

export function createKeysStore(dependencies: KeysDependencies) {
  /** Bumped by `clear`, so an answer from an engine that has since gone is dropped. */
  const generations = new Map<string, number>();
  const generationOf = (id: string) => generations.get(id) ?? 0;
  /** Bumped when a database's scan restarts, so the pass it replaces stops. */
  const scans = new Map<string, number>();
  const scanKey = (id: string, database: number) => `${id}\u0000${String(database)}`;
  const describing = new Set<string>();

  return create<KeysState>()((set, get) => {
    function keyspaceOf(id: string): DatasourceKeyspace {
      return get().keyspaces[id] ?? EMPTY_KEYSPACE;
    }

    function update(id: string, change: (keyspace: DatasourceKeyspace) => DatasourceKeyspace): void {
      set({ keyspaces: { ...get().keyspaces, [id]: change(keyspaceOf(id)) } });
    }

    function databaseOf(id: string, database: number): DatabaseKeys {
      return keyspaceOf(id).byDatabase[database] ?? UNSCANNED_KEYS;
    }

    function updateDatabase(id: string, database: number, change: (keys: DatabaseKeys) => DatabaseKeys): void {
      update(id, (keyspace) => ({
        ...keyspace,
        byDatabase: { ...keyspace.byDatabase, [database]: change(keyspace.byDatabase[database] ?? UNSCANNED_KEYS) },
      }));
    }

    async function listDatabases(id: string): Promise<boolean> {
      const generation = generationOf(id);
      update(id, (keyspace) => ({ ...keyspace, loading: true, error: null }));
      try {
        const client = await dependencies.connect(id);
        const [listed, nodes, features] = await Promise.all([
          client.call("keyspace.databases", {}),
          dependencies.nodes(id),
          client.call("keyspace.features", {}),
        ]);
        if (generationOf(id) !== generation) return false;
        update(id, (keyspace) => ({
          ...keyspace,
          features,
          delimiter: listed.delimiter,
          databases: listed.databases,
          nodes,
          loading: false,
          error: null,
        }));
        return true;
      } catch (cause) {
        if (generationOf(id) !== generation) return false;
        update(id, (keyspace) => ({ ...keyspace, loading: false, error: toEngineError(cause) }));
        return false;
      }
    }

    /** One pass: SCAN batches until 10,000 keys came back or the cursor ended. */
    async function pass(id: string, database: number, fresh: boolean): Promise<void> {
      if (keyspaceOf(id).features?.children === true) {
        if (fresh) {
          scans.set(scanKey(id, database), (scans.get(scanKey(id, database)) ?? 0) + 1);
          updateDatabase(id, database, (keys) => ({
            ...UNSCANNED_KEYS,
            filter:
              keys.filter.mode === undefined
                ? { ...keys.filter, match: keys.filter.match === "*" ? "" : keys.filter.match, mode: "prefix" }
                : keys.filter,
            started: true,
            folders: {},
            counts: {},
          }));
        }
        await get().loadChildren(id, database, ROOT_KEY, fresh);
        return;
      }
      const generation = generationOf(id);
      const token = (scans.get(scanKey(id, database)) ?? 0) + 1;
      scans.set(scanKey(id, database), token);
      const current = () => generationOf(id) === generation && scans.get(scanKey(id, database)) === token;
      updateDatabase(id, database, (keys) =>
        fresh
          ? { ...UNSCANNED_KEYS, filter: keys.filter, started: true, loading: true }
          : { ...keys, started: true, loading: true, error: null },
      );
      let cursor = fresh ? null : databaseOf(id, database).cursor;
      let loaded = 0;
      try {
        const client = await dependencies.connect(id);
        do {
          const { filter } = databaseOf(id, database);
          const scan = await client.call("keyspace.scan", {
            database,
            cursor,
            match: filter.match,
            keyType: filter.type,
          });
          if (!current()) return;
          cursor = scan.cursor;
          loaded += scan.keys.length;
          const next = cursor;
          updateDatabase(id, database, (keys) => ({ ...keys, keys: appendKeys(keys.keys, scan.keys), cursor: next }));
        } while (cursor !== null && loaded < KEYS_PER_PASS);
        updateDatabase(id, database, (keys) => ({ ...keys, loading: false }));
      } catch (cause) {
        if (!current()) return;
        updateDatabase(id, database, (keys) => ({ ...keys, loading: false, error: toEngineError(cause) }));
      }
    }

    function expandDatabaseKeys(id: string, database: number): void {
      dependencies.expand([keyTreeKey(id, "keyDatabase", database)]);
    }

    return {
      keyspaces: {},

      async expandDatasource(id) {
        const key = datasourceKey(id);
        dependencies.expand([key]);
        const first = keyspaceOf(id).databases === null;
        if (!first || keyspaceOf(id).loading) return;
        try {
          await dependencies.connect(id);
        } catch {
          // The datasource row shows why (plan 004); there is nothing to list.
          update(id, () => EMPTY_KEYSPACE);
          dependencies.collapse(key);
          return;
        }
        if (!(await listDatabases(id))) return;
        const configured = keyspaceOf(id).databases?.find((database) => database.current);
        if (configured === undefined) return;
        expandDatabaseKeys(id, configured.index);
        await get().expandDatabase(id, configured.index);
      },

      async expandDatabase(id, database) {
        expandDatabaseKeys(id, database);
        const keys = databaseOf(id, database);
        if (keys.started || dependencies.loadsOnDemand(id)) return;
        await pass(id, database, true);
      },

      async loadMore(id, database) {
        const unloaded = databaseOf(id, database);
        if (!unloaded.started) {
          if (unloaded.loading) return;
          await pass(id, database, true);
          return;
        }
        if (keyspaceOf(id).features?.children === true) {
          await get().loadChildren(id, database, ROOT_KEY);
          return;
        }
        const keys = databaseOf(id, database);
        if (keys.loading || keys.cursor === null) return;
        await pass(id, database, false);
      },

      async setFilter(id, database, filter) {
        if (keyspaceOf(id).features?.children === true) {
          const { filter: previous, started } = databaseOf(id, database);
          updateDatabase(id, database, (keys) => ({ ...keys, filter: { ...filter, type: null } }));
          if (filter.mode === "loadedName") return;
          if (
            started &&
            previous.mode === filter.mode &&
            previous.match === filter.match &&
            previous.end === filter.end
          )
            return;
          await pass(id, database, true);
          return;
        }
        const match = filter.match.trim() === "" ? NO_KEY_FILTER.match : filter.match.trim();
        updateDatabase(id, database, (keys) => ({ ...keys, filter: { match, type: filter.type } }));
        await pass(id, database, true);
      },

      async expandFolder(id, database, parent) {
        const rest = parent.hex === null ? [parent.text] : [parent.text, parent.hex];
        dependencies.expand([keyTreeKey(id, "keyFolder", database, ...rest)]);
        if (keyspaceOf(id).features?.children !== true) return;
        const folder = databaseOf(id, database).folders?.[keyIdentity(parent)];
        if (folder?.started === true) return;
        await get().loadChildren(id, database, parent, true);
      },

      async loadChildren(id, database, parent, restart = false) {
        if (keyspaceOf(id).features?.children !== true) return;
        const identity = keyIdentity(parent);
        const old = databaseOf(id, database).folders?.[identity] ?? UNLISTED_FOLDER;
        if (!restart && (old.loading || old.error !== null || (old.started && old.cursor === null))) return;
        const generation = generationOf(id);
        const databaseToken = scans.get(scanKey(id, database));
        const mark = `${scanKey(id, database)}\u0000folder\u0000${identity}`;
        const token = (scans.get(mark) ?? 0) + 1;
        scans.set(mark, token);
        const current = () =>
          generationOf(id) === generation &&
          scans.get(mark) === token &&
          scans.get(scanKey(id, database)) === databaseToken;
        const change = (updateFolder: (folder: typeof UNLISTED_FOLDER) => typeof UNLISTED_FOLDER) =>
          updateDatabase(id, database, (keys) => ({
            ...keys,
            started: true,
            folders: { ...keys.folders, [identity]: updateFolder(keys.folders?.[identity] ?? UNLISTED_FOLDER) },
          }));
        if (restart) {
          const descendants = Object.entries(databaseOf(id, database).folders ?? {}).filter(
            ([childIdentity, folder]) => childIdentity !== identity && keyStartsWith(folder.parent, parent),
          );
          for (const [childIdentity] of descendants) {
            const childMark = `${scanKey(id, database)}\u0000folder\u0000${childIdentity}`;
            scans.set(childMark, (scans.get(childMark) ?? 0) + 1);
          }
          const removed = new Set(descendants.map(([childIdentity]) => childIdentity));
          updateDatabase(id, database, (keys) => ({
            ...keys,
            keys: keys.keys.filter((key) => !keyStartsWith(key, parent)),
            info: Object.fromEntries(Object.entries(keys.info).filter(([, info]) => !keyStartsWith(info.key, parent))),
            folders: Object.fromEntries(
              Object.entries(keys.folders ?? {}).filter(([childIdentity]) => !removed.has(childIdentity)),
            ),
            counts: Object.fromEntries(
              Object.entries(keys.counts ?? {}).filter(
                ([childIdentity]) => childIdentity !== identity && !removed.has(childIdentity),
              ),
            ),
          }));
        }
        change((folder) => ({
          ...(restart ? UNLISTED_FOLDER : folder),
          parent,
          started: true,
          loading: true,
          error: null,
        }));
        try {
          const client = await dependencies.connect(id);
          const page = await client.call("keyspace.children", {
            database,
            parent,
            range: keyFilterRange(databaseOf(id, database).filter),
            cursor: restart ? null : old.cursor,
            count: CHILDREN_PER_PAGE,
            timeoutMs: CHILDREN_TIMEOUT_MS,
          });
          if (!current()) return;
          if (!restart && old.revision !== null && old.revision !== page.revision)
            throw new Error("The listing revision changed. Restart listing to read a fresh snapshot.");
          change((folder) => {
            const baseline = restart ? [] : folder.children;
            const seen = new Set(baseline.map((child) => `${child.kind}:${keyIdentity(child.key)}`));
            const children = [
              ...baseline,
              ...page.children.filter((child) => !seen.has(`${child.kind}:${keyIdentity(child.key)}`)),
            ];
            return { ...folder, children, revision: page.revision, cursor: page.cursor, loading: false };
          });
          updateDatabase(id, database, (keys) => ({
            ...keys,
            keys: appendKeys(
              keys.keys,
              page.children.filter((child) => child.kind === "key").map((child) => child.key),
            ),
          }));
        } catch (cause) {
          if (current()) change((folder) => ({ ...folder, loading: false, error: toEngineError(cause) }));
        }
      },

      async countFolder(id, database, parent) {
        if (keyspaceOf(id).features?.countRange !== true) return;
        const identity = keyIdentity(parent);
        const counts = databaseOf(id, database).counts;
        const mark = `${scanKey(id, database)}\u0000count\u0000${identity}`;
        if ((counts !== undefined && identity in counts) || describing.has(mark)) return;
        describing.add(mark);
        const generation = generationOf(id);
        const token = scans.get(scanKey(id, database));
        const current = () => generationOf(id) === generation && scans.get(scanKey(id, database)) === token;
        try {
          const client = await dependencies.connect(id);
          const count = await client.call("keyspace.countRange", {
            database,
            range: { kind: "prefix", prefix: parent },
          });
          if (current())
            updateDatabase(id, database, (keys) => ({ ...keys, counts: { ...keys.counts, [identity]: count.keys } }));
        } catch {
          if (current())
            updateDatabase(id, database, (keys) => ({ ...keys, counts: { ...keys.counts, [identity]: null } }));
        } finally {
          describing.delete(mark);
        }
      },

      async readLeaseTtl(id, leaseId) {
        const mark = `${id}\u0000lease\u0000${leaseId}`;
        if (leaseId === "0" || keyspaceOf(id).leaseTtls?.[leaseId] !== undefined || describing.has(mark)) return;
        describing.add(mark);
        const generation = generationOf(id);
        let seconds: string | null = null;
        try {
          const client = await dependencies.connect(id);
          const lease = await client.call("leases.get", { leaseId });
          seconds = lease.remainingTtlSeconds;
        } catch {
          // Lease metadata may be inaccessible even when the key can be listed.
        } finally {
          if (generationOf(id) === generation)
            update(id, (keyspace) => ({
              ...keyspace,
              leaseTtls: { ...keyspace.leaseTtls, [leaseId]: { seconds, readAt: Date.now() } },
            }));
          describing.delete(mark);
        }
      },

      async describe(id, database, keys) {
        const known = databaseOf(id, database).info;
        const wanted = keys.filter((key) => {
          const identity = keyIdentity(key);
          return known[identity] === undefined && !describing.has(`${scanKey(id, database)}\u0000${identity}`);
        });
        if (wanted.length === 0) return;
        const generation = generationOf(id);
        for (let at = 0; at < wanted.length; at += DESCRIBE_BATCH) {
          const batch = wanted.slice(at, at + DESCRIBE_BATCH);
          const marks = batch.map((key) => `${scanKey(id, database)}\u0000${keyIdentity(key)}`);
          for (const mark of marks) describing.add(mark);
          try {
            const client = await dependencies.connect(id);
            const described = await client.call("keyspace.describe", { database, keys: batch });
            if (generationOf(id) !== generation) return;
            updateDatabase(id, database, (current) => {
              const info = { ...current.info };
              for (const entry of described) info[keyIdentity(entry.key)] = entry;
              return { ...current, info };
            });
          } catch {
            // A row without a type keeps no badge; Synchronize reads it again.
          } finally {
            for (const mark of marks) describing.delete(mark);
          }
        }
      },

      async synchronize(id) {
        if (!(await listDatabases(id))) return;
        update(id, (keyspace) => ({ ...keyspace, leaseTtls: {} }));
        const scanned = Object.entries(keyspaceOf(id).byDatabase)
          .filter(([, keys]) => keys.started)
          .map(([database]) => Number(database));
        await Promise.all(scanned.map((database) => pass(id, database, true)));
      },

      remember(id, database, keys) {
        updateDatabase(id, database, (current) => ({ ...current, keys: appendKeys(current.keys, keys) }));
        if (keyspaceOf(id).features?.children === true) {
          for (const folder of Object.values(databaseOf(id, database).folders ?? {})) {
            if (folder.started && keys.some((key) => keyStartsWith(key, folder.parent))) {
              void get().loadChildren(id, database, folder.parent, true);
            }
          }
        }
      },

      async refreshRange(id, database, prefix) {
        if (keyspaceOf(id).features?.children !== true) {
          await get().synchronize(id);
          return;
        }
        const listed = Object.values(databaseOf(id, database).folders ?? {}).filter(
          (folder) => folder.started && folder.children.some((child) => keyStartsWith(child.key, prefix)),
        );
        const shallowest = listed.filter(
          (folder) => !listed.some((other) => other !== folder && keyStartsWith(folder.parent, other.parent)),
        );
        updateDatabase(id, database, (keys) => ({ ...keys, counts: {} }));
        await Promise.all(shallowest.map((folder) => get().loadChildren(id, database, folder.parent, true)));
      },

      forget(id, database, keys) {
        const gone = new Set(keys.map(keyIdentity));
        updateDatabase(id, database, (current) => ({
          ...current,
          keys: current.keys.filter((key) => !gone.has(keyIdentity(key))),
          info: Object.fromEntries(Object.entries(current.info).filter(([identity]) => !gone.has(identity))),
          folders: Object.fromEntries(
            Object.entries(current.folders ?? {}).map(([identity, folder]) => [
              identity,
              {
                ...folder,
                children: folder.children.filter((child) => child.kind !== "key" || !gone.has(keyIdentity(child.key))),
              },
            ]),
          ),
          counts: {},
        }));
      },

      clear(id) {
        generations.set(id, generationOf(id) + 1);
        const { [id]: _gone, ...keyspaces } = get().keyspaces;
        set({ keyspaces });
      },
    };
  });
}

export type KeysStore = ReturnType<typeof createKeysStore>;

function declaresNodes(datasourceId: string): boolean {
  const state = useDatasources.getState();
  const datasource = state.datasources.find((candidate) => candidate.id === datasourceId);
  return datasource !== undefined && capabilitiesOf(state.plugins, datasource.pluginId).includes("nodes");
}

export const useKeys = createKeysStore({
  connect: (id) => useDatasources.getState().connect(id),
  expand: (keys) => useCatalog.getState().expandAll(keys),
  collapse: (key) => useCatalog.getState().setExpanded(key, false),
  nodes: async (id) => (declaresNodes(id) ? useServer.getState().loadNodes(id) : []),
  loadsOnDemand: (id) =>
    useDatasources.getState().datasources.find((datasource) => datasource.id === id)?.loadKeysOnDemand === true,
});
