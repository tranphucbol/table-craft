import * as Dialog from "@radix-ui/react-dialog";
import type { CopyProgressState } from "@table-craft/desktop/renderer/state/modal.js";
import { CONTENT_CLASS, OVERLAY_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { ProgressBar } from "@table-craft/desktop/renderer/ui/ProgressBar.js";

/** Non-dismissable local progress overlay for a running database copy. */
export function CopyProgress({ progress }: { readonly progress: CopyProgressState | null }) {
  const percent =
    progress === null || progress.total <= 0
      ? null
      : Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)));

  return (
    <Dialog.Root open={progress !== null}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          aria-live="polite"
          className={`${CONTENT_CLASS} w-dialog max-w-[95vw]`}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          {progress === null ? null : (
            <div className="flex flex-col gap-gap p-gap">
              <Dialog.Title className="font-semibold wrap-anywhere">{progress.title}</Dialog.Title>
              <p className="text-ink-muted">{progress.phase}</p>
              <ProgressBar percent={percent} className="w-full" />
              <p className="flex justify-between gap-2 text-ink-muted">
                <span>{progress.total > 0 ? `${progress.completed} of ${progress.total} steps` : "Working…"}</span>
                {percent === null ? null : <span>{percent}%</span>}
              </p>
              <p className="wrap-anywhere">{progress.current}</p>
              {progress.rowsCopied === undefined ? null : (
                <p className="text-ink-muted">{progress.rowsCopied.toLocaleString()} rows copied for this table</p>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
