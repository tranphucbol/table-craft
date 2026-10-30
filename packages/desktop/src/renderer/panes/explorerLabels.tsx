import type { ReactNode } from "react";
import { GROUP_LABELS, type ExplorerNode, type ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { keyIdentity, ROOT_KEY, ttlText } from "@table-craft/desktop/renderer/model/keyTree.js";
import { KeyTreeContent, KeyTreeMetadata } from "@table-craft/desktop/renderer/panes/KeyTreeMetadata.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { KeyTypeBadge, keyTypeLabel } from "@table-craft/desktop/renderer/ui/KeyTypeBadge.js";
import {
  ColumnIcon,
  DatabaseIcon,
  FolderIcon,
  IndexIcon,
  KeyFilterIcon,
  KeyIcon,
  ReadOnlyIcon,
  ServerNodeIcon,
  MaterializedViewIcon,
  NotNullIcon,
  RoutineIcon,
  SchemaIcon,
  SequenceIcon,
  SpinnerIcon,
  TableIcon,
  ViewIcon,
  WarningIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";

const ICON_CLASS = "size-icon shrink-0";
/** The name keeps its width and the detail after it gives way, as DataGrip truncates a long type. */
const NAME_CLASS = "max-w-full shrink-0 truncate";

/** `label` with the characters at `positions` marked, as speed search shows a match. */
export function Highlighted({ text, positions }: { readonly text: string; readonly positions: readonly number[] }) {
  if (positions.length === 0) return <span className={NAME_CLASS}>{text}</span>;
  const marked = new Set(positions);
  const parts: ReactNode[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index < text.length && marked.has(index) === marked.has(start)) continue;
    const piece = text.slice(start, index);
    parts.push(
      marked.has(start) ? (
        <mark key={start} data-match className="rounded-sm bg-search-match text-ink">
          {piece}
        </mark>
      ) : (
        <span key={start}>{piece}</span>
      ),
    );
    start = index;
  }
  return <span className={NAME_CLASS}>{parts}</span>;
}

export function EscapedKeyName({ text, positions }: { readonly text: string; readonly positions: readonly number[] }) {
  const parts = text.split(/(\\x[\da-f]{2})/gi);
  const starts = parts.reduce<number[]>(
    (offsets, part, index) => [...offsets, (offsets[index] ?? 0) + part.length],
    [0],
  );
  return (
    <span className={NAME_CLASS}>
      {parts.map((part, index) => {
        const start = starts[index] ?? 0;
        const at = start + part.length;
        return (
          <span key={index} className={/^\\x[\da-f]{2}$/i.test(part) ? "text-ink-muted" : undefined}>
            <Highlighted
              text={part}
              positions={positions
                .filter((position) => position >= start && position < at)
                .map((position) => position - start)}
            />
          </span>
        );
      })}
    </span>
  );
}

function Detail({ children }: { readonly children: ReactNode }) {
  return <span className="min-w-0 truncate text-ink-muted">{children}</span>;
}

function columnList(columns: readonly string[]): string {
  return `(${columns.join(", ")})`;
}

/** The glyph a catalog row starts with. */
export function NodeIcon({ node }: { readonly node: ExplorerNode }) {
  switch (node.kind) {
    case "namespace": {
      const failed = node.state?.error != null;
      const Glyph = node.namespace.kind === "database" ? DatabaseIcon : SchemaIcon;
      return <Glyph aria-hidden className={cn(ICON_CLASS, failed ? "text-danger" : "text-ink-muted")} />;
    }
    case "objectGroup":
    case "relationGroup":
      return <FolderIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "relation": {
      const Glyph =
        node.relation.kind === "view"
          ? ViewIcon
          : node.relation.kind === "materializedView"
            ? MaterializedViewIcon
            : TableIcon;
      return <Glyph aria-hidden className={cn(ICON_CLASS, "text-accent")} />;
    }
    case "column":
      if (node.primary) return <KeyIcon aria-label="primary key" className={cn(ICON_CLASS, "text-key-icon")} />;
      if (node.foreign) return <KeyIcon aria-label="foreign key" className={cn(ICON_CLASS, "text-accent")} />;
      return <ColumnIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "key":
      return <KeyIcon aria-hidden className={cn(ICON_CLASS, "text-key-icon")} />;
    case "foreignKey":
      return <KeyIcon aria-hidden className={cn(ICON_CLASS, "text-accent")} />;
    case "index":
      return <IndexIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "routine":
      return <RoutineIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "sequence":
      return <SequenceIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "loading":
      return <SpinnerIcon aria-hidden className={cn(ICON_CLASS, "animate-spin text-ink-muted")} />;
    case "error":
      return <WarningIcon aria-hidden className={cn(ICON_CLASS, "text-danger")} />;
    case "keyDatabase":
      return <DatabaseIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "keyFolder":
      if (node.accessError !== undefined)
        return <ReadOnlyIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
      return <FolderIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "clusterNodes":
      return <FolderIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "keyEntry":
      return node.serverChildren === true ? <KeyTreeContent node={node} /> : <KeyTypeBadge info={node.info} />;
    case "keyFilter":
      return <KeyFilterIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    case "clusterNode":
      return <ServerNodeIcon aria-hidden className={cn(ICON_CLASS, "text-ink-muted")} />;
    default:
      return null;
  }
}

function keyCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "key" : "keys"}`;
}

/** What a catalog row shows after its name: a count, a type, the columns a key covers. */
export function NodeDetail({ node }: { readonly node: ExplorerNode }) {
  switch (node.kind) {
    case "namespace":
      return node.state?.loading === true && node.state.described !== null ? (
        <SpinnerIcon aria-label="synchronizing" className={cn(ICON_CLASS, "animate-spin text-ink-muted")} />
      ) : null;
    case "objectGroup":
    case "relationGroup":
      return <Detail>{node.count}</Detail>;
    case "column":
      return (
        <>
          <Detail>{node.column.type}</Detail>
          {node.column.nullable ? null : (
            <NotNullIcon aria-label="not null" className="size-3 shrink-0 text-ink-muted" />
          )}
        </>
      );
    case "key":
      return <Detail>{columnList(node.key.columns)}</Detail>;
    case "foreignKey":
      return (
        <Detail>
          {`${columnList(node.foreignKey.columns)} → ${node.foreignKey.target.relation}${columnList(node.foreignKey.target.columns)}`}
        </Detail>
      );
    case "index":
      return <Detail>{`${columnList(node.index.columns)}${node.index.unique ? " unique" : ""}`}</Detail>;
    case "routine":
      return <Detail>{routineArguments(node.routine.signature)}</Detail>;
    case "error":
      return <Detail>{node.error.hint}</Detail>;
    case "keyDatabase":
      return node.keys.folders === undefined ? (
        <Detail>{keyCount(node.summary.keys)}</Detail>
      ) : (
        <Detail>
          {node.keys.folders[keyIdentity(ROOT_KEY)]?.revision == null
            ? ""
            : `rev ${node.keys.folders[keyIdentity(ROOT_KEY)]?.revision}`}
        </Detail>
      );
    case "keyFolder":
      if (node.accessError !== undefined) return <Detail>no access</Detail>;
      return node.key === undefined ? (
        <Detail>{node.count.toLocaleString("en-US")}</Detail>
      ) : node.exactCount == null ? null : (
        <span className="text-ink-muted tabular-nums" title={exactKeys(node.exactCount)}>
          {BigInt(node.exactCount) > 100_000n
            ? `${BigInt(node.exactCount) / 1000n} k`
            : BigInt(node.exactCount).toLocaleString("en-US")}
        </span>
      );
    case "clusterNodes":
      return <Detail>{node.count.toLocaleString("en-US")}</Detail>;
    case "keyEntry":
      return node.serverChildren === true ? (
        <KeyTreeMetadata node={node} />
      ) : node.info === null ? null : (
        <Detail>{ttlText(node.info.ttlMs)}</Detail>
      );
    default:
      return null;
  }
}

/** The row's name as shown; groups show their word, the loading row its ellipsis. */
export function nodeText(row: ExplorerRow): string {
  const { node } = row;
  if (node.kind === "objectGroup" || node.kind === "relationGroup") return GROUP_LABELS[node.group];
  if (node.kind === "loading") return "loading…";
  return row.label;
}

/** The row's accessible name: its text and detail, then a state worth hearing. */
/** An exact decimal key count, singular for one. */
function exactKeys(count: string): string {
  return `${count} ${count === "1" ? "key" : "keys"}`;
}

export function nodeAriaLabel(row: ExplorerRow): string {
  const { node } = row;
  const text = nodeText(row);
  switch (node.kind) {
    case "namespace":
      if (node.state?.error != null) return `${text}, failed`;
      return node.state?.loading === true ? `${text}, loading` : text;
    case "objectGroup":
    case "relationGroup":
      return `${text} ${String(node.count)}`;
    case "column":
      return `${text} ${node.column.type}${node.primary ? ", primary key" : ""}${node.foreign ? ", foreign key" : ""}${node.column.nullable ? "" : ", not null"}`;
    case "routine":
      return `${text} ${routineArguments(node.routine.signature)}`;
    case "keyDatabase":
      return node.keys.folders === undefined ? `${text} ${keyCount(node.summary.keys)}` : text;
    case "keyFolder":
      if (node.accessError !== undefined) return `${text}, folder, no access`;
      return node.key === undefined
        ? `${text} ${String(node.count)}`
        : `${text}, folder${node.exactCount == null ? "" : `, ${exactKeys(node.exactCount)}`}`;
    case "keyEntry":
      if (node.serverChildren === true)
        return `${text}, key${node.revision === undefined ? "" : `, version ${node.revision.version}${node.revision.lease === "0" ? "" : `, lease ${node.revision.lease}`}`}`;
      return node.info === null ? text : `${keyTypeLabel(node.info)} ${text}, ${ttlText(node.info.ttlMs)}`;
    default:
      return text;
  }
}

/** A tooltip: an error's message then what to do, a comment, or what a routine returns. */
export function nodeTitle(node: ExplorerNode): string | undefined {
  if (node.kind === "error") return `${node.error.message} ${node.error.hint}`;
  if (node.kind === "namespace" && node.state?.error != null)
    return `${node.state.error.message} ${node.state.error.hint}`;
  if (node.kind === "relation") return node.relation.comment ?? undefined;
  if (node.kind === "column") return node.column.comment ?? undefined;
  if (node.kind === "routine") return node.routine.returns === null ? "procedure" : `returns ${node.routine.returns}`;
  if (node.kind === "keyFolder")
    return node.accessError === undefined
      ? `${node.prefix}${node.exactCount == null ? "" : ` · ${exactKeys(node.exactCount)}`}`
      : `${node.accessError.message} ${node.accessError.hint}`;
  if (node.kind === "keyEntry") return `${node.key.text}${node.key.hex === null ? "" : ` · Hex: ${node.key.hex}`}`;
  return undefined;
}

/** A routine's arguments as its row shows them, so overloads read apart. */
export function routineArguments(signature: string): string {
  return `(${signature})`;
}
