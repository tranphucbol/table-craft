import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_EDIT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyEditActions.js";
import {
  keyDeleteText,
  type KeyDeleteState,
  type KeyDeleteTask,
} from "@table-craft/desktop/renderer/state/keyDeletes.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { DeleteIcon } from "@table-craft/desktop/renderer/ui/icons.js";

const STATE_TEXT: Readonly<Record<KeyDeleteState, string>> = {
  running: "deleting",
  completed: "done",
  cancelled: "cancelled",
  failed: "failed",
};

/** What a key deletion's line offers: Cancel while it runs, Remove after. */
export function keyDeleteActionsOf(task: KeyDeleteTask): readonly string[] {
  return task.state === "running" ? [KEY_EDIT_ACTION_IDS.cancelDelete] : [KEY_EDIT_ACTION_IDS.dismissDelete];
}

export function keyDeleteLabel(task: KeyDeleteTask): string {
  return [`${task.prefix}*`, STATE_TEXT[task.state], keyDeleteText(task)].join(", ");
}

export function KeyDeletesLine({ count }: { readonly count: number }) {
  return (
    <>
      <DeleteIcon aria-hidden className="size-icon shrink-0 text-accent" />
      <span className="truncate">Key Deletions</span>
      <span className="text-ink-muted tabular-nums">{count}</span>
    </>
  );
}

/** One Delete Keys Under Folder task (plan 058 decision 17): its folder, state and progress. */
export function KeyDeleteLine({ task }: { readonly task: KeyDeleteTask }) {
  const detail = task.error === null ? `${task.prefix}*` : `${task.error.message}\n${task.error.hint}`;
  return (
    <>
      <span className="min-w-0 truncate font-grid" title={detail}>
        {task.prefix}*
      </span>
      <span className={cn("shrink-0", task.state === "failed" ? "text-danger" : "text-ink-muted")}>
        {STATE_TEXT[task.state]}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-cell text-ink-muted tabular-nums">
        <span data-testid="key-delete-progress">{keyDeleteText(task)}</span>
        {keyDeleteActionsOf(task).map((actionId) => (
          <button
            key={actionId}
            type="button"
            tabIndex={-1}
            data-action={actionId}
            className="rounded px-1 text-accent hover:bg-raised"
            onClick={(event) => {
              event.stopPropagation();
              invoke(actionId, { taskId: task.taskId });
            }}
          >
            {actionId === KEY_EDIT_ACTION_IDS.cancelDelete ? "Cancel" : "Remove"}
          </button>
        ))}
      </span>
    </>
  );
}
