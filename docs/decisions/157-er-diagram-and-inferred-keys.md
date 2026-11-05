# 157: The ER diagram draws React Flow over an ELK layout, and inferred keys stay in it

Status: Accepted. Plan 152. Amends 003 and 014.

## Decision

A schema's ER diagram is an editor tab of kind `diagram`, one per datasource and namespace, opened
from **Diagrams → Show Diagram** on a namespace or its Tables group when the datasource declares
`schemaTree`.

- **Three origins.** Edges are **declared** (from `Relation.foreignKeys`, solid), **inferred** (by
  a heuristic, dashed, muted ink) or **virtual** (added by the user, dotted, accent ink).
- **Guesses stay in the diagram.** Inferred and virtual keys are drawn and nowhere else. Join
  completion, Go to Referenced Row, the explorer's foreign-key folder and the MCP tools read
  declared keys only.
- **Inference runs in core.** `inferForeignKeys` (`packages/core/src/catalog/inferKeys.ts`) reads a
  described `NamespaceCatalog` through the catalog cache, and the engine answers it as
  `catalog.inferredKeys`. It needs `columnTypeClass`, which the renderer may not import, and naming
  conventions are not dialect knowledge, so it is not in a plugin (decision 008). It proposes a key
  only when exactly one table matches, the target column is that table's sole primary key (or sole
  single-column unique key), and both share a type class; ambiguity yields no edge. Nothing in
  `@table-craft/plugin-api` changes.
- **State in main.** Hidden inferred keys, virtual keys, the inference toggle and, per namespace,
  table positions, hidden tables and the column mode live in `<userData>/diagrams.json`, keyed by
  datasource id then `JSON.stringify(path)`, not in `datasources.json`, whose export should carry no
  canvas. A corrupt file is set aside as `diagrams.json.corrupt-<ts>`; deleting a datasource drops
  its entry.
- **Stack.** The canvas is React Flow (`@xyflow/react` 12, MIT) and the layout is ELK (`elkjs` 0.12,
  `layered`, taken under EPL-2.0), both bundled renderer devDependencies beside decision 003's
  stack. ELK runs in a classic Web Worker loaded from the bundled `elk-worker.min.js`, so the CSP
  stays as it is; its licence ships as `licenses/elkjs-LICENSE.md` in the packaged app.
- **ELK places, the diagram routes.** Each keyed column is an ELK port with `FIXED_ORDER` so the
  layered layout minimises crossings between columns. Edges are drawn as step paths between the two
  column rows from the saved positions; ELK's bend points are ignored, since they go stale on the
  first drag and are not saved.
- **The theme is the app's.** Only React Flow's `base.css` loads; every colour, font and size is a
  `--tc-*` variable, so a theme, density or font change repaints the open diagram in place. Export
  draws the whole diagram as plain SVG from the same geometry, with the variables resolved on the
  diagram's surface at export time; PNG rasterises that SVG at 2×.

## Rationale

Most databases people open declare few or no foreign keys, so a diagram of declared keys alone is a
grid of boxes. A conservative, deterministic guess draws the usual `<thing>_id` columns; a missed
key costs the user one virtual key, a wrong one costs trust in every dashed line, so the rule
prefers no edge. Keeping guesses out of completion and navigation means a wrong guess can mislead
only the reader of a diagram, who sees it is dashed.

React Flow gives React nodes styled with the app's tokens, pan, zoom, drag and culling; ELK is the
only layout among those compared with port-aware layered placement, so edges do not cross between
column rows. Rejected: React Flow with dagre (node centres only), ELK with a hand-written SVG
canvas (pan, zoom, drag and selection rebuilt by hand), AntV X6 (not React-native, its own theming),
JointJS (layout and export are paid), maxGraph (pre-1.0, styles outside CSS), Cytoscape.js (node-link
graphs, not tables with rows), Mermaid (static, no drag) and GoJS (commercial). Screenshotting the
DOM for export misses culled nodes and mangles fonts in `foreignObject`.

## Consequences

The app bundles its first EPL-licensed code, unmodified, with its licence text. The renderer gains
about 50 KB gzip for React Flow and a 1.5 MB worker file that parses off the main thread. Inference
is English-only (plural rules `s`, `es`, `y → ies`), on by default per datasource, and misses
irregular plurals such as `people`, which a virtual key covers. Feeding inferred keys into
completion is a separate, later decision.
