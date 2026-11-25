import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import type { EngineError } from "@table-craft/desktop/engine/protocol.js";
import {
  setShownIndices,
  setShownNamespacesAndDatabases,
  setShownNamespaces,
  setShownTopics,
} from "@table-craft/desktop/renderer/actions/datasourceCommands.js";
import {
  Button,
  Check,
  CONTENT_CLASS,
  DialogHeader,
  OVERLAY_CLASS,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import { EMPTY_CATALOG, topLevelNamespaces } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { EMPTY_INDICES } from "@table-craft/desktop/renderer/model/indexTree.js";
import { shownIndexEntries, type ShownIndexEntry } from "@table-craft/desktop/renderer/model/shownIndices.js";
import {
  matchingNamespaces,
  matchPositions,
  namespaceNoun,
  selectedCount,
  withNames,
} from "@table-craft/desktop/renderer/model/shownSchemas.js";
import { EMPTY_STREAMS } from "@table-craft/desktop/renderer/model/streamTree.js";
import { Highlighted } from "@table-craft/desktop/renderer/panes/explorerLabels.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useIndices } from "@table-craft/desktop/renderer/state/indices.js";
import { useManageShownSchemasDialog } from "@table-craft/desktop/renderer/state/manageShownSchemasDialog.js";
import { useStreams } from "@table-craft/desktop/renderer/state/streams.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import {
  AliasIcon,
  DatabaseIcon,
  DataStreamIcon,
  IndexFamilyIcon,
  SchemaIcon,
  SearchIcon,
  SearchIndexIcon,
  SpinnerIcon,
  TopicIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";
import { steppedIndex } from "@table-craft/desktop/renderer/ui/ListPicker.js";

const SEARCH_FIELD_ID = "manage-shown-schemas-search";
const ROW_CHECKBOX = "input[type=checkbox]:not(:disabled)";
const BADGE_CLASS = "shrink-0 rounded bg-raised px-1 text-ink-muted";

const GLYPHS = {
  database: DatabaseIcon,
  schema: SchemaIcon,
  topic: TopicIcon,
  index: SearchIndexIcon,
  family: IndexFamilyIcon,
  dataStream: DataStreamIcon,
  alias: AliasIcon,
} as const;

interface ShownItem {
  readonly name: string;
  readonly glyph: keyof typeof GLYPHS;
  readonly badges: readonly string[];
  /** Other names the search finds the row by. */
  readonly searchAlso?: readonly string[];
}

/** What one kind of allow-list calls its items and where it reads and saves them. */
interface ShownList {
  readonly title: string;
  readonly dialog: string;
  /** Plural, lower case: "schemas", "databases", "topics", "indices". */
  readonly noun: string;
  readonly allLabel: string;
  readonly searchLabel: string;
  readonly listLabel: string;
  readonly items: readonly ShownItem[];
  readonly loading: boolean;
  readonly error: EngineError | null;
  readonly initial: readonly string[] | undefined;
  /** What happens to items created later once some are ticked, when it differs from "they stay hidden". */
  readonly laterNote?: string;
  readonly save: (names: readonly string[] | undefined) => Promise<boolean>;
}

function Row({
  item,
  query,
  all,
  checked,
  onToggle,
}: {
  readonly item: ShownItem;
  readonly query: string;
  readonly all: boolean;
  readonly checked: boolean;
  readonly onToggle: (on: boolean) => void;
}) {
  const Glyph = GLYPHS[item.glyph];
  return (
    <li
      className={cn(
        "flex h-row items-center gap-cell px-cell has-[:focus-visible]:bg-selection",
        all ? "text-ink-muted" : "hover:bg-hover",
      )}
    >
      <label className="flex h-full min-w-0 flex-1 items-center gap-cell">
        <input
          type="checkbox"
          className="shrink-0 outline-none"
          disabled={all}
          checked={checked}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <Glyph aria-hidden className="size-icon shrink-0 text-ink-muted" />
        <Highlighted text={item.name} positions={matchPositions(item.name, query)} />
      </label>
      {item.badges.map((badge) => (
        <span key={badge} className={BADGE_CLASS}>
          {badge}
        </span>
      ))}
    </li>
  );
}

function ListNote({ children, alert = false }: { readonly children: ReactNode; readonly alert?: boolean }) {
  return (
    <li
      role={alert ? "alert" : undefined}
      className={cn("flex flex-col items-center gap-cell p-gap text-center", alert ? "text-danger" : "text-ink-muted")}
    >
      {children}
    </li>
  );
}

/**
 * An allow-list editor (decision 117): which of the datasource's items the Database pane lists.
 * `selected` null is the "All" choice, the absent list that also shows ones made later. Focus
 * starts in the search field; ↓ walks into the list, Space ticks, Enter is OK, Esc cancels.
 */
function Editor({ list: spec }: { readonly list: ShownList }) {
  const hide = useManageShownSchemasDialog((state) => state.hide);
  const { items, noun, loading, error } = spec;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(
    spec.initial === undefined ? null : new Set(spec.initial),
  );
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const visible = matchingNamespaces(items, query);
  const visibleNames = visible.map((item) => item.name);
  const filtered = query.trim() !== "";
  const all = selected === null;
  const count = selectedCount(items, selected);
  const noneSelected = !all && count === 0;

  function setAll(on: boolean): void {
    setSelected(on ? null : new Set(items.map((item) => item.name)));
  }

  function setVisible(on: boolean): void {
    setSelected((current) => withNames(current ?? new Set(), visibleNames, on));
  }

  async function save(): Promise<void> {
    setSaving(true);
    const saved = await spec.save(selected === null ? undefined : [...selected]);
    setSaving(false);
    if (saved) hide();
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    const target = event.target;
    const boxes = [...(list.current?.querySelectorAll<HTMLInputElement>(ROW_CHECKBOX) ?? [])];
    if (target === search.current) {
      if (event.key !== "ArrowDown" || boxes.length === 0) return;
      event.preventDefault();
      boxes[0]?.focus();
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    const at = boxes.indexOf(target);
    if (event.key === "Enter" && target.type === "checkbox") {
      event.preventDefault();
      form.current?.requestSubmit();
      return;
    }
    if (at === -1) return;
    if (event.key === "ArrowUp" && at === 0) {
      event.preventDefault();
      search.current?.focus();
      return;
    }
    const next = steppedIndex(boxes.length, at, event.key);
    if (next === null) return;
    event.preventDefault();
    boxes[next]?.focus();
    boxes[next]?.scrollIntoView({ block: "nearest" });
  }

  return (
    <form
      ref={form}
      className="flex h-full min-h-0 flex-col"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (!noneSelected && !saving) void save();
      }}
    >
      <DialogHeader title={spec.title} dialog={spec.dialog} />
      <div className="flex min-h-0 flex-1 flex-col gap-cell p-gap">
        <div className="flex h-row items-center gap-cell rounded border border-line bg-canvas px-cell focus-within:border-accent">
          <SearchIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
          <input
            ref={search}
            id={SEARCH_FIELD_ID}
            aria-label={spec.searchLabel}
            placeholder={`Search ${noun}`}
            autoFocus
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {filtered ? (
            <span className="shrink-0 text-ink-muted tabular-nums">
              {String(visible.length)} of {String(items.length)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-cell">
          <div className="flex-1">
            <Check label={spec.allLabel} checked={all} onChange={setAll} />
          </div>
          <Button
            disabled={all || visible.length === 0}
            title={filtered ? `Tick the ${String(visible.length)} ${noun} the search finds` : undefined}
            onClick={() => setVisible(true)}
          >
            Select All
          </Button>
          <Button
            disabled={all || visible.length === 0}
            title={filtered ? `Untick the ${String(visible.length)} ${noun} the search finds` : undefined}
            onClick={() => setVisible(false)}
          >
            Select None
          </Button>
        </div>
        <p className="text-ink-muted">
          {all
            ? `The tree lists every one, including ${noun} created later. Untick ${spec.allLabel} to pick.`
            : (spec.laterNote ?? `The tree lists only the ticked ${noun}; ones created later stay hidden.`)}
        </p>
        <ul
          ref={list}
          aria-label={spec.listLabel}
          aria-busy={loading}
          className="min-h-0 flex-1 overflow-y-auto rounded border border-line bg-canvas py-1"
        >
          {loading ? (
            <ListNote>
              <span className="flex items-center gap-cell">
                <SpinnerIcon aria-hidden className="size-icon animate-spin" />
                Loading {noun}…
              </span>
            </ListNote>
          ) : null}
          {error === null ? null : (
            <ListNote alert>
              <span>{error.message}</span>
              <span className="text-ink-muted">{error.hint}</span>
            </ListNote>
          )}
          {!loading && error === null && items.length === 0 ? (
            <ListNote>This data source has no {noun} to list.</ListNote>
          ) : null}
          {filtered && items.length > 0 && visible.length === 0 ? (
            <ListNote>
              No {noun} match “{query.trim()}”.
            </ListNote>
          ) : null}
          {visible.map((item) => (
            <Row
              key={item.name}
              item={item}
              query={query}
              all={all}
              checked={all || selected.has(item.name)}
              onToggle={(on) => setSelected((current) => withNames(current ?? new Set(), [item.name], on))}
            />
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-gap border-t border-line p-gap">
        <span aria-live="polite" className="flex-1">
          {noneSelected ? (
            <span className="text-danger">Pick at least one, or turn on {spec.allLabel}.</span>
          ) : (
            <span data-testid="shown-schemas-count" className="text-ink-muted tabular-nums">
              {all ? `All ${String(items.length)} shown` : `${String(count)} of ${String(items.length)} shown`}
            </span>
          )}
        </span>
        <Button onClick={hide}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={noneSelected || saving || loading}>
          OK
        </Button>
      </div>
    </form>
  );
}

function SchemasEditor({ view }: { readonly view: DatasourceView }) {
  const catalog = useCatalog((state) => state.catalogs[view.id] ?? EMPTY_CATALOG);
  const hasDatabaseDiscovery = useDatasources((state) =>
    capabilitiesOf(state.plugins, view.pluginId).includes("databases"),
  );
  const databaseNames = useDatasources(
    (state) => state.databaseNames.find((item) => item.sourceId === view.id)?.names ?? [],
  );

  useEffect(() => {
    const current = useCatalog.getState().catalogs[view.id] ?? EMPTY_CATALOG;
    if (current.namespaces === null && !current.loading) void useCatalog.getState().synchronize(view.id, null);
  }, [view.id]);

  useEffect(() => {
    if (hasDatabaseDiscovery) void useDatasources.getState().discoverDatabases(view.id);
  }, [hasDatabaseDiscovery, view.id]);

  const namespaces = useMemo(
    () => (catalog.namespaces === null ? [] : topLevelNamespaces(catalog.namespaces)),
    [catalog.namespaces],
  );
  const items = useMemo(
    () =>
      [
        ...namespaces.map((namespace): ShownItem => ({
          name: namespace.name,
          glyph: namespace.kind === "database" ? "database" : "schema",
          badges: [...(namespace.current ? ["current"] : []), ...(namespace.system ? ["system"] : [])],
        })),
        ...databaseNames
          .filter((name) => !namespaces.some((namespace) => namespace.name === name))
          .map((name): ShownItem => ({ name, glyph: "database", badges: [] })),
      ],
    [databaseNames, namespaces],
  );
  const noun = hasDatabaseDiscovery ? "databases and schemas" : namespaceNoun(namespaces);
  const allLabel = hasDatabaseDiscovery ? "All databases and schemas" : "All schemas";
  const initial = hasDatabaseDiscovery
    ? [...(view.shownNamespaces ?? namespaces.map((namespace) => namespace.name)), ...(view.shownDatabases ?? [])]
    : view.shownNamespaces;
  async function save(names: readonly string[] | undefined): Promise<boolean> {
    if (!hasDatabaseDiscovery) return setShownNamespaces(view, names);
    const databaseSet = new Set(databaseNames);
    const shownSchemas = names?.filter((name) => !databaseSet.has(name));
    const shownDatabases = names === undefined ? databaseNames : names.filter((name) => databaseSet.has(name));
    return setShownNamespacesAndDatabases(view, shownSchemas, shownDatabases);
  }
  return (
    <Editor
      list={{
        title: `Manage Shown Schemas — ${view.name}`,
        dialog: "Manage Shown Schemas",
        noun,
        allLabel,
        searchLabel: hasDatabaseDiscovery ? "Search databases and schemas" : "Search schemas",
        listLabel: hasDatabaseDiscovery ? "Databases and schemas" : "Schemas",
        items,
        loading: catalog.namespaces === null && catalog.error === null,
        error: catalog.error,
        initial,
        save,
      }}
    />
  );
}

function TopicsEditor({ view }: { readonly view: DatasourceView }) {
  const streams = useStreams((state) => state.streams[view.id] ?? EMPTY_STREAMS);

  useEffect(() => {
    const current = useStreams.getState().streams[view.id] ?? EMPTY_STREAMS;
    if (current.topics === null && !current.loading) void useStreams.getState().synchronize(view.id);
  }, [view.id]);

  const items = useMemo(
    () =>
      (streams.topics ?? []).map((topic): ShownItem => ({
        name: topic.name,
        glyph: "topic",
        badges: topic.internal ? ["internal"] : [],
      })),
    [streams.topics],
  );
  return (
    <Editor
      list={{
        title: `Manage Shown Topics — ${view.name}`,
        dialog: "Manage Shown Topics",
        noun: "topics",
        allLabel: "All topics",
        searchLabel: "Search topics",
        listLabel: "Topics",
        items,
        loading: streams.topics === null && streams.error === null,
        error: streams.error,
        initial: view.shownTopics,
        save: (names) => setShownTopics(view, names),
      }}
    />
  );
}

function indexBadges(entry: ShownIndexEntry): string[] {
  return [
    ...(entry.kind === "family" ? [`${String(entry.members)} ${entry.members === 1 ? "index" : "indices"}`] : []),
    ...entry.writeAliases.map((alias) => `alias ${alias}`),
    ...(entry.hidden ? ["hidden"] : []),
  ];
}

function IndicesEditor({ view }: { readonly view: DatasourceView }) {
  const indices = useIndices((state) => state.indices[view.id] ?? EMPTY_INDICES);

  useEffect(() => {
    const current = useIndices.getState().indices[view.id] ?? EMPTY_INDICES;
    if (current.targets === null && !current.loading) void useIndices.getState().synchronize(view.id);
  }, [view.id]);

  const items = useMemo(
    () =>
      shownIndexEntries(indices.targets ?? []).map((entry): ShownItem => ({
        name: entry.name,
        glyph: entry.kind === "family" ? "family" : entry.kind,
        badges: indexBadges(entry),
        searchAlso: entry.writeAliases,
      })),
    [indices.targets],
  );
  return (
    <Editor
      list={{
        title: `Manage Shown Indices — ${view.name}`,
        dialog: "Manage Shown Indices",
        noun: "indices",
        allLabel: "All indices",
        searchLabel: "Search indices",
        listLabel: "Indices",
        items,
        loading: indices.targets === null && indices.error === null,
        error: indices.error,
        initial: view.shownIndices,
        laterNote:
          "The tree lists only the ticked indices; a ticked family (name-*) keeps its new rollovers and write alias, other new ones stay hidden.",
        save: (names) => setShownIndices(view, names),
      }}
    />
  );
}

const EDITORS = { schemas: SchemasEditor, topics: TopicsEditor, indices: IndicesEditor } as const;

export function ManageShownSchemasDialog() {
  const datasourceId = useManageShownSchemasDialog((state) => state.datasourceId);
  const session = useManageShownSchemasDialog((state) => state.session);
  const subject = useManageShownSchemasDialog((state) => state.subject);
  const view = useDatasources((state) =>
    datasourceId === null ? undefined : state.datasources.find((datasource) => datasource.id === datasourceId),
  );
  const Content = EDITORS[subject];
  return (
    <Dialog.Root
      open={view !== undefined}
      onOpenChange={(open) => {
        if (!open) useManageShownSchemasDialog.getState().hide();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            CONTENT_CLASS,
            "flex h-dialog-height max-h-[95vh] w-picker max-w-[95vw] flex-col overflow-hidden",
          )}
        >
          {view === undefined ? null : <Content key={session} view={view} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
