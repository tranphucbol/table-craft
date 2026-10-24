import { create } from "zustand";
import type {
  DdlScript,
  ImportErrorPolicy,
  ImportFormat,
  ImportMapping,
  ImportPreview,
  ImportTransaction,
  NewImportColumn,
  ObjectFeatures,
  TableDesign,
} from "@table-craft/desktop/engine/protocol.js";
import type { HistoryStatement } from "@table-craft/desktop/preload/bridge.js";

/** A line of a confirmation's list: a statement and why it is listed, say. */
export interface ModalItem {
  readonly label: string;
  readonly detail: string;
  /** A detail reports a problem unless it says it is `info`, as a list of what an export holds. */
  readonly tone?: "info";
}

/** A line of a `pick`; its `id` is the answer. */
export interface PickItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/** A button of a `choice`; its `id` is the answer. */
export interface ModalChoice {
  readonly id: string;
  readonly label: string;
  readonly variant?: "primary" | "secondary" | "danger";
}

/** A question that blocks the window until answered. */
export type ModalRequest =
  | {
      readonly kind: "confirm";
      readonly title: string;
      readonly message: string;
      readonly items?: readonly ModalItem[];
      readonly confirm: string;
      readonly destructive?: boolean;
      /** Text the user must type before the confirm button works, for a kill on a production-coloured data source. */
      readonly typed?: string;
    }
  | {
      readonly kind: "text";
      readonly title: string;
      readonly label: string;
      readonly initial: string;
      readonly confirm: string;
      readonly placeholder?: string;
    }
  | {
      readonly kind: "notice";
      readonly title: string;
      readonly message: string;
      readonly hint: string;
      /** A notice reports a failure unless it says it is `info`, like About. */
      readonly tone?: "info";
      /** The engine request that failed, for the failure's Show in Log (plan 017 decision 12). */
      readonly requestId?: number | null;
    }
  | {
      /** SQL shown whole, one statement a block, before it runs: the table editor's Preview. */
      readonly kind: "statements";
      readonly title: string;
      readonly message: string;
      readonly statements: readonly string[];
      readonly confirm: string;
    }
  | {
      readonly kind: "choice";
      readonly title: string;
      readonly message: string;
      readonly items?: readonly ModalItem[];
      /** Shown before Cancel, the first one focused. */
      readonly choices: readonly ModalChoice[];
    }
  | {
      /**
       * The SQL Generator (plan 010 decision 13): one statement kind at a time, previewed as
       * `generate` answers it; resolves `generatorAnswer(button, statement)`.
       */
      readonly kind: "generator";
      readonly title: string;
      readonly statements: readonly ModalChoice[];
      readonly initial: string;
      readonly highlight: string | null | undefined;
      readonly generate: (statement: string) => Promise<string>;
      readonly choices: readonly ModalChoice[];
    }
  | {
      /**
       * Query History (plan 011 decision 8): `search` answers as the field changes; resolves
       * `pickerAnswer(choice, sql)` for a `HISTORY_CHOICES` choice.
       */
      readonly kind: "history";
      readonly title: string;
      readonly search: (query: string) => Promise<readonly HistoryStatement[]>;
      readonly highlight: string | null | undefined;
      /** `Insert` into the console it was opened from, or `Open in Console`. */
      readonly restore: string;
      /** Epoch milliseconds the dialog opened at; entries from that day show only their time. */
      readonly now: number;
    }
  | {
      /**
       * Export Data (decision 040): a format, the columns and a file; resolves `exportAnswer`.
       * `browse` asks main's save dialog for a file named for the chosen format.
       */
      readonly kind: "export";
      readonly title: string;
      readonly formats: readonly ModalChoice[];
      readonly initialFormat: string;
      readonly columns: readonly string[];
      /** Indices into `columns` checked when the dialog opens. */
      readonly chosen: readonly number[];
      readonly browse: (format: string, current: string) => Promise<string | null>;
      /** The typed or browsed path with its extension swapped for `format`'s. */
      readonly retarget: (path: string, format: string) => string;
      /** Where the rows come from, said under the title. */
      readonly note: string;
      /**
       * While the grid hides or reorders rows (plan 023), a choice between the rows it shows and
       * the whole result, opening on the shown ones; `note` then describes the whole result.
       */
      readonly rows?: { readonly shownLabel: string; readonly wholeLabel: string; readonly shownNote: string };
    }
  | {
      /**
       * Import Data (plan 021): a file, its format with a preview, where each column goes and what
       * a bad row or a lost link leaves; resolves `importAnswer`.
       */
      readonly kind: "import";
      readonly title: string;
      /** Where the rows go, said under the title. */
      readonly note: string;
      /** The existing table's columns; null when the import creates the table. */
      readonly columns: readonly string[] | null;
      /** The new table's suggested name; the existing table's name otherwise. */
      readonly relation: string;
      readonly browse: () => Promise<string | null>;
      readonly preview: (file: string, format: ImportFormat) => Promise<ImportPreview>;
      readonly ddl: (relation: string, columns: readonly NewImportColumn[]) => Promise<string>;
      readonly highlight: string | null | undefined;
    }
  | {
      /** One item out of a searchable list, such as a datasource or a recent file; resolves the item's id. */
      readonly kind: "pick";
      readonly title: string;
      readonly searchLabel: string;
      readonly items: readonly PickItem[];
      readonly empty: string;
      readonly confirm: string;
    }
  | {
      /** Open Closed Console (plan 011 decision 14): resolves `pickerAnswer(choice, name)` for a `CLOSED_CONSOLE_CHOICES` choice. */
      readonly kind: "closedConsoles";
      readonly title: string;
      readonly names: readonly string[];
      readonly read: (name: string) => Promise<string>;
      readonly highlight: string | null | undefined;
    }
  | {
      /** The Parameters dialog (plan 019 decision 6): resolves `parametersAnswer(values)`. */
      readonly kind: "parameters";
      readonly title: string;
      /** One row per name, in the order the statements first use them. */
      readonly names: readonly string[];
      readonly initial: Readonly<Record<string, string | null>>;
      /** The statements, each with the spans its placeholders occupy. */
      readonly statements: readonly MarkedStatement[];
    }
  | {
      /**
       * New Table and Modify Table (plan 024): the design edited in tabs, previewed as the plugin
       * scripts it; resolves `objectAnswer`.
       */
      readonly kind: "tableDesign";
      readonly title: string;
      /** Where the table is, said under the title. */
      readonly note: string;
      readonly initial: TableDesign;
      readonly features: ObjectFeatures;
      /** The namespace a foreign key's target is looked up in. */
      readonly path: readonly string[];
      /** The tables a foreign key can reference, with their columns. */
      readonly targets: readonly DesignTarget[];
      readonly preview: (design: TableDesign) => Promise<DdlScript>;
      readonly highlight: string | null | undefined;
    }
  | {
      /**
       * Rename, Truncate, Drop and New Schema (plan 024): what changes, the script that does it
       * and, where the plugin supports it, Cascade; resolves `objectAnswer`.
       */
      readonly kind: "objectChange";
      readonly title: string;
      readonly message: string;
      readonly items?: readonly ModalItem[];
      readonly confirm: string;
      readonly destructive: boolean;
      /** Cascade's initial state; null when the change has no such choice. */
      readonly cascade: boolean | null;
      readonly preview: (cascade: boolean) => Promise<DdlScript>;
      readonly highlight: string | null | undefined;
    };

/** A table a foreign key can reference. */
export interface DesignTarget {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface MarkedStatement {
  readonly sql: string;
  readonly marks: readonly { readonly from: number; readonly to: number }[];
}

export const HISTORY_CHOICES = { restore: "restore", copy: "copy", clear: "clear" } as const;
export const CLOSED_CONSOLE_CHOICES = { open: "open", delete: "delete" } as const;

/**
 * Confirm and statements resolve "" when accepted; text resolves what was typed; choice resolves the chosen
 * id, generator its `generatorAnswer`, the pickers their `pickerAnswer`; every kind resolves null on cancel.
 */
export type ModalAnswer = string | null;

const GENERATOR_SEPARATOR = ":";

/** A generator's answer: the button chosen and the statement showing when it was. */
export function generatorAnswer(choice: string, statement: string): string {
  return `${choice}${GENERATOR_SEPARATOR}${statement}`;
}

/** A picker's answer: the button chosen and the item it acts on. */
export const pickerAnswer = generatorAnswer;

export function parseGeneratorAnswer(answer: string): { readonly choice: string; readonly statement: string } {
  const at = answer.indexOf(GENERATOR_SEPARATOR);
  return { choice: answer.slice(0, at), statement: answer.slice(at + GENERATOR_SEPARATOR.length) };
}

/** What the Export Data dialog answers. */
export interface ExportAnswer {
  readonly format: string;
  readonly columns: readonly number[];
  readonly path: string;
  /** The rows the grid shows rather than the whole result; only when the request offered `rows`. */
  readonly shownOnly?: boolean;
}

export function exportAnswer(answer: ExportAnswer): string {
  return JSON.stringify(answer);
}

export function parseExportAnswer(answer: string): ExportAnswer {
  return JSON.parse(answer) as ExportAnswer;
}

/** What the Import Data dialog answers: `mapping` for an existing table, `columns` for a new one. */
export interface ImportAnswer {
  readonly file: string;
  readonly format: ImportFormat;
  readonly relation: string;
  readonly mapping: readonly ImportMapping[] | null;
  readonly columns: readonly NewImportColumn[] | null;
  readonly transaction: ImportTransaction;
  readonly errors: ImportErrorPolicy;
}

export function importAnswer(answer: ImportAnswer): string {
  return JSON.stringify(answer);
}

export function parseImportAnswer(answer: string): ImportAnswer {
  return JSON.parse(answer) as ImportAnswer;
}

export const OBJECT_CHOICES = { apply: "apply", console: "console" } as const;

/**
 * What the table design and object change dialogs answer: Apply or Open in Console, and the script
 * shown when it was chosen, which Apply hands back to the engine to check against its own.
 */
export interface ObjectAnswer {
  readonly choice: (typeof OBJECT_CHOICES)[keyof typeof OBJECT_CHOICES];
  readonly script: DdlScript;
  readonly design: TableDesign | null;
  readonly cascade: boolean;
}

export function objectAnswer(answer: ObjectAnswer): string {
  return JSON.stringify(answer);
}

export function parseObjectAnswer(answer: string): ObjectAnswer {
  return JSON.parse(answer) as ObjectAnswer;
}

/** The radio group's arrow keys, as WAI-ARIA's radio group pattern moves them. */
const STEP_KEYS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

/** The generator statement an arrow key moves to from `current`, wrapping; null for any other key. */
export function steppedStatement(statements: readonly string[], current: string, key: string): string | null {
  const step = STEP_KEYS[key];
  if (step === undefined || statements.length === 0) return null;
  const at = Math.max(statements.indexOf(current), 0);
  return statements[(at + step + statements.length) % statements.length] ?? null;
}

interface Pending {
  readonly request: ModalRequest;
  readonly resolve: (answer: ModalAnswer) => void;
}

export interface ModalState {
  readonly pending: Pending | null;
  readonly ask: (request: ModalRequest) => Promise<ModalAnswer>;
  readonly answer: (answer: ModalAnswer) => void;
}

export const useModal = create<ModalState>()((set, get) => ({
  pending: null,
  ask(request) {
    get().pending?.resolve(null);
    return new Promise((resolve) => set({ pending: { request, resolve } }));
  },
  answer(answer) {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(answer);
  },
}));

export function parsePickerAnswer(answer: string): { readonly choice: string; readonly value: string } {
  const { choice, statement } = parseGeneratorAnswer(answer);
  return { choice, value: statement };
}
