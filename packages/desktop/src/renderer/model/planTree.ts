import type { ExplainedPlan, PlanNode } from "@table-craft/desktop/engine/protocol.js";

/** One line of the plan's tree-table (plan 012 decision 11). */
export interface PlanRow {
  /** The node's path from its root, `0.1.2`; stable while the plan is. */
  readonly key: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly node: PlanNode;
  readonly hasChildren: boolean;
  /**
   * The node's share of its root's cost, or of its root's time when analysed, 0 to 1; null when
   * either is unknown or the root's is zero, so no bar is drawn.
   */
  readonly share: number | null;
}

const PATH_SEPARATOR = ".";

function measureOf(node: PlanNode, analyzed: boolean): number | null {
  return analyzed ? node.actualTimeMs : node.estimatedCost;
}

function shareOf(value: number | null, whole: number | null): number | null {
  if (value === null || whole === null || whole <= 0) return null;
  return Math.min(1, Math.max(0, value / whole));
}

/** The plan's lines in display order, skipping the children of collapsed nodes. */
export function planRows(plan: Pick<ExplainedPlan, "roots" | "analyzed">, collapsed: ReadonlySet<string>): PlanRow[] {
  const rows: PlanRow[] = [];
  function visit(node: PlanNode, key: string, parent: string | null, depth: number, whole: number | null): void {
    rows.push({
      key,
      parent,
      depth,
      node,
      hasChildren: node.children.length > 0,
      share: shareOf(measureOf(node, plan.analyzed), whole),
    });
    if (collapsed.has(key)) return;
    node.children.forEach((child, index) =>
      visit(child, `${key}${PATH_SEPARATOR}${String(index)}`, key, depth + 1, whole),
    );
  }
  plan.roots.forEach((root, index) => visit(root, String(index), null, 0, measureOf(root, plan.analyzed)));
  return rows;
}

/** Each distinct warning of the plan once, in tree order: a scan over many partitions warns once. */
export function planWarnings(plan: Pick<ExplainedPlan, "roots">): string[] {
  const warnings = new Set<string>();
  function visit(node: PlanNode): void {
    for (const warning of node.warnings ?? []) warnings.add(warning);
    node.children.forEach(visit);
  }
  plan.roots.forEach(visit);
  return [...warnings];
}

/** The node at `key`, a path `planRows` made. */
export function planNodeAt(plan: Pick<ExplainedPlan, "roots">, key: string | null): PlanNode | null {
  if (key === null) return null;
  const [first, ...rest] = key.split(PATH_SEPARATOR).map(Number);
  let node = first === undefined ? undefined : plan.roots[first];
  for (const index of rest) node = node?.children[index];
  return node ?? null;
}

export interface PlanMove {
  readonly selected: string | null;
  readonly collapsed: readonly string[];
}

/**
 * The Services and Database panes' arrow keys over the plan: ↑ ↓ move, → expands then steps in,
 * ← collapses then steps out, Home and End jump. Null for any other key.
 */
export function movedInPlan(
  rows: readonly PlanRow[],
  selected: string | null,
  collapsed: readonly string[],
  key: string,
): PlanMove | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((row) => row.key === selected);
  const row = rows[at];
  const to = (index: number): PlanMove => ({ selected: rows[index]?.key ?? selected, collapsed });
  switch (key) {
    case "ArrowDown":
      return to(at === -1 ? 0 : Math.min(at + 1, rows.length - 1));
    case "ArrowUp":
      return to(Math.max(at - 1, 0));
    case "Home":
      return to(0);
    case "End":
      return to(rows.length - 1);
    case "ArrowRight":
      if (row === undefined || !row.hasChildren) return { selected, collapsed };
      if (collapsed.includes(row.key)) return { selected, collapsed: collapsed.filter((entry) => entry !== row.key) };
      return to(at + 1);
    case "ArrowLeft":
      if (row === undefined) return { selected, collapsed };
      if (row.hasChildren && !collapsed.includes(row.key)) return { selected, collapsed: [...collapsed, row.key] };
      return { selected: row.parent ?? selected, collapsed };
    default:
      return null;
  }
}

const PLAN_NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

/** A plan cell: `1,204`, `17.39`, `0.036`; empty for null (plan 012 decision 11). */
export function planNumber(value: number | null): string {
  return value === null ? "" : PLAN_NUMBER.format(value);
}
