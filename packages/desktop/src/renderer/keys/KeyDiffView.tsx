import { useMemo } from "react";
import type { KeyBytes } from "@table-craft/desktop/engine/protocol.js";
import { alignDiff, diffText, keyDiff, type DiffPair } from "@table-craft/desktop/renderer/model/keyDiff.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const FOLD_LINES = 3;

function DiffRow({ pair }: { readonly pair: DiffPair }) {
  const { left, right } = pair;
  const same = left?.kind === "same";
  return (
    <div className="grid grid-cols-2 font-editor text-editor @max-4xl:grid-cols-1">
      <pre
        className={cn(
          "min-w-0 overflow-hidden px-cell whitespace-pre-wrap break-all",
          left?.kind === "delete" && "bg-edit-deleted",
          left === null && "bg-raised @max-4xl:hidden",
        )}
      >
        {left === null ? " " : `${same ? " " : "−"} ${String(left.left ?? "")}  ${left.text}`}
      </pre>
      <pre
        className={cn(
          "min-w-0 overflow-hidden border-l border-line px-cell whitespace-pre-wrap break-all",
          right?.kind === "insert" && "bg-edit-inserted",
          right === null && "bg-raised @max-4xl:hidden",
          same && "@max-4xl:hidden",
        )}
      >
        {right === null ? " " : `${same ? " " : "+"} ${String(right.right ?? "")}  ${right.text}`}
      </pre>
    </div>
  );
}

/** Side-by-side actual line changes; long identical runs fold without losing either value. */
export function KeyDiffView({
  before,
  after,
  leftTitle,
  rightTitle,
}: {
  readonly before: KeyBytes | null;
  readonly after: KeyBytes | null;
  readonly leftTitle: string;
  readonly rightTitle: string;
}) {
  const groups = useMemo(() => {
    const lines = alignDiff(keyDiff(diffText(before), diffText(after)));
    const result: DiffPair[][] = [];
    for (const line of lines) {
      const last = result.at(-1);
      if (last !== undefined && (last[0]?.left?.kind === "same") === (line.left?.kind === "same")) last.push(line);
      else result.push([line]);
    }
    return result;
  }, [before, after]);
  return (
    <section
      aria-label="Value comparison"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col bg-canvas text-ink"
    >
      <div className="grid shrink-0 grid-cols-2 border-b border-line bg-panel text-ink-muted">
        <h3 className="truncate px-gap py-1">{leftTitle}</h3>
        <h3 className="truncate border-l border-line px-gap py-1">{rightTitle}</h3>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {groups.map((lines, index) =>
          lines[0]?.left?.kind === "same" && lines.length >= FOLD_LINES ? (
            <details key={index} className="text-ink-muted">
              <summary className="cursor-pointer bg-panel px-gap py-1 hover:bg-raised">
                ⋯ {lines.length} unchanged lines
              </summary>
              {lines.map((pair, row) => (
                <DiffRow key={row} pair={pair} />
              ))}
            </details>
          ) : (
            <div key={index}>
              {lines.map((pair, row) => (
                <DiffRow key={row} pair={pair} />
              ))}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
