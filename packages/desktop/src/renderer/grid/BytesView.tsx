import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { CellBytes } from "@table-craft/desktop/engine/protocol.js";
import { GRID_HELPER_ACTION_IDS } from "@table-craft/desktop/renderer/actions/gridHelperActions.js";
import {
  blobLimitBytes,
  imageDataUrl,
  imageOf,
  isWholeBytes,
  type BytesWire,
} from "@table-craft/desktop/renderer/model/binaryCells.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";

/** Reads every byte of the focused cell from the engine; the grid provides it for its value panel. */
export type FocusedBytesReader = ((maxBytes: number) => Promise<CellBytes | null>) | null;

export const FocusedBytes = createContext<FocusedBytesReader>(null);

/** The image the bytes draw, read whole from the engine when the result holds only their first bytes. */
function useImage(value: BytesWire): string | null {
  const read = useContext(FocusedBytes);
  const limitMb = useSettings((state) => state.settings.data.blobLimitMb);
  const held = useMemo(() => imageDataUrl(value), [value]);
  const [fetched, setFetched] = useState<{ readonly value: BytesWire; readonly image: string | null }>();
  useEffect(() => {
    if (imageOf(value.preview) === null || isWholeBytes(value)) return;
    const maxBytes = blobLimitBytes(limitMb);
    if (read === null || value.length > maxBytes) return;
    let current = true;
    void read(maxBytes).then((whole) => {
      if (current) setFetched({ value, image: whole === null ? null : imageDataUrl(whole) });
    });
    return () => {
      current = false;
    };
  }, [read, value, limitMb]);
  return held ?? (fetched?.value === value ? fetched.image : null);
}

/** A binary value in the value panel: the image it draws, its hex, and Save and Load (plan 043). */
export function BytesView({
  value,
  hex,
  note,
}: {
  readonly value: BytesWire;
  readonly hex: string;
  readonly note: string;
}) {
  const image = useImage(value);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-line px-1">
        <ActionButton actionId={GRID_HELPER_ACTION_IDS.saveBytes} compact />
        <ActionButton actionId={GRID_HELPER_ACTION_IDS.loadBytes} compact />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-cell">
        {image === null ? null : (
          <img
            data-testid="value-image"
            src={image}
            alt="Image the value holds"
            className="mb-gap max-w-full border border-line bg-canvas"
          />
        )}
        <pre data-testid="value-bytes" className="whitespace-pre text-ink">
          {hex}
        </pre>
        <p className="pt-gap text-ink-muted">{note}</p>
      </div>
    </div>
  );
}
