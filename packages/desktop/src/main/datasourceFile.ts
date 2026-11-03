import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { z } from "@table-craft/plugin-api";
import { datasourceSchema } from "@table-craft/desktop/main/datasources.js";
import type { Datasource } from "@table-craft/desktop/preload/bridge.js";

export const DATASOURCE_FILE_FORMAT = "table-craft-datasources";
export const DATASOURCE_FILE_VERSION = 1;
export const DATASOURCE_FILE_NAME = "tablecraft-datasources.json";

/** The cost a new file is sealed with; each file names its own, so a later build can raise these. */
export const SCRYPT_PARAMETERS: ScryptParameters = { N: 2 ** 17, r: 8, p: 1 };
/** Node refuses scrypt above `maxmem`; 128·N·r bytes must fit, which N = 2^17, r = 8 does twice over. */
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const SCRYPT_MAX_PARALLELISM = 16;
const KDF = "scrypt";
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const JSON_INDENT = 2;
/** Machine-local: what one connection last saw is no fact about the data source elsewhere (decision 131). */
const MACHINE_FIELD = "lastServer";

export const NEWER_SETTINGS_WARNING = "Some settings from a newer TableCraft were left out.";
const UNREADABLE_RECORD_WARNING = "This data source could not be read from the file.";

export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** A data source as the file carries it: the stored record without what one machine saw. */
export type ExportedDatasource = Omit<Datasource, "lastServer">;

/** Secret values by data source id, then by secret key. */
export type DatasourceSecrets = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface DatasourceFileContent {
  readonly folders: readonly string[];
  readonly datasources: readonly Datasource[];
  readonly secrets?: DatasourceSecrets | undefined;
}

export interface ReadRecord {
  /** The data source's id in the file, or its position when the file has none. */
  readonly id: string;
  readonly name: string;
  /** Null when the record could not be read; `warnings` says so. */
  readonly datasource: ExportedDatasource | null;
  readonly warnings: readonly string[];
}

export interface ReadDatasourceFile {
  readonly folders: readonly string[];
  readonly records: readonly ReadRecord[];
  /** The decrypted passwords; null when the file holds none or they were skipped. */
  readonly secrets: DatasourceSecrets | null;
}

export interface ReadOptions {
  readonly passphrase?: string | undefined;
  /** Reads an encrypted file without asking for its passphrase, leaving its passwords out. */
  readonly skipSecrets?: boolean | undefined;
}

export type DatasourceFileProblem = "notOurs" | "newerVersion" | "needsPassphrase" | "wrongPassphrase";

const PROBLEM_MESSAGES: Readonly<Record<DatasourceFileProblem, string>> = {
  notOurs: "This is not a TableCraft data sources file.",
  newerVersion: "This file was exported by a newer TableCraft. Update TableCraft to import it.",
  needsPassphrase: "This file's passwords are encrypted; enter the passphrase it was exported with.",
  wrongPassphrase: "That passphrase does not open this file's passwords.",
};

export class DatasourceFileError extends Error {
  override readonly name = "DatasourceFileError";
  constructor(readonly problem: DatasourceFileProblem) {
    super(PROBLEM_MESSAGES[problem]);
  }
}

const recordSchema = datasourceSchema.omit({ lastServer: true });
const recordFields: Readonly<Record<string, z.ZodType>> = recordSchema.shape;

const sealedSchema = z.strictObject({
  kdf: z.literal(KDF),
  N: z
    .number()
    .int()
    .min(2)
    .refine((n) => (n & (n - 1)) === 0, "N is a power of two."),
  r: z.number().int().positive(),
  p: z.number().int().positive().max(SCRYPT_MAX_PARALLELISM),
  salt: z.base64(),
  iv: z.base64(),
  tag: z.base64(),
  data: z.base64(),
});
type Sealed = z.output<typeof sealedSchema>;

const headerSchema = z.looseObject({ format: z.literal(DATASOURCE_FILE_FORMAT), version: z.number().int().positive() });

const fileSchema = z.looseObject({
  folders: z.array(z.string().min(1)),
  datasources: z.array(z.unknown()),
  secrets: sealedSchema.optional(),
});

const secretsSchema = z.record(z.string(), z.record(z.string(), z.string()));

function deriveKey(passphrase: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEY_BYTES, { ...parameters, maxmem: SCRYPT_MAX_MEMORY }, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

async function seal(secrets: DatasourceSecrets, passphrase: string, parameters: ScryptParameters): Promise<Sealed> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, await deriveKey(passphrase, salt, parameters), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return {
    kdf: KDF,
    ...parameters,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

async function unseal(sealed: Sealed, passphrase: string): Promise<DatasourceSecrets> {
  const { N, r, p } = sealed;
  if (128 * N * r > SCRYPT_MAX_MEMORY) throw new DatasourceFileError("newerVersion");
  const key = await deriveKey(passphrase, Buffer.from(sealed.salt, "base64"), { N, r, p });
  const tag = Buffer.from(sealed.tag, "base64");
  if (tag.length !== TAG_BYTES) throw new DatasourceFileError("notOurs");
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(sealed.iv, "base64"), { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  let text: string;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // GCM's tag check is the only answer a wrong passphrase gets.
    throw new DatasourceFileError("wrongPassphrase");
  }
  const parsed = secretsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new DatasourceFileError("notOurs");
  return parsed.data;
}

function withoutMachineFields(datasource: Datasource): ExportedDatasource {
  return Object.fromEntries(
    Object.entries(datasource).filter(([key]) => key !== MACHINE_FIELD),
  ) as unknown as ExportedDatasource;
}

function hasAnySecret(secrets: DatasourceSecrets | undefined): secrets is DatasourceSecrets {
  return secrets !== undefined && Object.values(secrets).some((values) => Object.keys(values).length > 0);
}

/**
 * The file Export Data Sources writes (plan 040, decision 153). Secrets go in only with a
 * passphrase, sealed with AES-256-GCM under an scrypt key; without one the file holds none.
 */
export async function writeDatasourceFile(
  content: DatasourceFileContent,
  passphrase?: string,
  options: { readonly now?: Date; readonly kdf?: ScryptParameters } = {},
): Promise<string> {
  const sealed =
    passphrase !== undefined && hasAnySecret(content.secrets)
      ? await seal(content.secrets, passphrase, options.kdf ?? SCRYPT_PARAMETERS)
      : undefined;
  const document = {
    format: DATASOURCE_FILE_FORMAT,
    version: DATASOURCE_FILE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    folders: content.folders,
    datasources: content.datasources.map(withoutMachineFields),
    ...(sealed === undefined ? {} : { secrets: sealed }),
  };
  return `${JSON.stringify(document, null, JSON_INDENT)}\n`;
}

/** Whether the text is a TableCraft data sources document of any version, before reading it. */
export function isDatasourceFile(text: string): boolean {
  try {
    return headerSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/**
 * Keeps each field that reads the way `datasources.json` would; one it does not know, or cannot
 * read, is dropped with a warning rather than costing the whole data source.
 */
function readRecord(raw: unknown, index: number): ReadRecord {
  const position = `#${String(index + 1)}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { id: position, name: "", datasource: null, warnings: [UNREADABLE_RECORD_WARNING] };
  }
  const entries = raw as Record<string, unknown>;
  const id = typeof entries.id === "string" && entries.id !== "" ? entries.id : position;
  const name = typeof entries.name === "string" ? entries.name : "";
  const kept: Record<string, unknown> = {};
  let dropped = false;
  for (const [key, value] of Object.entries(entries)) {
    if (key === MACHINE_FIELD) continue;
    const field = recordFields[key];
    const parsed = field?.safeParse(value);
    if (parsed?.success === true) {
      if (parsed.data !== undefined) kept[key] = parsed.data;
    } else {
      dropped = true;
    }
  }
  const record = recordSchema.safeParse(kept);
  if (!record.success) return { id, name, datasource: null, warnings: [UNREADABLE_RECORD_WARNING] };
  return { id, name, datasource: record.data, warnings: dropped ? [NEWER_SETTINGS_WARNING] : [] };
}

/** Reads an exported file; throws `DatasourceFileError` for one it cannot read as a whole. */
export async function readDatasourceFile(text: string, options: ReadOptions = {}): Promise<ReadDatasourceFile> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DatasourceFileError("notOurs");
  }
  const header = headerSchema.safeParse(json);
  if (!header.success) throw new DatasourceFileError("notOurs");
  if (header.data.version > DATASOURCE_FILE_VERSION) throw new DatasourceFileError("newerVersion");
  const file = fileSchema.safeParse(json);
  if (!file.success) throw new DatasourceFileError("notOurs");
  const { folders, datasources, secrets: sealed } = file.data;
  const records = datasources.map(readRecord);
  if (sealed === undefined || options.skipSecrets === true) return { folders, records, secrets: null };
  if (options.passphrase === undefined || options.passphrase === "") throw new DatasourceFileError("needsPassphrase");
  return { folders, records, secrets: await unseal(sealed, options.passphrase) };
}
