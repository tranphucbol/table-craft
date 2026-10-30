# Design system

Every colour, spacing step, radius and font in the renderer is a token, written as a CSS variable
by `renderer/appearance/apply.ts` from the active theme, font settings and density (decision 012).
Components reference tokens, never literals.

The token types, the three built-in themes, both densities and the contrast pairs are pure data in
`packages/desktop/src/appearance/themes.ts` (the pairs in `contrast.ts`, the 43 ported themes
generated into `themes/`), imported by main (the window's first paint) and by the
renderer (`renderer/appearance/tokens.ts` re-exports it). The sections after this one name the
tokens each feature draws from; this one lists them all.

## Themes

Plan 013. Settings → Appearance chooses one of:

| Choice         | `settings.json` `theme`       | Colours                                                                                                               | `color-scheme` |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| Follow system  | `"system"` (default)          | High contrast when `prefers-contrast: more`, else Dark or Light from `prefers-color-scheme`, followed live            | as resolved    |
| Dark           | `"dark"`                      | Darcula-like                                                                                                          | dark           |
| Light          | `"light"`                     | IntelliJ Light-like                                                                                                   | light          |
| High contrast  | `"highContrast"`              | Black, white ink, saturated accents                                                                                   | dark           |
| A ported theme | its id, e.g. `"gruvbox-dark"` | Generated from a vendored palette (plan 032, decision 064); README lists them                                         | the palette's  |
| A user theme   | `"user:<file stem>"`          | `<userData>/themes/<stem>.json`: `{ name, base, colors }`, colour tokens over any bundled base; fonts and density not | its base's     |

Plan 032 ported 43 themes from preman (decision 064): `scripts/generate-themes.ts` reads each
palette in `packages/desktop/scripts/palettes/`, maps it onto the tokens below, solves the colours a
palette does not have (`gridNull`, the edit and match tints behind `ink`, the six datasource tints),
raises any colour short of its contrast pair, and refuses to write a theme that fails the audit
below or whose datasource tints sit closer than 0.08 OKLab apart or under 3:1 on `panel`. The
output is committed, one module per theme with its `source` and `licence`; a test reruns the
generator and expects the same bytes. `palettes/overrides.json` pins a token by hand and is empty.

A user theme's colours are `#rgb`, `#rrggbb` or `#rrggbbaa`; `colors` may hold any token below,
with `syntax` and `datasource` partial objects. Main validates each file (at most 64 files of at
most 64 KiB) and lists a broken one with its errors; it cannot be chosen. A chosen theme that is
gone or broken falls back to Dark with a notice in the Database pane. Contrast is not enforced on
user themes. `color-scheme` drives native form controls, and main sets
`nativeTheme.themeSource` and the window's `backgroundColor` to match. Scrollbars take the theme
too: `app.css` sets `scrollbar-color` on the root to `inkMuted` at 45% over a transparent track,
so every scroller, the editor's included, follows a theme switch with no token of its own.

| Token (`appearance/themes.ts`) | CSS variable                | Dark      | Light     | High contrast |
| ------------------------------ | --------------------------- | --------- | --------- | ------------- |
| `colors.canvas`                | `--tc-canvas`               | `#1e1f22` | `#ffffff` | `#000000`     |
| `colors.panel`                 | `--tc-panel`                | `#2b2d30` | `#f7f8fa` | `#0a0a0a`     |
| `colors.raised`                | `--tc-raised`               | `#393b40` | `#ebecf0` | `#1c1c1c`     |
| `colors.border`                | `--tc-border`               | `#43454a` | `#d3d5db` | `#b0b0b0`     |
| `colors.ink`                   | `--tc-ink`                  | `#dfe1e5` | `#1f2023` | `#ffffff`     |
| `colors.inkMuted`              | `--tc-ink-muted`            | `#a6a9b1` | `#5a5d6b` | `#d4d4d4`     |
| `colors.accent`                | `--tc-accent`               | `#78a6fb` | `#2b63d9` | `#66b2ff`     |
| `colors.accentInk`             | `--tc-accent-ink`           | `#1e1f22` | `#ffffff` | `#000000`     |
| `colors.danger`                | `--tc-danger`               | `#fa6675` | `#c7222d` | `#ff7070`     |
| `colors.success`               | `--tc-success`              | `#5fb865` | `#1f7a35` | `#5bf15b`     |
| `colors.warning`               | `--tc-warning`              | `#e0a84a` | `#8a5a00` | `#ffd23f`     |
| `colors.selection`             | `--tc-selection`            | `#2e436e` | `#dfe1e5` | `#1f3a66`     |
| `colors.searchMatch`           | `--tc-search-match`         | `#6b5a1e` | `#f6e39a` | `#6b5a00`     |
| `colors.keyIcon`               | `--tc-key-icon`             | `#d9a343` | `#b07d14` | `#ffd23f`     |
| `colors.gridStripe`            | `--tc-grid-stripe`          | `#26282b` | `#f5f6f8` | `#0f0f0f`     |
| `colors.gridSelection`         | `--tc-grid-selection`       | `#214283` | `#c9dafc` | `#0f3d8c`     |
| `colors.gridNull`              | `--tc-grid-null`            | `#868a91` | `#6f737a` | `#c4c4c4`     |
| `colors.editModified`          | `--tc-edit-modified`        | `#2f4a6b` | `#dce8fc` | `#12305c`     |
| `colors.editInserted`          | `--tc-edit-inserted`        | `#2f4d34` | `#dcf2df` | `#0f3d16`     |
| `colors.editDeleted`           | `--tc-edit-deleted`         | `#4d2f33` | `#fbe0e2` | `#4a1015`     |
| `colors.statementFlash`        | `--tc-statement-flash`      | `#3d4a2e` | `#e1f1d3` | `#2b4a10`     |
| `colors.planBar`               | `--tc-plan-bar`             | `#4f80c9` | `#4a7fe0` | `#66b2ff`     |
| `colors.analysedBanner`        | `--tc-analysed-banner`      | `#4a3d22` | `#faecd0` | `#4a3a00`     |
| `colors.syntax.keyword`        | `--tc-syntax-keyword`       | `#cf8e6d` | `#0033b3` | `#ff9e5e`     |
| `colors.syntax.string`         | `--tc-syntax-string`        | `#6aab73` | `#067d17` | `#6ee26e`     |
| `colors.syntax.number`         | `--tc-syntax-number`        | `#2aacb8` | `#1750eb` | `#4de0f0`     |
| `colors.syntax.comment`        | `--tc-syntax-comment`       | `#868a91` | `#6f737a` | `#c4c4c4`     |
| `colors.syntax.identifier`     | `--tc-syntax-identifier`    | `#c77dbb` | `#871094` | `#ff8cf0`     |
| `colors.syntax.operator`       | `--tc-syntax-operator`      | `#bcbec4` | `#080808` | `#ffffff`     |
| `colors.syntax.variable`       | `--tc-syntax-variable`      | `#56a8f5` | `#9e5a00` | `#7cc4ff`     |
| `colors.syntax.bracketMatch`   | `--tc-syntax-bracket-match` | `#43454a` | `#d3e1fb` | `#3b3b3b`     |
| `colors.datasource.red`        | `--tc-ds-red`               | `#c75450` | `#e05a55` | `#ff5c5c`     |
| `colors.datasource.orange`     | `--tc-ds-orange`            | `#d08b46` | `#e08a3e` | `#ff9f40`     |
| `colors.datasource.yellow`     | `--tc-ds-yellow`            | `#c9ae4a` | `#d4b032` | `#ffe04d`     |
| `colors.datasource.green`      | `--tc-ds-green`             | `#5e9f62` | `#4e9a55` | `#4dd65a`     |
| `colors.datasource.blue`       | `--tc-ds-blue`              | `#4f80c9` | `#4a7fe0` | `#4da6ff`     |
| `colors.datasource.violet`     | `--tc-ds-violet`            | `#9670c7` | `#9a6fd1` | `#c78bff`     |

Dark's `accent` is a light blue with dark `accentInk` on it: `accent` is both link text on
`raised` and the primary button's fill, and no blue reaches 4.5:1 for text on `#393b40` and for
white text on itself at once.

## Contrast

`test/appearance/themes.test.ts` measures every pair below in every bundled theme with the WCAG
2.1 ratio (`contrastRatio`), against `requiredContrast` for the theme's `contrast` level: at `aa`
(Dark, Light and every ported theme) 4.5:1 for text and 3:1 for a glyph or bar (WCAG 1.4.3,
1.4.11); at `aaa` (High contrast) 7:1 for `ink` (1.4.6) and 4.5:1 for everything else. The
figures below are the three built-in themes.

| Foreground          | Background            | Kind     | Dark  | Light | High contrast |
| ------------------- | --------------------- | -------- | ----- | ----- | ------------- |
| `ink`               | `canvas`              | ink      | 12.59 | 16.29 | 21.00         |
| `ink`               | `panel`               | ink      | 10.55 | 15.33 | 19.80         |
| `ink`               | `raised`              | ink      | 8.56  | 13.80 | 17.04         |
| `inkMuted`          | `canvas`              | text     | 7.01  | 6.54  | 14.17         |
| `inkMuted`          | `panel`               | text     | 5.87  | 6.15  | 13.36         |
| `inkMuted`          | `raised`              | text     | 4.77  | 5.54  | 11.50         |
| `accent`            | `canvas`              | text     | 6.79  | 5.40  | 9.38          |
| `accent`            | `panel`               | text     | 5.69  | 5.08  | 8.84          |
| `accent`            | `raised`              | text     | 4.61  | 4.57  | 7.61          |
| `accentInk`         | `accent`              | text     | 6.79  | 5.40  | 9.38          |
| `danger`            | `panel`               | text     | 4.75  | 5.35  | 7.36          |
| `success`           | `panel`               | text     | 5.61  | 5.08  | 13.37         |
| `warning`           | `panel`               | text     | 6.49  | 5.58  | 13.71         |
| `syntax.keyword`    | `canvas`              | text     | 6.08  | 9.88  | 10.30         |
| `syntax.string`     | `canvas`              | text     | 6.03  | 5.31  | 12.77         |
| `syntax.number`     | `canvas`              | text     | 6.04  | 6.21  | 13.24         |
| `syntax.comment`    | `canvas`              | text     | 4.75  | 4.76  | 12.04         |
| `syntax.identifier` | `canvas`              | text     | 5.56  | 8.29  | 10.26         |
| `syntax.operator`   | `canvas`              | text     | 8.87  | 20.03 | 21.00         |
| `syntax.variable`   | `canvas`              | text     | 6.53  | 5.36  | 11.20         |
| `ink`               | `syntax.bracketMatch` | ink      | 7.33  | 12.36 | 11.20         |
| `gridNull`          | `canvas`              | text     | 4.75  | 4.76  | 12.04         |
| `ink`               | `gridSelection`       | ink      | 7.39  | 11.57 | 10.16         |
| `keyIcon`           | `panel`               | non-text | 6.10  | 3.41  | 13.71         |
| `planBar`           | `canvas`              | non-text | 4.13  | 3.89  | 9.38          |

## Fonts and density

Three fonts, each a family and a size (8–32 px) in Settings. A chosen family is written ahead of
the built-in stack, so a font that is gone falls back; `null` is the built-in stack alone.

| Token (`appearance/themes.ts`) | CSS variables                               | Tailwind                     | Built-in                                           | Size  | Settings page |
| ------------------------------ | ------------------------------------------- | ---------------------------- | -------------------------------------------------- | ----- | ------------- |
| `fonts.ui`                     | `--tc-font-ui`, `--tc-font-ui-size`         | `font-ui`, `text-ui`         | `system-ui, -apple-system, "Segoe UI", sans-serif` | 13 px | Appearance    |
| `fonts.editor`                 | `--tc-font-editor`, `--tc-font-editor-size` | `font-editor`, `text-editor` | `"JetBrains Mono", Menlo, Consolas, monospace`     | 13 px | Editor        |
| `fonts.grid`                   | `--tc-font-grid`, `--tc-font-grid-size`     | `font-grid`, `text-grid`     | the editor's stack                                 | 12 px | Data Editor   |

`⌘=` / `⌘-` / `⌘0` in the console change the saved editor size by 1 px and reset it to 13. The
console's line height is fixed.

`text-label` is 85% of the UI size, for capitalised group labels such as the Settings page list's
**TOOLS**; it follows the UI size and has no setting of its own.

Density is Comfortable (default) or Compact, DataGrip's Compact Mode. Only the first three tokens
and the title bar height differ; every panel and dialog keeps its size. The grid and the Database pane virtualise with the
live row height.

| Token (`appearance/themes.ts`) | CSS variable                 | Comfortable | Compact |
| ------------------------------ | ---------------------------- | ----------- | ------- |
| `density.rowHeightPx`          | `--tc-row-height`            | 24 px       | 20 px   |
| `density.cellPaddingPx`        | `--tc-cell-padding`          | 8 px        | 6 px    |
| `density.gapPx`                | `--tc-gap`                   | 8 px        | 6 px    |
| `density.titleBarHeightPx`     | `--tc-title-bar-height`      | 40 px       | 32 px   |
| `density.gridColumnMaxWidthPx` | `--tc-grid-column-max-width` | 320 px      | 320 px  |
| `density.valuePanelWidthPx`    | `--tc-value-panel-width`     | 360 px      | 360 px  |
| `density.consoleHeightPx`      | `--tc-console-height`        | 128 px      | 128 px  |
| `density.stripeWidthPx`        | `--tc-stripe-width`          | 36 px       | 36 px   |
| `density.tabHeightPx`          | `--tc-tab-height`            | 32 px       | 32 px   |
| `density.statusBarHeightPx`    | `--tc-status-bar-height`     | 24 px       | 24 px   |
| `density.iconPx`               | `--tc-icon`                  | 16 px       | 16 px   |
| `density.paletteWidthPx`       | `--tc-palette-width`         | 576 px      | 576 px  |
| `density.dialogWidthPx`        | `--tc-dialog-width`          | 880 px      | 880 px  |
| `density.dialogHeightPx`       | `--tc-dialog-height`         | 580 px      | 580 px  |
| `density.dialogListWidthPx`    | `--tc-dialog-list-width`     | 240 px      | 240 px  |
| `density.popoverWidthPx`       | `--tc-popover-width`         | 480 px      | 480 px  |
| `density.popoverHeightPx`      | `--tc-popover-height`        | 360 px      | 360 px  |
| `density.generatorWidthPx`     | `--tc-generator-width`       | 640 px      | 640 px  |
| `density.pickerWidthPx`        | `--tc-picker-width`          | 720 px      | 720 px  |
| `density.pickerListHeightPx`   | `--tc-picker-list-height`    | 220 px      | 220 px  |
| `density.planDetailsWidthPx`   | `--tc-plan-details-width`    | 320 px      | 320 px  |
| `density.planBarHeightPx`      | `--tc-plan-bar-height`       | 3 px        | 3 px    |

## Motion

Plan 109, decision 120. Motion is quiet and only on surfaces that open: a short fade, a few
pixels of travel or a slight scale, and nothing on close, so focus returns in the same frame. Every
timing is a token in `appearance/motion.ts`, written as `--tc-motion-*` variables; `app.css` names
the animations (`animate-surface-in`, `animate-menu-in`, `animate-tooltip-in`, `animate-dialog-in`,
`animate-overlay-in`) and the easing, and `renderer/ui/motion.ts` holds the class each surface
adds. No component writes a duration.

| Token (`appearance/motion.ts`) | CSS variable                   | Full    | Reduced | Off    |
| ------------------------------ | ------------------------------ | ------- | ------- | ------ |
| `fastMs`                       | `--tc-motion-fast`             | 100 ms  | 100 ms  | 0 ms   |
| `baseMs`                       | `--tc-motion-base`             | 150 ms  | 150 ms  | 0 ms   |
| `slowMs`                       | `--tc-motion-slow`             | 200 ms  | 200 ms  | 0 ms   |
| `flashMs`                      | `--tc-motion-flash`            | 600 ms  | 600 ms  | 0 ms   |
| `shiftPx`                      | `--tc-motion-shift`            | 4 px    | 0 px    | 0 px   |
| `enterScale`                   | `--tc-motion-enter-scale`      | 0.98    | 1       | 1      |
| `pressScale`                   | `--tc-motion-press-scale`      | 0.92    | 1       | 1      |
| `pressScaleText`               | `--tc-motion-press-scale-text` | 0.97    | 1       | 1      |
| `progress` (spinners)          | `--tc-motion-progress`         | running | running | paused |
| `ambient` (connecting pulse)   | `--tc-motion-ambient`          | running | paused  | paused |

Two easings: `--ease-standard` (`cubic-bezier(0.2, 0, 0, 1)`) for entering, `linear` for fades and
progress. No springs, bounce or overshoot.

| Surface                                    | Class (`ui/motion.ts`)                           | Opens with                          |
| ------------------------------------------ | ------------------------------------------------ | ----------------------------------- |
| Popovers, the data source widget           | `SURFACE_MOTION`                                 | base fade, 4 px from its side       |
| Command palette                            | `SURFACE_MOTION`, `OVERLAY_MOTION`               | base fade, 4 px down                |
| Context menus                              | `MENU_MOTION`                                    | fast fade, 4 px from its side       |
| Tooltips                                   | `TOOLTIP_MOTION`                                 | fast fade, on the delayed open only |
| Dialogs (`CONTENT_CLASS`, `OVERLAY_CLASS`) | `DIALOG_MOTION`, `OVERLAY_MOTION`                | slow fade and scale 0.98 → 1        |
| Spinners, the connecting pulse             | none (`animate-spin`, `animate-pulse` redefined) | loop, play state per level          |

Never animated: typing, the caret, CodeMirror's completion and hover tooltips, grid scroll,
selection, sort, edits and results arriving, tree expand and collapse, pane resizing, tab
switches, theme switches, transaction and connection state.

Side-by-side editor groups reuse the vertical `Handle`: `bg-line` at rest, `bg-accent` while
dragged. Both strips retain their active-tab underline; `data-focused` on the group identifies the
command target without dimming the other editor. During a tab drag, left/right half-width drop
targets use `border-accent`, a translucent `bg-selection`, and a `bg-panel` label; the hovered
target strengthens the selection fill. Splits, moves and resizing do not animate. Narrow groups
keep their own scrolling tab strip and console toolbar instead of overflowing into their neighbor.

Pressed and confirmed (plans 110, 114): every enabled `<button>` takes an inset `--tc-press-tint`
(14 % `--tc-ink`) while held, from one `@layer base` rule in `app.css`, so a press reads on any
background. The press lands on its first frame (`transition-duration: 0s` while `:active`) and
fades out over `--tc-motion-fast` on release, since an ordinary click is released before a fade-in
would show. Filled buttons (accent and danger) add `press-fill` through `FILLED_PRESS` or
`FILLED_DANGER_PRESS` (`ui/pressClasses.ts`): the tint becomes black, `--tc-fill-hover-shade` (8 %)
on hover and `--tc-fill-press-shade` (16 %) while held, because ink barely moves a light accent.
`appearance/press.ts` caps both, per theme and per fill, at the deepest 1 % step that keeps
`accentInk` at AA while held (most dark themes, whose label is dark on a light fill), keeping hover
at half the press; `press-fill-danger` swaps in the danger fill's `--tc-danger-*-shade`. Icon
buttons add `press` and shrink to `--tc-motion-press-scale`; text buttons add `press-text`
(`TEXT_PRESS`) and shrink less, to `--tc-motion-press-scale-text`, so a wide label moves about
2 px. Bordered text buttons take `hover:bg-raised`. The tint and shade are state and stay at every
motion level; the shrink is motion and stops at Reduced and Off. A copy button swaps its glyph for a bold `Check` in `text-success` and its tooltip for "Copied" for
1.5 s after the clipboard write it caused (`ui/useCopyConfirmation.ts`); a failed copy never
confirms.

The level is the **Motion** setting (`appearance.motion`): System (default) follows
`prefers-reduced-motion`, which Chromium reads from macOS Reduce Motion and its Windows and GNOME
equivalents; Full, Reduced and Off override it. It applies live.

## Dropdowns

Decision 140. Every choice list is `ui/Dropdown.tsx` (Radix Select), never a native `<select>`,
whose OS menu ignores the theme and the density; ESLint refuses `<select>` in the renderer. The
list opens under its trigger as a `SURFACE_MOTION` popover: `bg-raised`, a `border-line` frame,
`rounded`, `shadow-lg`, at least as wide as the trigger, `h-row` items with `bg-selection` on the
highlighted one and `CurrentIcon` in `text-accent` before the chosen one, group headings in
`text-ink-muted`. The keyboard is a native select's: arrows, type-ahead, Enter, Escape.

| Variant  | Where                                | Look                                               |
| -------- | ------------------------------------ | -------------------------------------------------- |
| `field`  | A form or dialog                     | `INPUT_CLASS` (`ui/fieldClasses.ts`), `rounded`    |
| `inline` | A toolbar or header line             | No fill, square, `border-line` only on hover       |
| `cell`   | A grid cell being edited (a boolean) | Fills the cell, `border-accent` frame, `font-grid` |

The flush rule: a control that fills the height of the strip it sits in (an `h-row` toolbar, a
header line, a chip in a bar, a tag inside a trigger) is square, with no radius, so its edges meet
the strip's lines. A control standing free in a form or a dialog keeps `rounded`. The extractor,
Transaction mode, the value panel's format picker, the plan view's Tree / Raw group, the result
search field and its filter chips, and the Theme trigger's scheme tag follow it.

## Settings dialog

Plan 013. `⌘,` (Settings… in the macOS app menu, File elsewhere) opens a modal the size of Data
Sources (`w-dialog`, `h-dialog-height`): a `w-dialog-list` page list behind a `border-line` edge
on the left, the chosen page `bg-selection`, the rest `hover:bg-raised`, and the page on the right
as a two-column form (`grid-cols-[8rem_1fr]`), section titles semibold `text-ink-muted` over a
`border-line` rule. Pages:

- **Appearance**: Theme, a dropdown (plan 032, decision 065, `dialogs/ThemePicker.tsx`): the
  trigger, `max-w-popover` wide, shows a `border-line` swatch of four 10 px squares (canvas, panel,
  ink, accent), the name and a Dark or Light badge. It opens a `ui/Popover` as wide as the trigger:
  a filter field over a listbox grouped Follow system, TableCraft, Dark, Light and Your themes under
  semibold `text-ink-muted` headers, each row the swatch, the name and its source in
  `text-ink-muted`, the chosen one checked, the highlighted one `bg-selection` and previewed live.
  A broken user theme is named by its file with its error count in `text-danger` and
  `aria-disabled`; highlighting it lists its errors under the list behind a `border-line` rule.
  Reload Themes and Open Themes Folder sit under the trigger. Density as two native radios; Motion
  as four (System, Full, Reduced, Off), with a muted "Following the system: …" line under System;
  UI font.
- **Editor**: Editor font and a muted line naming the zoom chords.
- **Data Editor**: Grid font, NULL text, Group digits, page size and Fetch All limit, with a muted
  note that formats are display only and paging applies to the next statement.
- **MCP Server** › Data source access (plan 121, decision 131): an exposed row's Timeout cell
  starts with an (i) (`InfoIcon`): `text-ink-muted` when every statement stops on the server at the
  limit, `text-warning` on a gap, and `text-ink-muted` in a `rounded-full` dashed `outline-ink-muted`
  ring when the server was never seen. The tone never speaks alone: its `title` is the summary.
  It opens a `ui/Popover` (`max-w-popover`, `p-cell`, `gap-cell`): the `DatasourceGlyph`, the name
  in semibold and the server in `text-ink-muted`; the limit in `font-editor` `tabular-nums` and
  its source muted; a coverage table whose cells are an icon and a word, never a colour alone:
  `CoveredIcon` "Stops" in `text-success`, `WarningIcon` "Drops connection" or "Blocking only" in
  `text-warning`, `NotCoveredIcon` "Not covered" and `NotSeenIcon` "Not seen" in `text-ink-muted`;
  a column neither row stops has a `text-warning` header and a screen-reader "(gap)". The
  sentences follow in `text-ui`, then a `border-line` footer with when the server was seen, muted,
  and Test Connection….

A font is a `Dropdown`: Built-in, then installed families from `queryLocalFonts()` in a Monospace
and a Proportional group (monospace first for the editor and grid), and a free-text field when the
list is unavailable. A size is a number field with its range muted beside it. A refused value
keeps its text, gains `border-danger` and an inline `text-danger` message, and is not saved. The
footer reads Restore Defaults (this page only), `Changes are saved as you make them.` muted, and
Close as the primary button; a failed save shows above it in `text-danger`.

A settings notice (the file was set aside, or the chosen theme fell back to Dark) sits at the top
of the Database pane like the datasources load warning: `border-warning`, a `WarningIcon` in
`text-warning`, the text, and Settings… and Dismiss under it, right aligned.

## Shell tokens

Plan 003's shell draws from these. The CSS variable is set by `apply.ts`; the Tailwind name is what
components write (`app.css` maps one to the other). In this and the later tables, the Light /
compact column gives a colour token's Light value and a density token's compact one; the Themes
and Fonts and density sections above hold every value.

| Token (`appearance/themes.ts`) | CSS variable               | Tailwind                     | Dark / comfortable | Light / compact | Used by                                                         |
| ------------------------------ | -------------------------- | ---------------------------- | ------------------ | --------------- | --------------------------------------------------------------- |
| `density.stripeWidthPx`        | `--tc-stripe-width`        | `w-stripe`                   | 36 px              | 36 px           | The left and right tool-window stripes                          |
| `density.tabHeightPx`          | `--tc-tab-height`          | `h-tab`, `size-tab`          | 32 px              | 32 px           | Editor tabs, tool-window headers, stripe buttons, palette input |
| `density.statusBarHeightPx`    | `--tc-status-bar-height`   | `h-status-bar`               | 24 px              | 24 px           | The status bar                                                  |
| `density.iconPx`               | `--tc-icon`                | `size-icon`                  | 16 px              | 16 px           | Every Phosphor icon and the tab close button                    |
| `density.paletteWidthPx`       | `--tc-palette-width`       | `w-palette`                  | 576 px             | 576 px          | Find Action / Search Everywhere                                 |
| `colors.selection`             | `--tc-selection`           | `bg-selection`               | `#2e436e`          | `#dfe1e5`       | Pressed stripe button, selected palette and Services rows       |
| `colors.success`               | `--tc-success`             | `text-success`, `bg-success` | `#5fb865`          | `#1f7a35`       | The connected datasource's dot                                  |
| `colors.danger`                | `--tc-danger`              | `text-danger`, `bg-danger`   | `#fa6675`          | `#c7222d`       | A failed datasource, console or connect message                 |
| `colors.panel`                 | `--tc-panel`               | `bg-panel`                   | `#2b2d30`          | `#f7f8fa`       | Stripes, tool windows, tab strip, status bar, palette           |
| `colors.canvas`                | `--tc-canvas`              | `bg-canvas`                  | `#1e1f22`          | `#ffffff`       | The editor area and the active tab                              |
| `colors.raised`                | `--tc-raised`              | `bg-raised`                  | `#393b40`          | `#ebecf0`       | Hovered tabs and buttons, the tab context menu                  |
| `colors.accent`                | `--tc-accent`              | `border-accent`, `bg-accent` | `#78a6fb`          | `#2b63d9`       | The active tab's underline, an active resize handle             |
| `colors.border`                | `--tc-border`              | `border-line`, `bg-line`     | `#43454a`          | `#d3d5db`       | Dividers and resize handles at rest                             |
| `density.dialogWidthPx`        | `--tc-dialog-width`        | `w-dialog`                   | 880 px             | 880 px          | The Data Sources and Settings dialogs                           |
| `density.dialogHeightPx`       | `--tc-dialog-height`       | `h-dialog-height`            | 580 px             | 580 px          | The Data Sources and Settings dialogs                           |
| `density.dialogListWidthPx`    | `--tc-dialog-list-width`   | `w-dialog-list`              | 240 px             | 240 px          | The datasource list, the Settings page list                     |
| `density.titleBarHeightPx`     | `--tc-title-bar-height`    | `h-title-bar`                | 40 px              | 32 px           | The main toolbar; the native controls' height                   |
| `TRAFFIC_LIGHT_INSET_PX`       | `--tc-traffic-light-inset` | `pl-traffic-lights`          | 76 px              | 76 px           | The main toolbar's left inset for the macOS traffic lights      |

The main toolbar (plan 015) is the window's title bar: `h-title-bar`, `bg-panel`, a
`border-line` bottom edge, `px-gap` with `gap-gap` between items. Its buttons are the compact
action buttons, icon-only `size-icon` glyphs with a tooltip below; the window title in the middle
is `text-ink-muted` and truncates. The datasource widget is a flat `h-row` button that turns
`bg-raised` on hover: the tint swatch (a 10 px square, `border-ink-muted` when untinted), the name
in semibold, the status bar's status dot and a muted caret. Its popover is `bg-raised` behind a
`border-line` edge, rows `h-row` turning `bg-selection` on hover, "connected" in `text-success`
and "disconnected" muted, and a `border-line` rule before New Data Source… and Data Sources…. On Windows and Linux
the native caption buttons are drawn by the system on `colors.panel` with `colors.ink` glyphs,
`titleBarHeightPx` high, and `.title-bar-overlay-inset` pads the toolbar's right edge to clear them
(`env(titlebar-area-*)` plus `--tc-gap`). The macOS traffic lights sit 12 px from the left,
centred in the toolbar. `.app-drag` makes the toolbar the drag region; `.app-no-drag` on every
control keeps it clickable.

The active editor tab is `bg-canvas` with a 2 px `border-accent` underline; inactive tabs are
`text-ink-muted` on the strip's `bg-panel` and show their close button on hover. Disabled actions,
in the palette and on toolbar buttons, are `text-ink-muted` at reduced opacity.

## Database explorer

Plan 005. Catalog rows reuse the shell's row height (`h-row`), icon size and colours, and add two
tokens.

| Token (`appearance/themes.ts`) | CSS variable        | Tailwind          | Dark / comfortable | Light / compact | Used by                                          |
| ------------------------------ | ------------------- | ----------------- | ------------------ | --------------- | ------------------------------------------------ |
| `colors.searchMatch`           | `--tc-search-match` | `bg-search-match` | `#6b5a1e`          | `#f6e39a`       | The characters speed search matched, as `<mark>` |
| `colors.keyIcon`               | `--tc-key-icon`     | `text-key-icon`   | `#d9a343`          | `#b07d14`       | A primary-key column, a key node                 |

Node icons are Phosphor glyphs named in `renderer/ui/icons.ts`, drawn by `panes/explorerLabels.tsx`:

| Node                          | Icon (`ui/icons.ts`)                                          | Colour                                 |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| database namespace            | `DatabaseIcon` (Database)                                     | `text-ink-muted`; `text-danger` failed |
| schema namespace              | `SchemaIcon` (TreeStructure)                                  | `text-ink-muted`; `text-danger` failed |
| group                         | `FolderIcon`                                                  | `text-ink-muted`                       |
| table, view, materialized     | `TableIcon`, `ViewIcon` (Eye), `MaterializedViewIcon` (Stack) | `text-accent`                          |
| column                        | `ColumnIcon` (Columns)                                        | `text-ink-muted`                       |
| primary-key column, key       | `KeyIcon`                                                     | `text-key-icon`                        |
| foreign-key column, FK node   | `KeyIcon`                                                     | `text-accent`                          |
| index                         | `IndexIcon` (ListDashes)                                      | `text-ink-muted`                       |
| routine, sequence             | `RoutineIcon` (Function), `SequenceIcon` (ListNumbers)        | `text-ink-muted`                       |
| NOT NULL, after the type      | `NotNullIcon` (Asterisk), 12 px                               | `text-ink-muted`                       |
| loading, synchronizing        | `SpinnerIcon`, spinning                                       | `text-ink-muted`                       |
| running action (Run, Run All) | `SpinnerIcon`, spinning                                       | the button's ink                       |
| error row                     | `WarningIcon`                                                 | `text-danger`                          |

A datasource row draws its brand's logo (decision 128) from the Simple Icons paths in
`renderer/ui/brandIcons.tsx`, at `size-icon`, in its brand's Simple Icons colour fitted to the
theme by `appearance/brandInk.ts`: the nearest 5 % step toward `ink` that holds 3:1 on `canvas`,
`panel`, `raised` and `selection`. State outranks brand: `text-danger` when its connect failed,
`text-ink-muted` when its plugin is missing or not yet downloaded. With `appearance.brandIconColor`
`gray`, every logo is `text-ink-muted`. A brand with no bundled path,
or `appearance.brandIcons` off, draws `DatabaseIcon` in `text-accent`.

A row's name keeps its width and truncates last; the detail after it (type, count, columns, hint)
is `text-ink-muted` and gives way first. A failed namespace and its error row are `text-danger`.
The speed search field floats at the tree's top right, `border-line` on `bg-raised`, and turns
`border-danger text-danger` when nothing matches. Synchronize, Collapse All and Copy use the
Phosphor `ArrowsClockwise`, `ArrowsInLineVertical` and `CopySimple` glyphs.

### Key tree

Plan 058. A `keyValue` datasource's rows add no tokens. A key's type badge (`ui/KeyTypeBadge.tsx`)
stands where a catalog row draws its icon: a `w-9` `rounded-sm` box, `font-mono font-semibold` in `text-canvas` on a
datasource tint, invisible until the key is described.

| Type        | Badge                                        | Background     |
| ----------- | -------------------------------------------- | -------------- |
| string      | `STR`                                        | `bg-ds-green`  |
| hash        | `HASH`                                       | `bg-ds-blue`   |
| list        | `LIST`                                       | `bg-ds-orange` |
| set         | `SET`                                        | `bg-ds-red`    |
| zset        | `ZSET`                                       | `bg-ds-violet` |
| stream      | `STRM`                                       | `bg-ds-yellow` |
| JSON, other | `JSON`, the module type's first four letters | `bg-ink-muted` |

A database row carries `DatabaseIcon`, a folder and the Cluster nodes group `FolderIcon`, a node
`ServerNodeIcon` (HardDrives) and the filter row `KeyFilterIcon` (Funnel), all `text-ink-muted`;
details (`6 keys`, a folder's count, a key's TTL) are `text-ink-muted`. The filter row is an
`<input>` on `bg-canvas` with a `border-line` frame and the type `Select` beside it.

## SQL console

Plan 006. The CodeMirror editor takes its theme from the same variables (`console/editorTheme.ts`):
text in `font-editor` at `text-editor`, background `bg-canvas`, gutter `bg-panel` with
`text-ink-muted` numbers, selection `colors.selection`, search matches `colors.searchMatch`. Syntax
colours are their own tokens, read by the `HighlightStyle` through the CSS variable only.

| Token (`appearance/themes.ts`) | CSS variable                | Tailwind                     | Dark / comfortable | Light / compact | Used by                                                  |
| ------------------------------ | --------------------------- | ---------------------------- | ------------------ | --------------- | -------------------------------------------------------- |
| `colors.syntax.keyword`        | `--tc-syntax-keyword`       |                              | `#cf8e6d`          | `#0033b3`       | Keywords, operator keywords, `TRUE`/`NULL`, type names   |
| `colors.syntax.string`         | `--tc-syntax-string`        |                              | `#6aab73`          | `#067d17`       | String literals                                          |
| `colors.syntax.number`         | `--tc-syntax-number`        |                              | `#2aacb8`          | `#1750eb`       | Numeric literals                                         |
| `colors.syntax.comment`        | `--tc-syntax-comment`       |                              | `#868a91`          | `#6f737a`       | Line and block comments, italic                          |
| `colors.syntax.identifier`     | `--tc-syntax-identifier`    |                              | `#c77dbb`          | `#871094`       | Quoted identifiers                                       |
| `colors.syntax.operator`       | `--tc-syntax-operator`      |                              | `#bcbec4`          | `#080808`       | Operators and punctuation                                |
| `colors.syntax.variable`       | `--tc-syntax-variable`      |                              | `#56a8f5`          | `#9e5a00`       | Bind parameters (`$1`, `:name`, `?`)                     |
| `colors.syntax.bracketMatch`   | `--tc-syntax-bracket-match` |                              | `#43454a`          | `#d3e1fb`       | The matching bracket's background                        |
| `colors.statementFlash`        | `--tc-statement-flash`      |                              | `#3d4a2e`          | `#e1f1d3`       | The statement just run, for 900 ms                       |
| `colors.warning`               | `--tc-warning`              | `text-warning`, `bg-warning` | `#e0a84a`          | `#8a5a00`       | Output warnings (skipped, cancelled), `transaction open` |

Live problems (plan 108) reuse these tokens, no new ones. An error is a `--tc-danger` wavy
underline, as the server's error mark; a warning is a `--tc-warning` wavy underline; a weak problem
(a redundant `ASC`) is greyed to `--tc-ink-muted`, its syntax colour included, with a dotted
underline. Where a server mark covers the same text, only the server mark shows. The gutter keeps
one column for both: a 7 px dot per line in the worst severity there, `--tc-danger` or
`--tc-warning`; weak problems get none. Hover lists each message after a filled `Lightbulb` in its
severity's colour, the fixes as `--tc-accent` links and `More actions… ⌥↩`. Show Context Actions
(`⌥↩`) opens a list at the caret in the tooltip's `bg-raised` frame: fixes first, each with that
bulb, a `border-line` rule, then Suppress (`EyeSlash`) and Disable (`Prohibit`) in `text-ink-muted`;
the chosen row is `--tc-selection`, ↑↓ move, ↵ or Tab apply, Esc closes, and a row click applies
it without taking focus from the editor.

The toolbar reads left to right: Run (primary), Run All, Explain Plan and Explain Analyse when the
plugin declares them (plan 012), Cancel when the plugin can cancel, then the transaction controls
when it declares `transactions`: a `Tx: Auto` / `Tx: Manual` select, Commit (`Check`), Rollback
(`ArrowCounterClockwise`) and the `transaction open` badge in `bg-warning text-canvas`. Run All is
`FastForward`. The two explain buttons are `compact`, the icon alone with the title and chord in the
tooltip, so a manual-mode toolbar still fits a 1200 px window: Explain Plan `TreeView`, Explain
Analyse `Gauge` with `tone="warning"`, a `border-warning` frame and `text-warning`, because it runs
the statement. Toolbar buttons never wrap (`shrink-0 whitespace-nowrap`); a long error gives way
instead, and so does the datasource name · plugin name at the end, truncated with an ellipsis.

Below the editor, the result strip holds `Output` and then `Result 1`, `Result 2`… or `Plan`,
`Plan (analysed)`, each with a `PushPin` that fills when pinned. The Output log is `font-editor`: the time and the statement's
first line in `text-ink-muted`, then the message: `text-ink` for results and notes, `text-warning`
for warnings, `text-danger` for errors, with the hint muted after it.

The completion popup (plan 009) is a `.cm-tooltip` in `bg-raised` with a `border-line` edge, rows in
`font-editor` at `text-editor`, the selected row in `colors.selection`, the matched characters in
`text-accent` without an underline, and the detail (type, namespace, foreign key) right-aligned in
`text-ink-muted` italic. Each row starts with the Database pane's glyph for its kind at `size-icon`
(`console/completionGlyphs.tsx`, drawn once per kind as static markup):

| Kind      | Glyph (`ui/icons.ts`)          | Colour           |
| --------- | ------------------------------ | ---------------- |
| namespace | `SchemaIcon` (`TreeStructure`) | `text-ink-muted` |
| table     | `TableIcon`                    | `text-accent`    |
| view      | `ViewIcon` (`Eye`)             | `text-accent`    |
| column    | `ColumnIcon` (`Columns`)       | `text-ink-muted` |
| alias     | `AliasIcon` (`At`)             | `text-ink-muted` |
| cte       | `CteIcon` (`BracketsRound`)    | `text-accent`    |
| join      | `JoinIcon` (`Intersect`)       | `text-accent`    |
| function  | `RoutineIcon` (`Function`)     | `text-ink-muted` |
| keyword   | `KeywordIcon` (`TextT`)        | `text-ink-muted` |

Go to Declaration on an alias flashes the declaration in `colors.statementFlash`, like a run.

## Result grid

Plan 007. The grid is `font-grid` at `text-grid`, rows `h-row`, and reuses the shell's panel, line
and accent colours; it adds three tokens and leans on two older ones.

| Token (`appearance/themes.ts`) | CSS variable                 | Tailwind               | Dark / comfortable | Light / compact | Used by                                      |
| ------------------------------ | ---------------------------- | ---------------------- | ------------------ | --------------- | -------------------------------------------- |
| `colors.gridSelection`         | `--tc-grid-selection`        | `bg-grid-selection`    | `#214283`          | `#c9dafc`       | Selected cells; stronger than `bg-selection` |
| `colors.gridNull`              | `--tc-grid-null`             | `text-grid-null`       | `#868a91`          | `#6f737a`       | NULL, italic, in cells and the value panel   |
| `density.valuePanelWidthPx`    | `--tc-value-panel-width`     | `w-value-panel`        | 360 px             | 360 px          | The value panel's width until it is dragged  |
| `colors.gridStripe`            | `--tc-grid-stripe`           | `bg-grid-stripe`       | `#26282b`          | `#f5f6f8`       | Every second row                             |
| `density.gridColumnMaxWidthPx` | `--tc-grid-column-max-width` | `--spacing-column-max` | 320 px             | 320 px          | The cap on a column's automatic width        |

The header and the row-number gutter are `bg-panel` with `border-line` dividers and stay put while
the rows scroll; gutter numbers are `text-ink-muted`, `text-ink` on a selected row. A header holds a
type glyph in `text-ink-muted` (`TYPE_GLYPHS` in `ui/icons.ts`: `Hash` number, `TextAa` text,
`Calendar` date, `ToggleLeft` bool, `BracketsCurly` json, `Binary` bytes), the name, and, when
sorted, an `ArrowUp` / `ArrowDown` in `text-accent` followed by the key's position when there are
several. The focused cell has a 1 px `outline-accent` inset. The resize handle is the header's
right 8 px with `cursor-col-resize`.

A cell draws NULL as the Data Editor's NULL text (`<null>` by default) and, with Group digits on,
an integer, decimal or float value as printed with `,` every three integer digits; column widths
are measured on the same text. The value panel, Copy, Export, filters and the inline editor keep
the database's text (decision 032).

The toolbar is `h-row` on `bg-panel`: icon-only buttons (`ArrowDown` Fetch Next Page,
`ArrowLineDown` Fetch All, `ArrowClockwise` Rerun, `Stop` Cancel Fetch), the state label in
`text-ink-muted`, a spinner while fetching, then on the right the extractor (an `inline`
`Dropdown`), `CopySimple` Copy, `Export` Export Data… and `SidebarSimple` Value Panel,
`bg-selection` while open. A disabled button explains itself in its tooltip. The value panel sits
behind the vertical `Handle` labelled Value panel: dragging it sets the panel's width, at least
200 px and at most 70 % of the area, the rows keeping 240 px, and the width outlives a relaunch;
until the first drag the panel is the density's 360 px. The closed-connection banner is an `h-row`
strip in `bg-panel`, `text-ink-muted` italics, above the rows.

## Table data editor

Plan 008. A table tab reuses the result grid and the console's tint border; its tab carries the
`Table` icon. Pending changes colour the row background through three tokens:

| Token (`appearance/themes.ts`) | CSS variable         | Tailwind           | Dark / comfortable | Light / compact | Used by                                       |
| ------------------------------ | -------------------- | ------------------ | ------------------ | --------------- | --------------------------------------------- |
| `colors.editModified`          | `--tc-edit-modified` | `bg-edit-modified` | `#2f4a6b`          | `#dce8fc`       | A changed cell in a held row                  |
| `colors.editInserted`          | `--tc-edit-inserted` | `bg-edit-inserted` | `#2f4d34`          | `#dcf2df`       | Every cell of a row to insert                 |
| `colors.editDeleted`           | `--tc-edit-deleted`  | `bg-edit-deleted`  | `#4d2f33`          | `#fbe0e2`       | Every cell of a row to delete, `line-through` |

Selection (`bg-grid-selection`) wins over the edit colours. A pending `NULL` reads `<null>` and a
pending default `<default>`, both italic `text-grid-null`. The inline cell editor is an `<input>`
filling the cell with the `outline-accent` inset.

A temporal cell's calendar button opens the date and time picker in a `ui/Popover` below the
editor, so it takes the popover's surface, border and motion. The month header is a `font-semibold`
title between `‹` `›` icon buttons; the day grid is seven `size-row` columns under `text-ink-muted`
weekday initials, days of the adjacent months `text-ink-muted`, a hovered day `bg-selection`, the
chosen day `bg-accent text-accent-ink`, today a `border-accent` ring and the keyboard cursor the
`outline-accent` focus ring. The time row is three two-digit fields in `font-grid` on `bg-canvas`
with a `border-line` frame that turns `border-accent` on focus, under a `border-line` divider when
the grid sits above it. The footer's Today or Now is a `text-accent` text button. No token is the
picker's own.

Above the grid sit the WHERE and ORDER BY bars: single-line CodeMirror fields on `bg-canvas` with a
`border-line` frame that turns `border-danger` on a refused clause, the label in `text-ink-muted`,
and the datasource name · plugin name on the right. The database's message sits under them in
`text-danger` with the hint muted. A read-only table shows an `h-row` banner in `bg-panel`,
`text-ink-muted`, `Read-only: <reason>`. The result toolbar gains icon-only `Plus` Add Row,
`Copy` Duplicate Row, `Trash` Delete Rows, `ArrowUUpLeft` Revert Selected, Preview
(`PreviewChangesGlyph`: an `Eye` with a solid `text-success` `ArrowFatUp` badge lower right, the eye
masked around it), Submit (`SubmitGlyph`: a hollow `ArrowFatUp` in `text-success`, as DataGrip
draws both; `ui/editGlyphs.tsx`), the `Tx: Auto` label, and `Sigma` Count Rows. The footer (`h-row`,
`text-ink-muted`) holds `3 pending changes`, the counted `12,345 rows`, and the last notice. The
preview is a 40 rem modal listing the numbered statements in `font-editor`.

### Key tab and Server tab

Plan 058. A key tab carries `KeyTabIcon` (Key) and the tint border, and reuses the table editor's
toolbar glyphs and edit tints; `Submit runs as one MULTI · not undoable` stands where the table
editor shows `Tx: Auto`. The header is one `h-tab` row on `bg-panel`: the type badge, the name in
`font-editor`, then `text-ink-muted` parts separated by `·` (datasource · db, TTL ticking each
second, length, memory, encoding, idle). The filter bar matches the WHERE bar. A missing key, a
conflict or a refused read is an `h-row` banner on `bg-panel` with `text-danger` (missing,
conflict) or `text-ink-muted` (read-only) and plain text buttons. A string's value editor fills
the tab: the value panel with its format picker (`Select`) in the header, the decoded format and
any problem on one `text-ink-muted` line, and the CodeMirror editor in `font-editor`.

A Server tab carries `ServerTabIcon` (Cpu). Its toolbar holds the Info and Slow log toggle buttons
(`aria-pressed`, `bg-selection` when on), the node and refresh `Select`s. Cards are `bg-panel`
boxes with a `border-line` frame in a wrapping grid, the title in `font-semibold`, headline
figures as name and right-aligned value in `font-grid`, the rest folded in a `details` (`N more`). The Overview and Slow log
are tables in `font-grid` at the grid's row height under a sticky `bg-panel` header.

## DDL and SQL generation

Plan 010. A DDL tab carries the `DdlIcon` glyph (Phosphor `FileCode`, `size-icon`) where a console
carries `Terminal` and a table tab `Table`, and the console's tint border. Its toolbar is an `h-tab`
`bg-panel` strip with icon-only `ArrowsClockwise` Refresh, `CopySimple` Copy and `Plus` Open in
Console, the qualified name in `text-ink-muted`, and the datasource name · plugin name on the right;
an error sits under it in `text-danger` with the hint muted. The body is a read-only CodeMirror view
(`ui/SqlView.tsx`) on `bg-canvas` with line numbers, the console's theme and syntax tokens, shared
with the SQL Generator's preview.

Quick Documentation (`Info`) is a `ui/Popover.tsx`: `bg-raised`, a `border-line` frame, `rounded`,
`shadow-lg`, `text-ui`, below the anchor with a 4 px offset. Its header (`border-b border-line`)
holds the kind in `text-ink-muted` and the qualified name and comment; section titles are
`text-ink-muted`, names and types `font-grid text-grid`. Columns use the explorer's marks: a filled
`KeyIcon` for the primary key, an outlined one for a foreign key, both `text-key-icon`, else a muted
`ColumnIcon`; NOT NULL wears `NotNullIcon` (`Asterisk`). Foreign keys read `→` outgoing and `←` incoming. The
body scrolls inside the popover's maximum.

The SQL Generator (`Code`) is a modal like the others, wider: the statements are a segmented radio
group in a `border-line` frame, the chosen one `bg-selection`, the rest `hover:bg-raised`; the
preview is `h-60` on `bg-canvas`; Open in Console is the primary button.

| Token (`appearance/themes.ts`) | CSS variable           | Tailwind               | Dark / comfortable | Light / compact | Used by                              |
| ------------------------------ | ---------------------- | ---------------------- | ------------------ | --------------- | ------------------------------------ |
| `density.popoverWidthPx`       | `--tc-popover-width`   | `max-w-popover`        | 480 px             | 480 px          | Quick Documentation's maximum width  |
| `density.popoverHeightPx`      | `--tc-popover-height`  | `max-h-popover-height` | 360 px             | 360 px          | Quick Documentation's maximum height |
| `density.generatorWidthPx`     | `--tc-generator-width` | `w-generator`          | 640 px             | 640 px          | The SQL Generator dialog             |

## Query history and Services

Plan 011. An outcome is drawn in one of two sizes from `ui/Outcome.tsx`, on the shell's colours:

| Outcome   | `OutcomeDot` (history list, 8 px `rounded-full`) | `OutcomeGlyph` (Services, `size-icon`)        |
| --------- | ------------------------------------------------ | --------------------------------------------- |
| running   |                                                  | `SpinnerIcon`, spinning, `text-accent`        |
| success   | `bg-success`                                     | `SuccessIcon` (`CheckCircle`), `text-success` |
| error     | `bg-danger`                                      | `ErrorIcon` (`XCircle`), `text-danger`        |
| cancelled | `bg-warning`                                     | `CancelledIcon` (`Prohibit`), `text-warning`  |

`ui/ListPicker.tsx` draws Query History and Open Closed Console as a modal like the others, wider:
the title, a search field, a `listbox` of `h-row` options on `bg-canvas` in a `border-line` frame
(the selected one `bg-selection`, the rest `hover:bg-raised`), the preview, then the buttons right
aligned with the primary last before Close and a destructive one (`Clear History…`, `Delete…`) in
the danger style. A history row reads the outcome dot, the first line in `font-editor text-editor`,
then `×3`, rows, duration and time in `text-ink-muted tabular-nums`; the preview is the read-only
`ui/SqlView.tsx`, `h-picker-list`, with an error message above it in `text-danger`. A closed
console's row is `ConsoleIcon` in `text-ink-muted` and its name. The actions' icons are
`ClockCounterClockwise` (Query History) and `FolderOpen` (Open Closed Console).

| Token (`appearance/themes.ts`) | CSS variable              | Tailwind        | Dark / comfortable | Light / compact | Used by                                       |
| ------------------------------ | ------------------------- | --------------- | ------------------ | --------------- | --------------------------------------------- |
| `density.pickerWidthPx`        | `--tc-picker-width`       | `w-picker`      | 720 px             | 720 px          | Query History and Open Closed Console dialogs |
| `density.pickerListHeightPx`   | `--tc-picker-list-height` | `h-picker-list` | 220 px             | 220 px          | The picker's list and its preview             |

The Services tree reuses the Database tool window's rows (`h-row`, 16 px indent per level, a caret
for expandable rows, `bg-selection` selected, `hover:bg-raised`). A datasource row is `DatabaseIcon`
in `text-accent` (`text-danger` failed), the name and its connection state muted. A session row is
the `Terminal` or `Table` glyph in `text-ink-muted`, a spinning `SpinnerIcon` in `text-accent`
while running, the tab's title, its state
(`text-accent` running, `text-danger` failed, else `text-ink-muted`) and the last duration right
aligned. An execution row is its `OutcomeGlyph`, the label in `font-editor text-editor` with the
error message as its tooltip, then rows, duration (elapsed while running) and start time right
aligned in `text-ink-muted tabular-nums`. The session's context menu is the tab context menu's
`bg-raised` panel.

## Plan view

Plan 012. A plan tab (`console/PlanView.tsx`) fills the result area. An analysed plan starts with
a banner: `bg-analysed-banner`, a `border-line` rule under it, a filled `WarningIcon` in
`text-warning`, then the text in `text-ink`. Under it an `h-row` toolbar on `bg-panel`: a segmented
Tree / Raw group that fills the strip from its left edge, the strip's own lines above and below and
a `border-line` divider after it (the flush rule; the shown view `bg-selection`), icon-only
`ArrowClockwise` Explain Again and `CopySimple` Copy Raw Plan, then the summary (`Planning Time: 1.0 ms ·
Execution Time: 0.1 ms`) in `text-ink-muted`, truncated.

The tree is a `<table role="treegrid">` on `bg-canvas` in `font-grid text-grid`, rows `h-row`, a
sticky `bg-panel` header in `text-ink-muted`, painted over the rows and their bars as they scroll
under it (`z-10`, each `<th>` on `bg-panel`). The Operation column takes the room left over and
truncates, with the whole text as the tooltip; it indents 16 px per level with the Database pane's
`CaretDown`/`CaretRight` and shows the target in `text-ink-muted`. The number columns are as narrow
as their content, right-aligned, empty for a value the database did not give. The Cost cell, or
the Time cell when analysed, carries an `h-plan-bar` `bg-plan-bar` bar along its bottom edge, as
wide as the node's share of the root's. The selected row is `bg-selection`, the rest
`hover:bg-raised`. To the right a `w-plan-details` strip on `bg-panel` behind a `border-line` edge
lists the selected node: the operation in semibold with its target muted, then `Detail` and each
property as a two-column list, names in `text-ink-muted`, values in `font-grid`, wrapping. Raw is
the read-only `ui/SqlView.tsx` on `bg-canvas`, unhighlighted.

| Token (`appearance/themes.ts`) | CSS variable              | Tailwind             | Dark / comfortable | Light / compact | Used by                                       |
| ------------------------------ | ------------------------- | -------------------- | ------------------ | --------------- | --------------------------------------------- |
| `colors.planBar`               | `--tc-plan-bar`           | `bg-plan-bar`        | `#4f80c9`          | `#4a7fe0`       | The share bar in the Cost or Time cell        |
| `colors.analysedBanner`        | `--tc-analysed-banner`    | `bg-analysed-banner` | `#4a3d22`          | `#faecd0`       | The `Explain Analyse ran this statement.` bar |
| `density.planDetailsWidthPx`   | `--tc-plan-details-width` | `w-plan-details`     | 320 px             | 320 px          | The node details strip                        |
| `density.planBarHeightPx`      | `--tc-plan-bar-height`    | `h-plan-bar`         | 3 px               | 3 px            | The share bar's thickness                     |

## Datasource colours

Plan 004. A datasource stores its colour by name (decision 011); the theme gives the value. The
name picks the classes in `renderer/ui/tint.ts`: the swatch is `bg-ds-<name>`, the tab background
`bg-ds-<name>/25`, the console editor's border `border-2 border-ds-<name>` (plan 006).

| Token (`colors.datasource.*`) | CSS variable     | Tailwind    | Dark      | Light     |
| ----------------------------- | ---------------- | ----------- | --------- | --------- |
| `red`                         | `--tc-ds-red`    | `ds-red`    | `#c75450` | `#e05a55` |
| `orange`                      | `--tc-ds-orange` | `ds-orange` | `#d08b46` | `#e08a3e` |
| `yellow`                      | `--tc-ds-yellow` | `ds-yellow` | `#c9ae4a` | `#d4b032` |
| `green`                       | `--tc-ds-green`  | `ds-green`  | `#5e9f62` | `#4e9a55` |
| `blue`                        | `--tc-ds-blue`   | `ds-blue`   | `#4f80c9` | `#4a7fe0` |
| `violet`                      | `--tc-ds-violet` | `ds-violet` | `#9670c7` | `#9a6fd1` |
