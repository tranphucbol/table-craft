import { useState } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import {
  ValuePanel,
  type ValueFormatChoice,
  type ValueTextEdit,
} from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { bufferRowAt, pendingInput } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { canEditCell } from "@table-craft/desktop/renderer/model/resultEdits.js";
import { encodeValue, keyBytesOf, type ValueFormat } from "@table-craft/desktop/renderer/model/valueFormats.js";
import { editTargetOf, type ConsoleResultEdits } from "@table-craft/desktop/renderer/state/consoleEdits.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { rowAt, shownHeld, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";

const BINARY_EDIT = "These bytes are not text; edit them in the key tab (Open Key).";

type Cell = { readonly row: number; readonly column: number };

/** The cell's pending text, else the value the result holds; an added row's untouched cell is empty. */
function shownValue(result: ResultTab, edits: ConsoleResultEdits | null, focus: Cell) {
  if (edits === null) return rowAt(result.windows, focus.row)?.[focus.column];
  const row = bufferRowAt(edits.buffer, shownHeld(result), focus.row);
  if (row === null) return undefined;
  const pending = pendingInput(edits.buffer, row, focus.column);
  if (pending !== undefined) return pending.kind === "text" ? pending.text : null;
  return row.kind === "held" ? rowAt(result.windows, focus.row)?.[focus.column] : "";
}

/**
 * The value panel of a key-value datasource's console result (decision 119): the key tab's Format
 * picker, Auto by default, and in an editable whole-key result the value edited in its format.
 */
export function CommandValuePanel({
  consoleId,
  result,
  edits,
  editable,
  format,
  focus,
}: {
  readonly consoleId: string;
  readonly result: ResultTab;
  readonly edits: ConsoleResultEdits | null;
  readonly editable: boolean;
  readonly format: ValueFormat;
  readonly focus: Cell | null;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const choice: ValueFormatChoice = {
    format,
    onChange: (next) => void invoke(KEY_ACTION_IDS.resultValueFormat, { format: next }),
  };
  const column = focus === null ? null : (result.columns[focus.column] ?? null);
  if (focus === null) return <ValuePanel column={column} value={undefined} format={choice} />;
  const value = shownValue(result, edits, focus);
  const editsCell = edits !== null && editable && canEditCell(editTargetOf(result, edits), focus);
  const edit: ValueTextEdit | undefined = editsCell
    ? {
        revision: `${result.handle}:${String(focus.row)}:${String(focus.column)}`,
        problem,
        onChange: (text, concrete) => {
          const encoded = encodeValue(text, concrete);
          const bytes = encoded.ok ? keyBytesOf(encoded.bytes) : null;
          if (!encoded.ok || bytes === null || bytes.hex !== null) {
            setProblem(encoded.ok ? BINARY_EDIT : encoded.error);
            return;
          }
          setProblem(null);
          useConsoles.getState().editPanel(consoleId, result.id, focus, bytes.text);
        },
      }
    : undefined;
  return <ValuePanel column={column} value={value} format={choice} edit={edit} />;
}
