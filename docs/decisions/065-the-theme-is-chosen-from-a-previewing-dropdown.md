# 065: The theme is chosen from a previewing dropdown

Status: Accepted.

## Decision

Settings → Appearance chooses the theme from a dropdown, `renderer/dialogs/ThemePicker.tsx`, not a
radio list. The trigger shows the chosen theme's swatch, name and a Dark or Light badge. The popover
has a filter field, matching name or source, over a listbox grouped Follow system, TableCraft,
Dark, Light (the ported themes by name) and Your themes; the grouping is a pure model,
`renderer/model/themePicker.ts`.

The highlighted theme previews live: arrow keys, Home, End or the mouse set a transient
`previewTheme` in `state/settings.ts`, which `themeOf` prefers over the saved choice and which is
never written. Enter or a click commits through the normal settings update. Escape, a click outside
or closing the dialog clears the preview, so the saved theme is drawn again. A broken user theme is
listed disabled with its error count, its errors shown while it is highlighted; it is not
previewed and cannot be chosen.

## Rationale

Forty-six themes and any number of user themes do not fit a radio list on one page, and a name
says little about a colour scheme. A filter finds a theme in a keystroke or two, and the preview
answers "what does it look like" without committing to it or writing `settings.json` on every
arrow press. It follows the console's namespace switcher, so the control is already familiar.

## Consequences

- The preview is renderer-only: main's window background and `nativeTheme` change on commit, not
  on highlight, so on macOS the title bar area can briefly differ from the previewed canvas.
- The picker lives under `dialogs/` rather than `ui/` because it reads and writes settings state.
- There is no palette command for themes; the dropdown is the one way in.
