# 141: The window draws as islands

Status: Accepted

## Decision

The window has two styles, `appearance.windowStyle`: `classic`, the default, and `islands`. With
Islands, after JetBrains' Islands theme, the editor area and the Database, Log, Watch and Services
tool windows are rounded cards of the editor's surface (`canvas`), with no border, set apart by a
gap on a window frame; the main toolbar, the stripes and the status bar sit on the frame without
their edge lines. Classic is the flat layout the app had before: panes of `panel` split by 1 px
`border-line` lines. The layout, the panels and their sizes are the same in both, and the style
changes live.

The frame is derived, not a theme token. `appearance/islands.ts` steps `panel` toward white in a
dark scheme and toward black in a light one until it holds JetBrains' 1.20:1 against `canvas`,
stopping earlier where `ink` or `inkMuted` would fall below the theme's contrast level. Gap and
radius are density tokens: 5 px and 10 px comfortable, 4 px and 8 px compact.

Inside an island `--tc-panel` reads `--tc-canvas`; on the frame `--tc-panel` and `--tc-raised` read
the frame and its hover colour. Components keep writing `bg-panel` and `bg-raised`.

## Rationale

JetBrains made Islands the default look of its 2025.3 IDEs, and TableCraft follows DataGrip's
shape. The style is about structure, not colour, so it has to work with every bundled, ported and
user theme; a new `frame` token would have meant a value for 43 generated palettes and every user
theme file, and an override nobody but a theme author could tune. Deriving it keeps user themes a
flat set of colours (decision 032) and lets the contrast tests audit every frame.

Re-pointing `--tc-panel` per surface, rather than editing each pane, keeps the change in the shell:
the 228 `border-line` and 102 `bg-panel` uses inside panes stay as they are, and a pane drawn later
gets the right surface without knowing which style is on.

JetBrains' frame stays apart from the islands by colour alone (its dark one sits at 1.18:1, below
its own floor). Many ported palettes put muted text close to AA on `panel`, so lifting their frame
to 1.20:1 would make the toolbar and status bar text fail; readability wins, and the gaps still
separate the islands.

A setting, not a replacement, because the islands cost 10 px of width and height at the
comfortable density and some users prefer the denser flat window. Classic stays the default so an
update does not change the window under anyone; Islands is one choice away in Settings.

## Consequences

- Nobody sees a new look on update; Islands is opt-in under Settings › Appearance › Window style.
- The README and guide GIFs show the Classic window, the default, so they need no new recording.
- The editor tabs keep the accent underline; JetBrains' filled tab pill and the dimming of an
  unfocused window are not part of this.
- A theme cannot choose its frame colour; adding a token later only adds an optional override.
- End-to-end suites that read the toolbar's colour keep reading `panel` under the default style.
