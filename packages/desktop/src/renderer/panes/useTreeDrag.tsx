import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { topmostItems, type ArrangeTree, type TreeItemRef } from "@table-craft/desktop/datasourceTree/arrange.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  DATASOURCE_DRAG_TYPE,
  dropTarget,
  FOLDER_SPRING_OPEN_MS,
  type DropTarget,
} from "@table-craft/desktop/renderer/model/treeDrop.js";
import { rowItem, sameItem, selectedItems } from "@table-craft/desktop/renderer/model/treeSelection.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { treeSelectionOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

/** The drop line's thickness, as `h-0.5` draws it; it centres on the boundary between rows. */
const DROP_LINE_PX = 2;
const DRAG_IMAGE_CLASS = "fixed -top-96 left-0 rounded border border-line bg-raised px-cell py-1 text-ink";

interface TreeDragInput {
  readonly rows: readonly ExplorerRow[];
  readonly tree: ArrangeTree<DatasourceView>;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly rowHeightPx: number;
}

/**
 * Dragging datasources and folders within the Database pane (plan 136): the rows start it, the
 * scroll area takes it, and the target comes from the same `arrange` main runs.
 */
export function useTreeDrag({ rows, tree, scrollRef, rowHeightPx }: TreeDragInput) {
  /** What the drag started here carries; null when none is, so a drop from elsewhere does nothing. */
  const dragging = useRef<readonly TreeItemRef[] | null>(null);
  const spring = useRef<{ readonly path: string; readonly timer: ReturnType<typeof setTimeout> } | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  useEffect(
    () => () => {
      if (spring.current !== null) clearTimeout(spring.current.timer);
    },
    [],
  );

  function stopSpring(): void {
    if (spring.current !== null) clearTimeout(spring.current.timer);
    spring.current = null;
  }

  function endDrag(): void {
    dragging.current = null;
    stopSpring();
    setDrop(null);
  }

  function startDrag(row: ExplorerRow, event: DragEvent<HTMLLIElement>): void {
    const item = rowItem(row);
    if (item === null) return;
    const selected = selectedItems(treeSelectionOf(useDatasources.getState()));
    const items = selected.some((candidate) => sameItem(candidate, item)) ? selected : [item];
    const unsaved = items.some(
      (candidate) =>
        candidate.kind === "datasource" && !tree.datasources.some((datasource) => datasource.id === candidate.id),
    );
    if (unsaved) {
      event.preventDefault();
      return;
    }
    const moving = topmostItems(items, tree.datasources);
    dragging.current = moving;
    event.dataTransfer.setData(DATASOURCE_DRAG_TYPE, JSON.stringify(moving));
    event.dataTransfer.effectAllowed = "move";
    if (moving.length > 1) {
      const image = document.createElement("div");
      image.className = DRAG_IMAGE_CLASS;
      image.textContent = `${String(moving.length)} items`;
      document.body.append(image);
      event.dataTransfer.setDragImage(image, 0, 0);
      // The browser copies the image when the drag starts; it is not needed after this frame.
      requestAnimationFrame(() => image.remove());
    }
  }

  function targetAt(event: DragEvent<HTMLElement>, items: readonly TreeItemRef[]): DropTarget | null {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>("li[data-index]") : null;
    if (element === null) return dropTarget(rows, rows.length, 0, items, tree);
    const rect = element.getBoundingClientRect();
    const fraction = rect.height === 0 ? 0 : (event.clientY - rect.top) / rect.height;
    return dropTarget(rows, Number(element.dataset.index), fraction, items, tree);
  }

  /** Scrolls a row at a time while the pointer is within a row of the pane's top or bottom edge. */
  function edgeScroll(event: DragEvent<HTMLElement>): void {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const rect = scroller.getBoundingClientRect();
    if (event.clientY < rect.top + rowHeightPx) scroller.scrollTop -= rowHeightPx;
    else if (event.clientY > rect.bottom - rowHeightPx) scroller.scrollTop += rowHeightPx;
  }

  /** Opens the collapsed folder a drag rests on, after a pause, so it can drop deeper. */
  function springOpen(target: DropTarget | null): void {
    const row = target?.indicator.kind === "into" ? rows[target.indicator.index] : undefined;
    const path = row?.node.kind === "folder" && row.expandable && !row.expanded ? row.node.path : null;
    if (path === spring.current?.path) return;
    stopSpring();
    if (path === null) return;
    spring.current = {
      path,
      timer: setTimeout(() => {
        spring.current = null;
        useCatalog.getState().expandFolder(path);
      }, FOLDER_SPRING_OPEN_MS),
    };
  }

  const dropHandlers = {
    onDragOver(event: DragEvent<HTMLElement>): void {
      const items = dragging.current;
      if (items === null || !event.dataTransfer.types.includes(DATASOURCE_DRAG_TYPE)) return;
      edgeScroll(event);
      const target = targetAt(event, items);
      springOpen(target);
      if (target !== null) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
      setDrop((previous) => (JSON.stringify(previous) === JSON.stringify(target) ? previous : target));
    },
    onDragLeave(event: DragEvent<HTMLElement>): void {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      stopSpring();
      setDrop(null);
    },
    onDrop(event: DragEvent<HTMLElement>): void {
      const items = dragging.current;
      if (items === null) return;
      event.preventDefault();
      const target = targetAt(event, items);
      endDrag();
      if (target !== null) invoke(ACTION_IDS.moveItems, target.request);
    },
  };

  return { drop, startDrag, endDrag, dropHandlers };
}

/** The line where a drag would land, indented to the depth it lands at. */
export function DropLine({
  drop,
  rowHeightPx,
  totalPx,
  indentPx,
}: {
  readonly drop: DropTarget | null;
  readonly rowHeightPx: number;
  readonly totalPx: number;
  readonly indentPx: number;
}) {
  if (drop?.indicator.kind !== "line") return null;
  const { index, depth } = drop.indicator;
  return (
    <div
      aria-hidden
      data-testid="drop-line"
      className="pointer-events-none absolute right-0 z-10 h-0.5 bg-accent"
      style={{
        top: Math.max(0, Math.min(index * rowHeightPx - DROP_LINE_PX / 2, totalPx - DROP_LINE_PX)),
        left: `calc(var(--spacing-pane-inset) + ${String(depth * indentPx)}px)`,
      }}
    />
  );
}
