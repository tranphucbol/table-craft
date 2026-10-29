import type { KeyInfo, KeyType } from "@table-craft/desktop/engine/protocol.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/** A key type's badge (decision 113): the datasource tint palette, never new tokens. */
const BADGES: Readonly<Record<KeyType, { readonly label: string; readonly className: string }>> = {
  string: { label: "STR", className: "bg-ds-green" },
  hash: { label: "HASH", className: "bg-ds-blue" },
  list: { label: "LIST", className: "bg-ds-orange" },
  set: { label: "SET", className: "bg-ds-red" },
  zset: { label: "ZSET", className: "bg-ds-violet" },
  stream: { label: "STRM", className: "bg-ds-yellow" },
  json: { label: "JSON", className: "bg-ink-muted" },
  other: { label: "", className: "bg-ink-muted" },
};

const OTHER_LABEL_LENGTH = 4;
const NO_BREAK_SPACE = "\u00a0";

/**
 * Labels are capitals only, so a normal line box leaves the descender gap under them and the
 * text sits high; trimming the box to cap height and baseline centres it between equal padding.
 */
export const CAP_CENTRED = "py-1 leading-none [text-box:trim-both_cap_alphabetic]";

/** The badge's text: the type's short name, or an unknown type's own, cut to four letters. */
export function keyTypeLabel(info: Pick<KeyInfo, "type" | "typeName">): string {
  if (info.type === null) return "";
  if (info.type !== "other") return BADGES[info.type].label;
  return (info.typeName ?? "?").slice(0, OTHER_LABEL_LENGTH).toUpperCase();
}

/** `HASH` on blue and the like; an empty slot of the same width until the key is described. */
export function KeyTypeBadge({ info }: { readonly info: Pick<KeyInfo, "type" | "typeName"> | null }) {
  const label = info === null ? "" : keyTypeLabel(info);
  return (
    <span
      data-key-type={info?.type ?? undefined}
      className={cn(
        "inline-block w-9 shrink-0 rounded-sm text-center font-mono font-semibold text-canvas",
        CAP_CENTRED,
        info?.type == null ? "invisible" : BADGES[info.type].className,
      )}
    >
      {label === "" ? NO_BREAK_SPACE : label}
    </span>
  );
}
