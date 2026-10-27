import type { ConsolesState } from "@table-craft/desktop/renderer/state/consoles.js";

interface JumpTarget {
  readonly length: number;
  readonly select: (anchor: number) => void;
  readonly focus: () => void;
}

export function applyEditorJump(
  target: JumpTarget,
  id: string,
  consoles: Pick<ConsolesState, "consoles" | "jumped">,
  focused: boolean,
): void {
  const jump = consoles.consoles[id]?.jump;
  if (jump === undefined || jump === null) return;
  target.select(Math.min(jump.from, target.length));
  consoles.jumped(id, jump.seq);
  if (focused) target.focus();
}
