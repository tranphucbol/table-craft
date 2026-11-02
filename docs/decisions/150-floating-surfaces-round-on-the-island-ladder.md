# 150: Floating surfaces round on the island ladder

Status: Proposed. Amends 141.

## Decision

Three floating radii are design tokens, set by `renderer/appearance/apply.ts` from the density and
the window style: `--tc-dialog-radius` (`rounded-dialog`), `--tc-popover-radius`
(`rounded-popover`) and `--tc-tooltip-radius` (`rounded-tooltip`).

| Window style / density | Dialog, palette | Island | Popover | Tooltip, row |
| ---------------------- | --------------- | ------ | ------- | ------------ |
| Islands, comfortable   | 10              | 10     | 8       | 4            |
| Islands, compact       | 8               | 8      | 8       | 4            |
| Classic, either        | 8               | 0      | 4       | 4            |

With Islands a dialog and the Search Everywhere palette round to the island's radius, so a
floating card is never squarer than the tiles under it. Every menu, popover, dropdown list, the
SQL completion list and the editor's context actions round to the popover radius, 8 px, which
nests a 4 px row in a 4 px inset. A surface that holds a list of choices is a popover; one that
holds only text (a tooltip, an (i) hint, the explorer's speed search badge, CodeMirror's
inspection and error tooltips) is a tooltip. Classic keeps 8 / 4 / 4.

Their shadows are tokens too: `--tc-popover-shadow` (`shadow-popover`) on menus, popovers, lists
and tooltips, `--tc-dialog-shadow` (`shadow-dialog`) on dialogs and the palette, both from
`ELEVATION` by the theme's colour scheme. A dark scheme casts the darker pair.

## Rationale

Islands rounded the tiles and left everything above them as it was: Settings opened as an 8 px
card over 10 px islands, and floating surfaces used four radii (10, 8, 6, 4) where the completion
list and the editor's context menu, both opened from the caret, differed. A floating layer should
round at least as much as the layer under it, and nested radii should step down from the outside
in. JetBrains' Islands rounds its popups to the island arc as well.

Popovers take 8 rather than the island radius: they are smaller than a dialog, and 8 is the
smallest radius whose 4 px rows in a 4 px inset are concentric. Dialogs do not step above the
island in compact (10 over 8): that would bring back a fourth radius, and the shadow and size
already rank the dialog.

## Consequences

- The radii are tokens, not literals in a dozen class strings; `test/renderer/surfaceRadius.test.ts`
  refuses `rounded-lg` in the renderer, Tailwind's own shadow scale or a literal black shadow, and
  any `shadow-dialog` surface that is not `rounded-dialog`.
- Tailwind's `shadow-lg` (10 % black) did not show on a dark canvas, so dark menus floated on their
  border alone. Shadows follow the scheme rather than each theme: a theme author picks colours,
  and a shadow is black at any hue.
- `EDITOR_TOOLTIP_RADIUS_PX` (6 px) is gone. Under Classic the completion list and the editor's
  tooltips go from 6 to 4 px, the radius every other Classic popover already had.
- The palette's 4 px rows in a 4 px inset sit 2 px short of concentric inside its 10 px corner in
  comfortable; rows keep one radius app-wide.
