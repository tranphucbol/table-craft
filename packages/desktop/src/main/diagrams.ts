import { join } from "node:path";
import { z } from "@table-craft/plugin-api";
import { writeAtomically, type FileSystem } from "@table-craft/desktop/main/files.js";
import {
  DEFAULT_DIAGRAM_STATE,
  DIAGRAM_COLUMN_MODES,
  type DiagramState,
  type VirtualKey,
} from "@table-craft/desktop/diagrams/state.js";

export const DIAGRAMS_FILE = "diagrams.json";
const DIAGRAMS_VERSION = 1;
const BACKUP_SUFFIX = ".corrupt-";
const JSON_INDENT = 2;

const pathSchema = z.array(z.string());
const columnsSchema = z.array(z.string().min(1)).min(1);

const virtualKeySchema = z.strictObject({
  id: z.string().min(1),
  path: pathSchema,
  relation: z.string().min(1),
  columns: columnsSchema,
  target: z.strictObject({ path: pathSchema, relation: z.string().min(1), columns: columnsSchema }),
}) satisfies z.ZodType<VirtualKey>;

const layoutSchema = z.strictObject({
  positions: z.record(z.string(), z.strictObject({ x: z.number().finite(), y: z.number().finite() })),
  hiddenTables: z.array(z.string()),
  columns: z.enum(DIAGRAM_COLUMN_MODES),
});

/** One datasource's state as the renderer sends it on `diagrams.save`; untrusted, so checked whole. */
export const diagramStateSchema = z.strictObject({
  inferKeys: z.boolean(),
  hiddenKeys: z.array(z.string()),
  virtualKeys: z.array(virtualKeySchema),
  layouts: z.record(z.string(), layoutSchema),
}) satisfies z.ZodType<DiagramState>;

const documentSchema = z.strictObject({
  version: z.literal(DIAGRAMS_VERSION),
  datasources: z.record(z.string(), diagramStateSchema),
});

type Datasources = Readonly<Record<string, DiagramState>>;

export class DiagramsError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "DiagramsError";
  }
}

/** Positions, hidden and virtual keys per datasource (plan 152, decision 8). Only main writes the file. */
export interface DiagramsService {
  get(datasourceId: string): Promise<DiagramState>;
  save(datasourceId: string, state: DiagramState): Promise<void>;
  /** Forgets deleted datasources; ids with nothing saved are skipped. */
  delete(datasourceIds: readonly string[]): Promise<void>;
}

export interface DiagramsServiceOptions {
  readonly directory: string;
  readonly files: FileSystem;
  readonly now?: () => number;
  /** Told once, when an unreadable file is set aside. */
  readonly onWarning?: (warning: string) => void;
}

function problemOf(text: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return `not JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  const parsed = documentSchema.safeParse(json);
  if (parsed.success) return null;
  return parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

export function createDiagramsService(options: DiagramsServiceOptions): DiagramsService {
  const path = join(options.directory, DIAGRAMS_FILE);
  const now = options.now ?? Date.now;
  /** Read once; afterwards main's copy is the truth, and every change is written through it. */
  let loaded: Datasources | null = null;
  /** Writes run one at a time: two at once would share the temporary file and could land out of order. */
  let pending: Promise<unknown> = Promise.resolve();

  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(run);
    pending = result.catch(() => undefined);
    return result;
  }

  async function load(): Promise<Datasources> {
    if (loaded !== null) return loaded;
    const text = await options.files.readText(path);
    if (text === null) return (loaded = {});
    const problem = problemOf(text);
    if (problem === null) return (loaded = documentSchema.parse(JSON.parse(text)).datasources);
    const backup = `${path}${BACKUP_SUFFIX}${String(now())}`;
    await options.files.rename(path, backup);
    options.onWarning?.(
      `${DIAGRAMS_FILE} could not be read (${problem}). It was moved to ${backup}, and every diagram starts from its automatic layout.`,
    );
    return (loaded = {});
  }

  async function write(datasources: Datasources): Promise<void> {
    try {
      await writeAtomically(
        options.files,
        path,
        `${JSON.stringify({ version: DIAGRAMS_VERSION, datasources }, null, JSON_INDENT)}\n`,
      );
    } catch (cause) {
      throw new DiagramsError(
        `Could not save ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        "Check available disk space and write permissions, then move a table to save again. The previous file has been kept.",
      );
    }
    loaded = datasources;
  }

  return {
    get: (datasourceId) =>
      serialized(async () => {
        const current = await load();
        return Object.hasOwn(current, datasourceId)
          ? (current[datasourceId] ?? DEFAULT_DIAGRAM_STATE)
          : DEFAULT_DIAGRAM_STATE;
      }),
    save: (datasourceId, state) =>
      serialized(async () => {
        await write({ ...(await load()), [datasourceId]: diagramStateSchema.parse(state) });
      }),
    delete: (datasourceIds) =>
      serialized(async () => {
        const current = await load();
        if (!datasourceIds.some((id) => Object.hasOwn(current, id))) return;
        await write(Object.fromEntries(Object.entries(current).filter(([id]) => !datasourceIds.includes(id))));
      }),
  };
}
