# 128: Plugins name the products they speak, and datasource rows draw their logos

Status: Accepted

## Decision

A plugin manifest may declare `brands`: the database products the plugin speaks, as
`{ id, name }` pairs. The first is the plugin's default. An `id` is a Simple Icons slug
(`[a-z0-9_]+`): the MySQL plugin declares `mysql`, `mariadb` and `tidb`; PostgreSQL `postgresql`;
Redis `redis`; SQLite `sqlite`; Oracle `oracle`; SQL Server `microsoftsqlserver`. A session may
report the one it reached as `serverBrand`; the MySQL plugin takes it from its server dialect
(`serverDialect(version).kind`), so there is one detector.

A datasource stores the brand it was made for (`brand` in `datasources.json`), set when the user
picks a product in the New Data Source picker, which lists one row per brand, and corrected when a
session or Test Connection reports another. The renderer resolves a row's brand as the live
session's, then the stored one if the plugin still declares it, then the plugin's default.

Brand ids choose a glyph and a name, never behaviour; the UI still branches on capabilities
(decision 007). The renderer bundles the Simple Icons paths it knows, each drawn in its brand's
Simple Icons colour, moved toward the theme's ink just far enough to hold WCAG non-text contrast
(3:1) on the canvas, panel, raised and selection surfaces (`appearance/brandInk.ts`). A failed row
paints its logo `danger` and a missing plugin's `inkMuted`, so the state still outranks the brand.
A brand without a bundled path (Oracle, SQL Server) draws the generic glyph in the accent.
`appearance.brandIconColor` set to `gray` draws every logo in `inkMuted` instead, for users who
want the shapes without the colour.

`appearance.brandIcons`, on by default, turns the logos on (View → Brand Icons, the Toggle Brand
Icons action, Settings › Appearance). With logos on, a row that draws a logo drops its trailing
product name, which moves to the row's tooltip; rows with the generic glyph keep it. In both modes
the trailing text names the brand, not the plugin. Logos appear in the Database explorer, the
Data Sources dialog (list, header and picker) and the Services tree; tab titles do not change.

## Rationale

MySQL, MariaDB and TiDB share one plugin, so the plugin's name says less than the user knows about
the server. The manifest is the plugin's own statement of what it speaks, so the host needs no
table of products, and a third-party plugin can name its own. Storing the brand lets a
disconnected row show the right logo, and the live report keeps it honest when a MySQL datasource
turns out to be TiDB.

Simple Icons slugs give a stable, public vocabulary and CC0 paths, so no artwork is drawn or
licensed here. A first cut drew every logo in the accent, which made six products look alike;
brand colours tell them apart at a glance, as DataGrip does. Raw brand colours fail on dark themes
(MariaDB's and SQLite's navy vanish on a dark panel), so the colour is fitted per theme rather
than shipped as is.

## Consequences

`brands` and `serverBrand` are optional additions to the plugin API (1.6.0, decision 106). Logos
are trademarks of their owners; the README says so. Adding a product means a manifest entry and,
for a logo, a path in `renderer/ui/brandIcons.tsx`.
