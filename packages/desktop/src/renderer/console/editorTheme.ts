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
const FLASH_FADE = "background-color var(--tc-motion-flash) ease-out";
/** Where a failed statement went wrong (decision 082); `errorMarks.ts` draws them. */
export const ERROR_MARK_CLASS = "tc-error-mark";
export const ERROR_GUTTER_CLASS = "tc-error-gutter";
export const ERROR_GUTTER_MARKER_CLASS = "tc-error-gutter-marker";
export const ERROR_TOOLTIP_CLASS = "tc-error-tooltip";
export const ERROR_HINT_CLASS = "tc-error-hint";
/** Live problems' underlines (plan 108 decision 7); an error looks as the server's mark does. */
export const PROBLEM_MARK_CLASSES = {
  error: "tc-problem-error",
  warning: "tc-problem-warning",
  weak: "tc-problem-weak",
} as const;
export const WARNING_GUTTER_MARKER_CLASS = "tc-warning-gutter-marker";
/** The Alt+Enter popup and the problem hover (`intentions.ts`). */
export const INTENTIONS_CLASS = "tc-intentions";
export const INTENTION_CLASS = "tc-intention";
export const INTENTION_GLYPH_CLASS = "tc-intention-glyph";
export const INTENTION_SEPARATOR_CLASS = "tc-intention-separator";
export const INTENTION_EMPTY_CLASS = "tc-intention-empty";
export const PROBLEM_TOOLTIP_CLASS = "tc-problem-tooltip";
export const PROBLEM_MESSAGE_CLASS = "tc-problem-message";
export const PROBLEM_FIX_CLASS = "tc-problem-fix";
export const PROBLEM_CHORD_CLASS = "tc-problem-chord";
const ERROR_UNDERLINE = "underline wavy var(--tc-danger)";
const WARNING_UNDERLINE = "underline wavy var(--tc-warning)";
const WEAK_UNDERLINE = "underline dotted var(--tc-ink-muted)";
const INTENTIONS_MIN_WIDTH = "220px";
const INTENTION_PADDING = "2px var(--tc-cell-padding)";
const INTENTION_SEPARATOR_MARGIN = "2px 0";
const TOOLTIP_ROW_GAP = "2px";
const INTENTION_RADIUS = "3px";
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

type ThemeSpec = Parameters<typeof EditorView.theme>[0];

export const EDITOR_THEME_SPEC: ThemeSpec = {
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
  [`.${PROBLEM_MARK_CLASSES.error}`]: {
    textDecoration: ERROR_UNDERLINE,
    textDecorationSkipInk: "none",
    textUnderlineOffset: ERROR_UNDERLINE_OFFSET,
  },
  [`.${PROBLEM_MARK_CLASSES.warning}`]: {
    textDecoration: WARNING_UNDERLINE,
    textDecorationSkipInk: "none",
    textUnderlineOffset: ERROR_UNDERLINE_OFFSET,
  },
  // The syntax colours sit on spans inside the mark, so the muted ink has to reach them too.
  [`.${PROBLEM_MARK_CLASSES.weak}, .${PROBLEM_MARK_CLASSES.weak} *`]: {
    color: "var(--tc-ink-muted)",
    textDecoration: WEAK_UNDERLINE,
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
  [`.${WARNING_GUTTER_MARKER_CLASS}`]: {
    display: "inline-block",
    width: ERROR_DOT_SIZE,
    height: ERROR_DOT_SIZE,
    borderRadius: "50%",
    backgroundColor: "var(--tc-warning)",
  },
  [`.${PROBLEM_TOOLTIP_CLASS}`]: {
    display: "flex",
    flexDirection: "column",
    gap: TOOLTIP_ROW_GAP,
    maxWidth: ERROR_TOOLTIP_WIDTH,
    padding: PANEL_PADDING,
    fontFamily: "var(--tc-font-ui)",
    fontSize: "var(--tc-font-ui-size)",
  },
  [`.${PROBLEM_MESSAGE_CLASS}`]: { display: "flex", alignItems: "baseline", gap: GLYPH_GAP, whiteSpace: "pre-wrap" },
  [`.${PROBLEM_FIX_CLASS}`]: {
    alignSelf: "flex-start",
    padding: "0",
    border: "none",
    background: "none",
    color: "var(--tc-accent)",
    font: "inherit",
    cursor: "pointer",
  },
  [`.${PROBLEM_FIX_CLASS}:hover`]: { textDecoration: "underline" },
  [`.${PROBLEM_CHORD_CLASS}`]: { marginLeft: GLYPH_GAP, color: "var(--tc-ink-muted)" },
  [`.${INTENTIONS_CLASS}`]: {
    minWidth: INTENTIONS_MIN_WIDTH,
    maxWidth: ERROR_TOOLTIP_WIDTH,
    padding: TOOLTIP_ROW_GAP,
    fontFamily: "var(--tc-font-ui)",
    fontSize: "var(--tc-font-ui-size)",
    outline: "none",
  },
  [`.${INTENTION_CLASS}`]: {
    display: "flex",
    alignItems: "center",
    gap: GLYPH_GAP,
    padding: INTENTION_PADDING,
    borderRadius: INTENTION_RADIUS,
    whiteSpace: "nowrap",
    cursor: "default",
  },
  [`.${INTENTION_CLASS}[aria-selected=true]`]: { backgroundColor: "var(--tc-selection)" },
  [`.${INTENTION_GLYPH_CLASS}`]: { display: "inline-flex", flexShrink: "0" },
  [`.${INTENTION_SEPARATOR_CLASS}`]: { margin: INTENTION_SEPARATOR_MARGIN, borderTop: "1px solid var(--tc-border)" },
  [`.${INTENTION_EMPTY_CLASS}`]: { padding: INTENTION_PADDING, color: "var(--tc-ink-muted)" },
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
    borderRadius: "var(--tc-editor-tooltip-radius)",
    color: "var(--tc-ink)",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--tc-font-editor)",
    fontSize: "var(--tc-font-editor-size)",
    borderRadius: "inherit",
  },
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
  // lang-json tags an object key `propertyName`; SQL leaves it unused.
  { tag: tags.propertyName, color: "var(--tc-syntax-identifier)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--tc-syntax-operator)" },
  { tag: tags.special(tags.name), color: "var(--tc-syntax-variable)" },
]);

export const EDITOR_THEME: Extension = [
  EditorView.theme(EDITOR_THEME_SPEC, { dark: true }),
  syntaxHighlighting(HIGHLIGHT_STYLE),
];
