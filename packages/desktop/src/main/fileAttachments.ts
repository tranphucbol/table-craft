import { z } from "@table-craft/plugin-api";
import { writeAtomically, type FileSystem } from "@table-craft/desktop/main/files.js";
import type { FileAttachment } from "@table-craft/desktop/preload/bridge.js";

/** Under the profile directory (plan 041, decision 5). */
export const FILE_ATTACHMENTS_FILE = "fileAttachments.json";
export const RECENT_FILES_MAX = 10;
/** Paths opened over years; the oldest attachment is forgotten past this. */
export const ATTACHMENTS_MAX = 500;
const JSON_INDENT = 2;

const attachmentSchema = z.object({
  datasourceId: z.string(),
  namespace: z.array(z.string()).nullable(),
});

const documentSchema = z.object({
  recent: z.array(z.string()).catch([]),
  attachments: z.record(z.string(), attachmentSchema.catch({ datasourceId: "", namespace: null })).catch({}),
});

interface FileAttachmentsDocument {
  recent: string[];
  /** Insertion order is age: the most recently attached path is last. */
  attachments: Map<string, FileAttachment>;
}

export interface FileAttachments {
  attachmentOf(path: string): Promise<FileAttachment | null>;
  attach(path: string, attachment: FileAttachment): Promise<void>;
  /** Moves `path` to the front of the recent files and returns them. */
  opened(path: string): Promise<readonly string[]>;
  /** Carries the attachment and the recent entry over to the file's new path. */
  renamed(from: string, to: string): Promise<readonly string[]>;
  /** Most recent first. */
  recent(): Promise<readonly string[]>;
}

export interface FileAttachmentsOptions {
  /** The document's path in the profile. */
  readonly path: string;
  readonly files: FileSystem;
}

/** Remembers per SQL file its data source and namespace, and the recent files, in one profile document. */
export function createFileAttachments(options: FileAttachmentsOptions): FileAttachments {
  const { files, path } = options;
  let loaded: Promise<FileAttachmentsDocument> | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function read(): Promise<FileAttachmentsDocument> {
    const text = await files.readText(path).catch(() => null);
    let json: unknown = {};
    try {
      json = text === null ? {} : JSON.parse(text);
    } catch {
      // An unreadable document starts over: it only remembers conveniences.
    }
    const parsed = documentSchema.safeParse(json);
    const document = parsed.success ? parsed.data : { recent: [], attachments: {} };
    return {
      recent: document.recent.slice(0, RECENT_FILES_MAX),
      attachments: new Map(
        Object.entries(document.attachments).filter(([, attachment]) => attachment.datasourceId !== ""),
      ),
    };
  }

  function documentOf(): Promise<FileAttachmentsDocument> {
    loaded ??= read();
    return loaded;
  }

  async function save(document: FileAttachmentsDocument): Promise<void> {
    const text = JSON.stringify(
      { recent: document.recent, attachments: Object.fromEntries(document.attachments) },
      null,
      JSON_INDENT,
    );
    writing = writing.then(() => writeAtomically(files, path, text)).catch(() => undefined);
    await writing;
  }

  function front(recent: readonly string[], entry: string): string[] {
    return [entry, ...recent.filter((candidate) => candidate !== entry)].slice(0, RECENT_FILES_MAX);
  }

  return {
    async attachmentOf(file) {
      return (await documentOf()).attachments.get(file) ?? null;
    },
    async attach(file, attachment) {
      const document = await documentOf();
      document.attachments.delete(file);
      document.attachments.set(file, attachment);
      for (const oldest of document.attachments.keys()) {
        if (document.attachments.size <= ATTACHMENTS_MAX) break;
        document.attachments.delete(oldest);
      }
      await save(document);
    },
    async opened(file) {
      const document = await documentOf();
      document.recent = front(document.recent, file);
      await save(document);
      return document.recent;
    },
    async renamed(from, to) {
      const document = await documentOf();
      const attachment = document.attachments.get(from);
      document.attachments.delete(from);
      if (attachment !== undefined) document.attachments.set(to, attachment);
      document.recent = front(
        document.recent.filter((candidate) => candidate !== from),
        to,
      );
      await save(document);
      return document.recent;
    },
    async recent() {
      return (await documentOf()).recent;
    },
  };
}
