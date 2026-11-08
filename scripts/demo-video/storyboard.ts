/**
 * The demo video, in order: title cards between clips of README media scenes. A clip names the
 * scene that records it (`test/readme/*.media.test.ts`); its caption sits above the window. Edit
 * this list to change the video, then `bun run demo:video`.
 */

export interface CardShot {
  readonly kind: "card";
  readonly seconds: number;
  readonly kicker?: string;
  readonly title: string;
  readonly sub: string;
  /** The app's icon above the title. */
  readonly logo?: boolean;
  /** Title size in px, when the default is too large for the line. */
  readonly titlePx?: number;
  readonly pills?: readonly string[];
  readonly url?: string;
}

export interface ClipShot {
  readonly kind: "clip";
  /** The README media scene, recorded to `<clips>/<scene>.mkv`. */
  readonly scene: string;
  readonly kicker: string;
  readonly title: string;
  readonly sub: string;
}

export type Shot = CardShot | ClipShot;

export const STORYBOARD: readonly Shot[] = [
  {
    kind: "card",
    seconds: 4,
    logo: true,
    title: "TableCraft",
    sub: "A free, open-source database IDE in the spirit of DataGrip — with a built-in MCP server for AI agents",
  },
  {
    kind: "clip",
    scene: "how-it-works",
    kicker: "Connect & query",
    title: "Add a data source, browse it, run SQL",
    sub: "Rows stay in a separate engine process, so big results never freeze the window",
  },
  {
    kind: "clip",
    scene: "completion",
    kicker: "Completion",
    title: "Completion that knows your schema",
    sub: "Tables after FROM, whole join conditions after JOIN, an alias's columns after o.",
  },
  {
    kind: "clip",
    scene: "table-editor",
    kicker: "Table editor",
    title: "Edit data — and see the SQL first",
    sub: "Change cells, add or delete rows, preview the statements, submit in one transaction",
  },
  {
    kind: "clip",
    scene: "explain",
    kicker: "Explain plan",
    title: "Query plans as a tree",
    sub: "Estimated and actual rows, costs and timings",
  },
  {
    kind: "card",
    seconds: 3.5,
    kicker: "Now the fun part",
    title: "Let an AI agent in — safely",
    titlePx: 84,
    sub: "TableCraft serves your data sources over MCP to Claude Code, OpenCode or Cursor",
  },
  {
    kind: "clip",
    scene: "agents-setup",
    kicker: "MCP server",
    title: "One switch, one copied config",
    sub: "Each data source starts Off for agents: choose Read only, or Ask before writes",
  },
  {
    kind: "clip",
    scene: "agents-warp",
    kicker: "Agent at work · OpenCode",
    title: "“Restock products under 5 to 50”",
    sub: "It explores and reads freely; the UPDATE waits for your approval, with its query plan",
  },
  {
    kind: "clip",
    scene: "agents-consoles",
    kicker: "Agent drafts, you run",
    title: "Agents write SQL into a console for you",
    sub: "Draft, edit, open a table filtered — nothing in the console runs until you do",
  },
  {
    kind: "card",
    seconds: 5,
    logo: true,
    title: "TableCraft",
    titlePx: 88,
    sub: "MIT licensed · macOS, Windows, Linux",
    pills: ["PostgreSQL", "MySQL / MariaDB / TiDB", "SQLite", "SQL Server", "Oracle", "DuckDB", "Redis", "etcd"],
    url: "github.com/tranphucbol/table-craft",
  },
];
