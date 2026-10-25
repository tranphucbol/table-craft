import type { Icon } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProblemSeverity } from "@table-craft/desktop/engine/protocol.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { DisableInspectionIcon, QuickFixIcon, SuppressIcon } from "@table-craft/desktop/renderer/ui/icons.js";

/** A row of the Alt+Enter popup: a bulb in its problem's colour, as DataGrip's, or a muted glyph. */
export type IntentionGlyph = `fix-${ProblemSeverity}` | "suppress" | "disable";

const GLYPHS: Readonly<Record<IntentionGlyph, { readonly glyph: Icon; readonly tone: string }>> = {
  "fix-error": { glyph: QuickFixIcon, tone: "text-danger" },
  "fix-warning": { glyph: QuickFixIcon, tone: "text-warning" },
  "fix-weak": { glyph: QuickFixIcon, tone: "text-warning" },
  suppress: { glyph: SuppressIcon, tone: "text-ink-muted" },
  disable: { glyph: DisableInspectionIcon, tone: "text-ink-muted" },
};

const FIX_PREFIX = "fix-";
const markup = new Map<IntentionGlyph, string>();

/** The SVG for `glyph`, rendered once. */
export function intentionGlyphMarkup(glyph: IntentionGlyph): string {
  const cached = markup.get(glyph);
  if (cached !== undefined) return cached;
  const { glyph: Glyph, tone } = GLYPHS[glyph];
  const weight = glyph.startsWith(FIX_PREFIX) ? "fill" : "regular";
  const html = renderToStaticMarkup(<Glyph aria-hidden weight={weight} className={cn("size-icon shrink-0", tone)} />);
  markup.set(glyph, html);
  return html;
}
