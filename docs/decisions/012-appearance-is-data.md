# 012: Appearance is data

Status: Accepted. Amended by 064.

## Decision

- Themes are typed token sets. Built-ins: Dark (Darcula-like), Light, High contrast, plus "follow
  system". Users may add JSON themes in `<userData>/themes/`, validated against the token schema;
  missing tokens fall back to the declared base theme.
- Three independent font settings, each with family and size: UI, editor (consoles, DDL) and grid.
  Families are listed from installed fonts via `queryLocalFonts()`, monospace first for editor and
  grid, with free-text entry as fallback.
- A density preset (compact, comfortable) sets row height and padding. `Cmd +` / `Cmd -` zooms the
  editor font.
- Everything applies live through CSS variables written by `renderer/appearance/apply.ts` and
  persists in app settings.

## Rationale

A database IDE is read all day; fonts and sizes are not cosmetic. Separating the grid font from the
editor font is a common DataGrip request. Token data, as in preman's decision 020, lets a test
assert WCAG AA contrast for every built-in theme instead of trusting eyes.

## Consequences

- Components use tokens only; a literal colour is a lint or review failure.
- A user theme that fails validation is listed with its errors and not applied.
