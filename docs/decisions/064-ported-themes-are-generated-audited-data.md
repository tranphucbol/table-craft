# 064: Ported themes are generated, audited data

Status: Accepted. Amends 012.

## Decision

TableCraft bundles 43 themes beyond Dark, Light and High contrast, ported from preman, which
vendors them from openchamber (preman decision 020). They are data, made by a script and checked
by a test, not hand-written colours:

- The palettes are vendored verbatim in `packages/desktop/scripts/palettes/` (42 openchamber JSON
  files and `preman-dark.json`, preman's own dark theme written in the same shape), with a
  `NOTICE` that carries the upstream licence and an attribution table: family, source, licence.
- `bun packages/desktop/scripts/generate-themes.ts`, run by hand, maps each palette onto
  TableCraft's colour tokens and writes one committed module per theme to
  `packages/desktop/src/appearance/themes/`, plus `index.ts`. Each `Theme` carries `source` and
  `licence` from the NOTICE row of its family; a palette with no row is an error.
- Tokens a palette names are read (canvas from `surface.background`, ink from
  `surface.foreground`, accent from `primary.base`, syntax from `syntax.base`, and so on). Tokens
  it does not name are solved: `gridNull` fades ink toward canvas to the contrast floor; the
  selection, edit, search and flash tints mix their source colour into canvas and step back until
  ink reads on them; the six datasource tints are matched to palette colours by hue, then moved
  until each is at least 3:1 on `panel` and 0.08 OKLab from the others.
- Any colour short of its contrast pair is raised toward white or black until it passes with a 2%
  margin. The generator refuses to write if any theme still fails `CONTRAST_PAIRS` or the tint
  separation, and lists every fault. `palettes/overrides.json` may pin a token per theme by hand;
  it is empty, because every palette passed.
- `Theme` gains `contrast: "aa" | "aaa"`, and `requiredContrast` keys on it instead of on the
  theme id. Every ported theme is `aa`; only High contrast is `aaa`.
- A theme id is the palette id (`gruvbox-dark`, `vitesse-light-light`); the built-in ids do not
  change. A user theme's `base` may be any bundled id; an unknown one makes the file broken, and
  the error names the base.

## Rationale

Forty-three themes by hand would drift from their sources and from each other, and nobody would
re-measure them after a token was added. Generation keeps the mapping in one place, a token added
later is solved for every theme at once, and the audit that guards the built-in themes guards
these too. Reading palettes as data rather than re-typing them keeps attribution exact.

Moving `requiredContrast` from the theme id to a field was needed once ids stopped being three
known names; it also lets a user theme inherit its base's level.

## Consequences

- `test/appearance/themes.test.ts` audits all 46 bundled themes, checks the tints, checks every
  source has a NOTICE row, and reruns the generator expecting byte-identical output, so a
  hand-edit of a generated module fails the suite.
- Some palette colours are lighter or darker than upstream; the solved values are the ones that
  pass, not the ones the palette author picked.
- Adding a theme is: drop a palette in, add a NOTICE row if its family is new, run the script.
- The renderer bundle carries all 46 themes; they are small, but the cost grows with each.
