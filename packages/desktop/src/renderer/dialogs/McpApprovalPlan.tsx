import { planNumber, planRows, planWarnings, type PlanRow } from "@table-craft/desktop/renderer/model/planTree.js";
import type { ApprovalPlan } from "@table-craft/desktop/renderer/state/approvalPlans.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";

const INDENT_PX = 16;
const EXPANDED = new Set<string>();
const PLANNED_NOTE = "Planned on a session of its own, never analysed; the statement did not run.";

function operationText(row: PlanRow): string {
  return row.node.target === null ? row.node.operation : `${row.node.operation} ${row.node.target}`;
}

function Warnings({ warnings }: { readonly warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul data-testid="mcp-approval-plan-warnings" className="flex flex-col gap-1 border-t border-line p-cell">
      {warnings.map((warning) => (
        <li key={warning} className="flex items-start gap-1 text-warning">
          <WarningIcon aria-hidden weight="fill" className="mt-px size-icon shrink-0" />
          <span className="min-w-0 wrap-anywhere">{warning}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The waiting statement's plan in the approval dialog (decision 130): every step expanded, a step
 * the plugin warned about in amber, and each distinct warning listed once under the tree.
 */
export function McpApprovalPlan({ plan }: { readonly plan: ApprovalPlan | undefined }) {
  if (plan === undefined || plan.state === "explaining") {
    return (
      <p role="status" data-testid="mcp-approval-plan-status" className="p-cell text-ink-muted">
        Explaining…
      </p>
    );
  }
  if (plan.state === "failed") {
    return (
      <p role="alert" data-testid="mcp-approval-plan-status" className="p-cell text-danger">
        {plan.message}
      </p>
    );
  }
  const rows = planRows(plan.plan, EXPANDED);
  const costed = rows.some((row) => row.node.estimatedCost !== null);
  const summary = plan.plan.summary.map((entry) => `${entry.name}: ${entry.value}`);
  return (
    <div data-testid="mcp-approval-plan">
      {rows.length === 0 ? (
        <p className="p-cell text-ink-muted">The database returned no plan nodes.</p>
      ) : (
        <table aria-label="Plan" className="w-full border-collapse font-grid text-grid">
          <thead className="sticky top-0 bg-panel text-ink-muted">
            <tr className="h-row">
              <th className="w-full px-cell text-left font-normal">Operation</th>
              <th className="w-px px-cell text-right font-normal whitespace-nowrap">Rows (est.)</th>
              {costed ? <th className="w-px px-cell text-right font-normal whitespace-nowrap">Cost (est.)</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const warnings = row.node.warnings ?? [];
              const warned = warnings.length > 0;
              return (
                <tr
                  key={row.key}
                  data-testid="mcp-approval-plan-row"
                  data-warned={warned}
                  className={cn("h-row", warned && "text-warning")}
                >
                  <td className="max-w-0 px-cell whitespace-nowrap">
                    <span
                      className="flex min-w-0 items-center gap-1"
                      style={{ paddingLeft: `${String(row.depth * INDENT_PX)}px` }}
                    >
                      {warned ? (
                        <WarningIcon aria-label="Warning" weight="fill" className="size-icon shrink-0" />
                      ) : (
                        <span aria-hidden className="size-icon shrink-0" />
                      )}
                      <span className="min-w-0 truncate" title={[operationText(row), ...warnings].join("\n")}>
                        {row.node.operation}
                        {row.node.target === null ? null : (
                          <span className={warned ? undefined : "text-ink-muted"}> {row.node.target}</span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="px-cell text-right whitespace-nowrap">{planNumber(row.node.estimatedRows)}</td>
                  {costed ? (
                    <td className="px-cell text-right whitespace-nowrap">{planNumber(row.node.estimatedCost)}</td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Warnings warnings={planWarnings(plan.plan)} />
      <p data-testid="mcp-approval-plan-note" className="border-t border-line p-cell text-ink-muted">
        {[PLANNED_NOTE, ...summary].join(" · ")}
      </p>
    </div>
  );
}
