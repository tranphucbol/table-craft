import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import { setShownNamespaces } from "@table-craft/desktop/renderer/actions/datasourceCommands.js";
import { Button, Check, CONTENT_CLASS, OVERLAY_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { EMPTY_CATALOG, topLevelNamespaces } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  matchingNamespaces,
  matchPositions,
  namespaceNoun,
  selectedCount,
  withNames,
} from "@table-craft/desktop/renderer/model/shownSchemas.js";
import { Highlighted } from "@table-craft/desktop/renderer/panes/explorerLabels.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useManageShownSchemasDialog } from "@table-craft/desktop/renderer/state/manageShownSchemasDialog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { DatabaseIcon, SchemaIcon, SearchIcon, SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { steppedIndex } from "@table-craft/desktop/renderer/ui/ListPicker.js";

const SEARCH_FIELD_ID = "manage-shown-schemas-search";
const ROW_CHECKBOX = "input[type=checkbox]:not(:disabled)";
const BADGE_CLASS = "shrink-0 rounded-sm bg-raised px-1 text-ink-muted";

function Row({
  namespace,
  query,
  all,
  checked,
  onToggle,
}: {
  readonly namespace: Namespace;
  readonly query: string;
  readonly all: boolean;
  readonly checked: boolean;
  readonly onToggle: (on: boolean) => void;
}) {
  const Glyph = namespace.kind === "database" ? DatabaseIcon : SchemaIcon;
  return (
    <li
      className={cn(
        "flex h-row items-center gap-cell px-cell has-[:focus-visible]:bg-selection",
        all ? "text-ink-muted" : "hover:bg-raised",
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
        <Highlighted text={namespace.name} positions={matchPositions(namespace.name, query)} />
      </label>
      {namespace.current ? <span className={BADGE_CLASS}>current</span> : null}
      {namespace.system ? <span className={BADGE_CLASS}>system</span> : null}
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
 * Manage Shown Schemas (decision 117): which of the datasource's top-level namespaces the Database
 * pane lists. `selected` null is "All schemas", the absent list that also shows ones made later.
 * Focus starts in the search field; ↓ walks into the list, Space ticks, Enter is OK, Esc cancels.
 */
function Editor({ view }: { readonly view: DatasourceView }) {
  const hide = useManageShownSchemasDialog((state) => state.hide);
  const catalog = useCatalog((state) => state.catalogs[view.id] ?? EMPTY_CATALOG);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(
    view.shownNamespaces === undefined ? null : new Set(view.shownNamespaces),
  );
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const current = useCatalog.getState().catalogs[view.id] ?? EMPTY_CATALOG;
    if (current.namespaces === null && !current.loading) void useCatalog.getState().synchronize(view.id, null);
  }, [view.id]);

  const namespaces = useMemo(
    () => (catalog.namespaces === null ? [] : topLevelNamespaces(catalog.namespaces)),
    [catalog.namespaces],
  );
  const noun = namespaceNoun(namespaces);
  const visible = matchingNamespaces(namespaces, query);
  const visibleNames = visible.map((namespace) => namespace.name);
  const filtered = query.trim() !== "";
  const all = selected === null;
  const count = selectedCount(namespaces, selected);
  const noneSelected = !all && count === 0;
  const loading = catalog.namespaces === null && catalog.error === null;

  function setAll(on: boolean): void {
    setSelected(on ? null : new Set(namespaces.map((namespace) => namespace.name)));
  }

  function setVisible(on: boolean): void {
    setSelected((current) => withNames(current ?? new Set(), visibleNames, on));
  }

  async function save(): Promise<void> {
    setSaving(true);
    const saved = await setShownNamespaces(view, selected === null ? undefined : [...selected]);
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
      <Dialog.Title className="shrink-0 border-b border-line px-gap py-cell font-semibold">
        Manage Shown Schemas — {view.name}
      </Dialog.Title>
      <div className="flex min-h-0 flex-1 flex-col gap-cell p-gap">
        <div className="flex h-row items-center gap-cell rounded border border-line bg-canvas px-cell focus-within:border-accent">
          <SearchIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
          <input
            ref={search}
            id={SEARCH_FIELD_ID}
            aria-label="Search schemas"
            placeholder={`Search ${noun}`}
            autoFocus
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {filtered ? (
            <span className="shrink-0 text-ink-muted tabular-nums">
              {String(visible.length)} of {String(namespaces.length)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-cell">
          <div className="flex-1">
            <Check label="All schemas" checked={all} onChange={setAll} />
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
            ? `The tree lists every one, including ${noun} created later. Untick All schemas to pick.`
            : `The tree lists only the ticked ${noun}; ones created later stay hidden.`}
        </p>
        <ul
          ref={list}
          aria-label="Schemas"
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
          {catalog.error === null ? null : (
            <ListNote alert>
              <span>{catalog.error.message}</span>
              <span className="text-ink-muted">{catalog.error.hint}</span>
            </ListNote>
          )}
          {!loading && catalog.error === null && namespaces.length === 0 ? (
            <ListNote>This data source has no {noun} to list.</ListNote>
          ) : null}
          {filtered && namespaces.length > 0 && visible.length === 0 ? (
            <ListNote>
              No {noun} match “{query.trim()}”.
            </ListNote>
          ) : null}
          {visible.map((namespace) => (
            <Row
              key={namespace.name}
              namespace={namespace}
              query={query}
              all={all}
              checked={all || selected.has(namespace.name)}
              onToggle={(on) => setSelected((current) => withNames(current ?? new Set(), [namespace.name], on))}
            />
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-gap border-t border-line p-gap">
        <span aria-live="polite" className="flex-1">
          {noneSelected ? (
            <span className="text-danger">Pick at least one, or turn on All schemas.</span>
          ) : (
            <span data-testid="shown-schemas-count" className="text-ink-muted tabular-nums">
              {all
                ? `All ${String(namespaces.length)} shown`
                : `${String(count)} of ${String(namespaces.length)} shown`}
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

export function ManageShownSchemasDialog() {
  const datasourceId = useManageShownSchemasDialog((state) => state.datasourceId);
  const session = useManageShownSchemasDialog((state) => state.session);
  const view = useDatasources((state) =>
    datasourceId === null ? undefined : state.datasources.find((datasource) => datasource.id === datasourceId),
  );
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
          {view === undefined ? null : <Editor key={session} view={view} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
