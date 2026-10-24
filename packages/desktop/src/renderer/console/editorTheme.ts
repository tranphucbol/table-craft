import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { COMPLETION_GLYPH_CLASS } from "@table-craft/desktop/renderer/console/completionGlyphs.js";
import {
  SIGNATURE_ACTIVE_CLASS,
  SIGNATURE_HINT_CLASS,
  SIGNATURE_OFF_CLASS,
  SIGNATURE_SUMMARY_CLASS,
} from "@table-craft/desktop/renderer/console/signatureHint.js";

/**
 * The SQL editor's look, every value a `--tc-*` variable `appearance/apply.ts` writes from the
 * design tokens (plan 006 decision 2), so the editor follows the theme without a rebuild.
 */

/** The flashed statement's mark; `Editor.tsx` adds and removes it. */
export const FLASH_CLASS = "tc-statement-flash";
const FLASH_FADE = "background-color 600ms ease-out";
/** Where a failed statement went wrong (decision 082); `errorMarks.ts` draws them. */
export const ERROR_MARK_CLASS = "tc-error-mark";
export const ERROR_GUTTER_CLASS = "tc-error-gutter";
export const ERROR_GUTTER_MARKER_CLASS = "tc-error-gutter-marker";
export const ERROR_TOOLTIP_CLASS = "tc-error-tooltip";
export const ERROR_HINT_CLASS = "tc-error-hint";
const ERROR_UNDERLINE = "underline wavy var(--tc-danger)";
const ERROR_UNDERLINE_OFFSET = "3px";
const ERROR_DOT_SIZE = "7px";
const ERROR_GUTTER_PADDING = "0 2px 0 4px";
const ERROR_TOOLTIP_WIDTH = "480px";
const SELECTION_FILL = "color-mix(in oklab, var(--tc-accent) 35%, transparent)";
const SELECTION_MATCH_FILL = "color-mix(in oklab, var(--tc-accent) 15%, transparent)";
const LINE_HEIGHT = "1.5";
const GUTTER_PADDING = "0 8px 0 12px";
const LINE_PADDING = "0 var(--tc-cell-padding)";
const PANEL_PADDING = "4px var(--tc-cell-padding)";
const GLYPH_GAP = "6px";
/** The parameter hint, wide enough for a long overload on one line. */
const HINT_WIDTH = "480px";
/**
 * The completion's info panel. Wider than the room beside the list, CodeMirror drops it under the
 * selected option, over the options below it.
 */
const INFO_WIDTH = "320px";
/** Tailwind's `font-semibold`, which the rest of the window bolds with. */
const SEMIBOLD = "600";

/**
 * CodeMirror's base theme paints the focused band through this five-class selector; a shorter one
 * loses on specificity whatever its precedence, so the band repeats the shape.
 */
const SELECTION_SELECTOR =
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground";

export const EDITOR_THEME_SPEC = {
  "&": {
    height: "100%",
    backgroundColor: "var(--tc-canvas)",
    color: "var(--tc-ink)",
    fontSize: "var(--tc-font-editor-size)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--tc-font-editor)", lineHeight: LINE_HEIGHT, overflow: "auto" },
  ".cm-content": { caretColor: "var(--tc-ink)" },
  ".cm-line": { padding: LINE_PADDING },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--tc-ink)" },
  ".cm-gutters": {
    backgroundColor: "var(--tc-panel)",
    color: "var(--tc-ink-muted)",
    borderRight: "1px solid var(--tc-border)",
  },
  ".cm-gutterElement": { padding: GUTTER_PADDING },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--tc-ink)" },
  [SELECTION_SELECTOR]: { backgroundColor: SELECTION_FILL },
  ".cm-selectionMatch": { backgroundColor: SELECTION_MATCH_FILL },
  ".cm-searchMatch": { backgroundColor: "var(--tc-search-match)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: SELECTION_FILL },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--tc-syntax-bracket-match)", color: "inherit" },
  "&.cm-focused .cm-nonmatchingBracket": { color: "var(--tc-danger)" },
  [`.${FLASH_CLASS}`]: { backgroundColor: "var(--tc-statement-flash)", transition: FLASH_FADE },
  [`.${ERROR_MARK_CLASS}`]: {
    textDecoration: ERROR_UNDERLINE,
    textDecorationSkipInk: "none",
    textUnderlineOffset: ERROR_UNDERLINE_OFFSET,
  },
  [`.${ERROR_GUTTER_CLASS} .cm-gutterElement`]: { padding: ERROR_GUTTER_PADDING },
  [`.${ERROR_GUTTER_MARKER_CLASS}`]: {
    display: "inline-block",
    width: ERROR_DOT_SIZE,
    height: ERROR_DOT_SIZE,
    borderRadius: "50%",
    backgroundColor: "var(--tc-danger)",
  },
  [`.${ERROR_TOOLTIP_CLASS}`]: {
    maxWidth: ERROR_TOOLTIP_WIDTH,
    padding: PANEL_PADDING,
    fontFamily: "var(--tc-font-ui)",
    fontSize: "var(--tc-font-ui-size)",
    whiteSpace: "pre-wrap",
  },
  [`.${ERROR_HINT_CLASS}`]: { color: "var(--tc-ink-muted)" },
  ".cm-panels": { backgroundColor: "var(--tc-panel)", color: "var(--tc-ink)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--tc-border)" },
  ".cm-search": { padding: PANEL_PADDING, fontFamily: "var(--tc-font-ui)", fontSize: "var(--tc-font-ui-size)" },
  ".cm-textfield": {
    backgroundColor: "var(--tc-canvas)",
    border: "1px solid var(--tc-border)",
    borderRadius: "4px",
    color: "var(--tc-ink)",
  },
  ".cm-button": {
    backgroundColor: "var(--tc-raised)",
    backgroundImage: "none",
    border: "1px solid var(--tc-border)",
    borderRadius: "4px",
    color: "var(--tc-ink)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--tc-raised)",
    border: "1px solid var(--tc-border)",
    color: "var(--tc-ink)",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--tc-font-editor)", fontSize: "var(--tc-font-editor-size)" },
  ".cm-tooltip-autocomplete > ul > li": { display: "flex", alignItems: "center", gap: GLYPH_GAP },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--tc-selection)",
    color: "var(--tc-ink)",
  },
  [`.${COMPLETION_GLYPH_CLASS}`]: { display: "inline-flex", flexShrink: "0" },
  ".cm-completionDetail": { marginLeft: "auto", paddingLeft: "var(--tc-gap)", color: "var(--tc-ink-muted)" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--tc-accent)" },
  ".cm-tooltip.cm-completionInfo": {
    maxWidth: INFO_WIDTH,
    padding: PANEL_PADDING,
    fontFamily: "var(--tc-font-ui)",
    fontSize: "var(--tc-font-ui-size)",
    whiteSpace: "pre-wrap",
  },
  [`.${SIGNATURE_HINT_CLASS}`]: {
    maxWidth: HINT_WIDTH,
    padding: PANEL_PADDING,
    fontFamily: "var(--tc-font-editor)",
    fontSize: "var(--tc-font-editor-size)",
  },
  [`.${SIGNATURE_OFF_CLASS}`]: { color: "var(--tc-ink-muted)" },
  [`.${SIGNATURE_ACTIVE_CLASS}`]: { fontWeight: SEMIBOLD, color: "var(--tc-accent)" },
  [`.${SIGNATURE_SUMMARY_CLASS}`]: {
    marginTop: "var(--tc-cell-padding)",
    fontFamily: "var(--tc-font-ui)",
    fontSize: "var(--tc-font-ui-size)",
    color: "var(--tc-ink-muted)",
    whiteSpace: "pre-wrap",
  },
};

const HIGHLIGHT_STYLE = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.bool, tags.null], color: "var(--tc-syntax-keyword)" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "var(--tc-syntax-keyword)" },
  { tag: tags.string, color: "var(--tc-syntax-string)" },
  { tag: tags.number, color: "var(--tc-syntax-number)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--tc-syntax-comment)", fontStyle: "italic" },
  // lang-sql tags a quoted identifier `special(string)` and a bind variable `special(name)`.
  { tag: tags.special(tags.string), color: "var(--tc-syntax-identifier)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--tc-syntax-operator)" },
  { tag: tags.special(tags.name), color: "var(--tc-syntax-variable)" },
]);

export const EDITOR_THEME: Extension = [
  EditorView.theme(EDITOR_THEME_SPEC, { dark: true }),
  syntaxHighlighting(HIGHLIGHT_STYLE),
];
