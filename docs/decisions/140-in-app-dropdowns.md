# 140: Every dropdown is drawn in-app

Status: Accepted

## Decision

The renderer has no native `<select>`. Every choice list is `ui/Dropdown.tsx`, built on Radix
Select with `position="popper"`: a themed list under its trigger, on the popover surface, with a
native select's keyboard (arrows, type-ahead, Enter, Escape). ESLint refuses a `select` JSX element
anywhere in `packages/desktop/src/renderer/`.

A dropdown comes in three variants: `field` for forms and dialogs, `inline` for a toolbar or header
line, whose frame shows only on hover and focus like the icon buttons beside it, and `cell` for a
grid cell being edited. A control that fills the height of the strip it sits in is square (the flush rule in
`docs/design/design-system.md`); a free-standing one keeps the shared radius.

## Rationale

A native `<select>` opens the operating system's menu. On macOS that menu ignores the app's theme,
density and fonts, cannot show the chosen option's mark, and draws a system-rounded box inside a
square toolbar, so the result grid's extractor and the Theme picker's tag looked foreign beside the
rest of the window. Styling the closed `<select>` alone cannot fix the open menu.

Radix Select was chosen over a hand-rolled listbox because it already gives the keyboard model,
focus return, type-ahead, collision handling and screen-reader roles (`combobox`, `listbox`,
`option`), and the app already builds its popovers, dialogs, menus and tooltips on Radix. Its
popper position keeps the list under the trigger, as the theme picker's list is, instead of the
macOS-style list centred on the chosen item.

Radix reserves the empty string, which some options use as a value, so items carry their index and
the component maps it back; the real value rides on `data-value` for the end-to-end suites.

## Consequences

- Dropdowns follow every theme, density and font setting, including user themes.
- End-to-end tests cannot use Playwright's `selectOption` or `inputValue` on a dropdown; they use
  `chooseOption` and `optionValue` from `test/e2e/harness.ts`.
- A new choice list needs no styling of its own: it picks a variant.
- `@radix-ui/react-select` is one more renderer dependency.
