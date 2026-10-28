import { z } from "zod";
import { CAPABILITIES } from "./plugin.js";
import { parseVersion } from "./version.js";

/** The file that marks a directory as a plugin (decision 005). */
export const MANIFEST_FILE = "table-craft-plugin.json";

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

const semver = z.string().refine((text) => parseVersion(text) !== null, { message: "expected major.minor.patch" });

/**
 * What the loader reads before executing any plugin code, so an unavailable plugin can still be
 * named in the UI.
 */
export const CONNECTION_FIELD_KINDS = ["text", "number", "password", "file", "select", "checkbox"] as const;

export type ConnectionFieldKind = (typeof CONNECTION_FIELD_KINDS)[number];

export const CONNECTION_FIELD_GROUPS = ["general", "advanced"] as const;

export type ConnectionFieldGroup = (typeof CONNECTION_FIELD_GROUPS)[number];

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * One control of the connection form (decision 019). `key` names the config property it fills;
 * `secret` sends the value to the secret store instead of `datasources.json` (decision 020).
 */
export const connectionFieldSchema = z.strictObject({
  key: z.string().regex(FIELD_KEY, { message: "expected a camelCase config key" }),
  label: z.string().min(1),
  kind: z.enum(CONNECTION_FIELD_KINDS),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  /** The choices of a `select`, in display order. */
  options: z
    .array(z.strictObject({ value: z.string(), label: z.string().min(1) }))
    .min(1)
    .optional(),
  group: z.enum(CONNECTION_FIELD_GROUPS).optional(),
  secret: z.boolean().optional(),
  /**
   * Draw the field only while the `select` or `checkbox` named by `key` holds `equals` (plan 058);
   * a hidden field is neither checked nor required.
   */
  visibleWhen: z
    .strictObject({ key: z.string().regex(FIELD_KEY), equals: z.union([z.string(), z.boolean()]) })
    .optional(),
});

export type ConnectionField = z.infer<typeof connectionFieldSchema>;

/** `server`: `scheme://user:password@host:port/database?params`; `file`: a path, bare or as a URL. */
export const CONNECTION_URL_FORMS = ["server", "file"] as const;

export type ConnectionUrlForm = (typeof CONNECTION_URL_FORMS)[number];

/** The pieces of a connection URL a field can take; `path` belongs to the `file` form. */
export const CONNECTION_URL_PARTS = ["host", "port", "database", "user", "password", "path"] as const;

export type ConnectionUrlPart = (typeof CONNECTION_URL_PARTS)[number];

const URL_SCHEME = /^[a-z][a-z0-9+.-]*$/;

/**
 * How a connection URL maps onto the form's fields (decision 055), so the host parses and writes
 * one without running plugin code. `parts` names the field each piece of the URL fills; a query
 * parameter fills `key`, its value translated through `values` (compared case-insensitively) when
 * given, so a value outside them is reported as ignored.
 */
export const connectionUrlSchema = z.strictObject({
  /** Without `://`; the first is the one the host writes. */
  schemes: z.array(z.string().regex(URL_SCHEME, { message: "expected a lower-case URL scheme" })).min(1),
  form: z.enum(CONNECTION_URL_FORMS),
  parts: z.partialRecord(z.enum(CONNECTION_URL_PARTS), z.string().regex(FIELD_KEY)),
  params: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        key: z.string().regex(FIELD_KEY),
        values: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  /**
   * Field values a scheme implies, keyed by scheme, such as `rediss` setting the TLS mode (plan
   * 058). A pasted URL fills them; a written URL takes the first scheme whose values the config holds.
   */
  sets: z
    .record(
      z.string().regex(URL_SCHEME),
      z.record(z.string().regex(FIELD_KEY), z.union([z.string(), z.number(), z.boolean()])),
    )
    .optional(),
  /**
   * The JDBC SQL Server form, `scheme://host[\instance][:port][;name=value…]` (plan 055): parameters
   * follow `;`, a `{…}` value may hold one, and `\instance` is the parameter `instanceName`.
   */
  semicolonParams: z.boolean().optional(),
});

export type ConnectionUrl = z.infer<typeof connectionUrlSchema>;

/**
 * Which fields hold the server's address (decision 070), so the host can open an SSH tunnel and
 * hand the plugin `127.0.0.1` and the forwarded port instead. `connectTimeout`, in seconds, bounds
 * the SSH hop too. Absent: the data source is not reached over the network and offers no tunnel.
 */
export const networkSpecSchema = z.strictObject({
  host: z.string().regex(FIELD_KEY),
  port: z.string().regex(FIELD_KEY),
  connectTimeout: z.string().regex(FIELD_KEY).optional(),
});

export type NetworkSpec = z.infer<typeof networkSpecSchema>;

const NETWORK_FIELD_KINDS = { host: "text", port: "number", connectTimeout: "number" } as const;

function networkFieldsDeclared(connection: {
  readonly fields: readonly ConnectionField[];
  readonly network?: NetworkSpec | undefined;
}): boolean {
  const network = connection.network;
  if (network === undefined) return true;
  return (Object.keys(NETWORK_FIELD_KINDS) as (keyof NetworkSpec)[]).every((role) => {
    const key = network[role];
    if (key === undefined) return true;
    return connection.fields.some((field) => field.key === key && field.kind === NETWORK_FIELD_KINDS[role]);
  });
}

/**
 * Which fields configure TLS (decision 072), so the dialog groups them under SSL, hints when a CA
 * file goes unchecked, and main asks for the key passphrase only when the key file is encrypted.
 * `mode` is the `select` of SSL modes; `verifyModes` are its values that check the server
 * certificate. Absent: the plugin speaks no TLS the host knows about.
 */
export const tlsSpecSchema = z.strictObject({
  mode: z.string().regex(FIELD_KEY),
  verifyModes: z.array(z.string().min(1)).min(1),
  caFile: z.string().regex(FIELD_KEY).optional(),
  certFile: z.string().regex(FIELD_KEY).optional(),
  keyFile: z.string().regex(FIELD_KEY).optional(),
  keyPassphrase: z.string().regex(FIELD_KEY).optional(),
});

export type TlsSpec = z.infer<typeof tlsSpecSchema>;

/** The roles of `TlsSpec` that name a field, in the order the dialog draws them. */
export const TLS_FIELD_ROLES = ["mode", "caFile", "certFile", "keyFile", "keyPassphrase"] as const;

export type TlsFieldRole = (typeof TLS_FIELD_ROLES)[number];

function tlsFieldFits(role: TlsFieldRole, field: ConnectionField, tls: TlsSpec): boolean {
  switch (role) {
    case "mode": {
      const values = new Set((field.options ?? []).map((option) => option.value));
      return field.kind === "select" && tls.verifyModes.every((mode) => values.has(mode));
    }
    case "keyPassphrase":
      return field.kind === "password" && field.secret === true;
    default:
      return field.kind === "file";
  }
}

function tlsFieldsDeclared(connection: {
  readonly fields: readonly ConnectionField[];
  readonly tls?: TlsSpec | undefined;
}): boolean {
  const tls = connection.tls;
  if (tls === undefined) return true;
  return TLS_FIELD_ROLES.every((role) => {
    const key = tls[role];
    if (key === undefined) return true;
    const field = connection.fields.find((candidate) => candidate.key === key);
    return field !== undefined && tlsFieldFits(role, field, tls);
  });
}

/** Every `visibleWhen` names another field of the form, a `select` or a `checkbox`. */
function visibilityFieldsDeclared(connection: { readonly fields: readonly ConnectionField[] }): boolean {
  return connection.fields.every((field) => {
    const condition = field.visibleWhen;
    if (condition === undefined) return true;
    const source = connection.fields.find((candidate) => candidate.key === condition.key);
    return (
      source !== undefined &&
      source !== field &&
      (source.kind === "select" || source.kind === "checkbox") &&
      typeof condition.equals === (source.kind === "checkbox" ? "boolean" : "string")
    );
  });
}

/** Every scheme `url.sets` keys is one of `url.schemes`, and every value it sets is a declared field's. */
function urlSetsDeclared(connection: {
  readonly fields: readonly ConnectionField[];
  readonly url?: ConnectionUrl | undefined;
}): boolean {
  const url = connection.url;
  if (url?.sets === undefined) return true;
  return Object.entries(url.sets).every(
    ([scheme, values]) =>
      url.schemes.includes(scheme) &&
      Object.keys(values).every((key) => connection.fields.some((field) => field.key === key)),
  );
}

function includesAny(capabilities: readonly string[], ...wanted: readonly string[]): boolean {
  return wanted.some((capability) => capabilities.includes(capability));
}

export const pluginManifestSchema = z
  .strictObject({
    id: z.string().regex(PLUGIN_ID, { message: "expected lower-case letters, digits and dashes" }),
    name: z.string().min(1),
    version: semver,
    apiVersion: semver,
    /** An ES module, relative to the manifest, whose default export is the `DatasourcePlugin`. */
    entry: z.string().min(1),
    capabilities: z.array(z.enum(CAPABILITIES)),
    /** The highlighter the console uses for this plugin's dialect (decision 008). */
    highlight: z.string().min(1),
    /** The connection form, readable without running plugin code (decision 019). */
    connection: z
      .strictObject({
        fields: z.array(connectionFieldSchema).min(1),
        /** Absent: the form offers no URL to paste and the data source no Copy as URL. */
        url: connectionUrlSchema.optional(),
        network: networkSpecSchema.optional(),
        tls: tlsSpecSchema.optional(),
      })
      .refine(networkFieldsDeclared, {
        message: "network names a field the form does not declare, or one of the wrong kind",
        path: ["network"],
      })
      .refine(tlsFieldsDeclared, {
        message:
          "tls names a field the form does not declare or one of the wrong kind: mode a select offering every verify mode, files of kind file, the passphrase a secret password",
        path: ["tls"],
      })
      .refine(visibilityFieldsDeclared, {
        message:
          "visibleWhen names a field the form does not declare, the field itself, or one that is not a select or checkbox, or compares it with a value of the wrong type",
        path: ["fields"],
      })
      .refine(urlSetsDeclared, {
        message: "url.sets names a scheme the url does not list, or a field the form does not declare",
        path: ["url"],
      }),
  })
  // A console speaks one language: SQL statements or a store's commands (decision 112).
  .refine((manifest) => !(manifest.capabilities.includes("commands") && manifest.capabilities.includes("sql")), {
    message: "the commands and sql capabilities exclude each other",
    path: ["capabilities"],
  })
  // The key tree's edits and actions are previewed and confirmed as commands (decision 113).
  .refine((manifest) => !manifest.capabilities.includes("keyValue") || manifest.capabilities.includes("commands"), {
    message: "the keyValue capability requires commands",
    path: ["capabilities"],
  })
  .refine(
    (manifest) =>
      !includesAny(manifest.capabilities, "nodes", "serverInfo") ||
      includesAny(manifest.capabilities, "sql", "commands"),
    { message: "the nodes and serverInfo capabilities require sql or commands", path: ["capabilities"] },
  )
  // A definition is read through the introspector, which only `schemaTree` promises (decision 029).
  .refine((manifest) => !manifest.capabilities.includes("ddl") || manifest.capabilities.includes("schemaTree"), {
    message: "the ddl capability requires schemaTree",
    path: ["capabilities"],
  })
  // A plan is of a statement, and Analyse is Explain that also runs it (decision 031).
  .refine((manifest) => !manifest.capabilities.includes("explain") || manifest.capabilities.includes("sql"), {
    message: "the explain capability requires sql",
    path: ["capabilities"],
  })
  .refine(
    (manifest) => !manifest.capabilities.includes("explainAnalyze") || manifest.capabilities.includes("explain"),
    { message: "the explainAnalyze capability requires explain", path: ["capabilities"] },
  )
  // A namespace is switched by a statement, and the switch is told apart by the language (decision 048).
  .refine((manifest) => !manifest.capabilities.includes("currentNamespace") || manifest.capabilities.includes("sql"), {
    message: "the currentNamespace capability requires sql",
    path: ["capabilities"],
  })
  // An import commits at boundaries it chooses and rolls back the rest (decision 046).
  .refine(
    (manifest) => !manifest.capabilities.includes("bulkInsert") || manifest.capabilities.includes("transactions"),
    { message: "the bulkInsert capability requires transactions", path: ["capabilities"] },
  )
  // Object DDL is planned against described tables and reads its names from the introspector (decision 052).
  .refine(
    (manifest) =>
      !manifest.capabilities.includes("objects") ||
      (manifest.capabilities.includes("sql") && manifest.capabilities.includes("schemaTree")),
    { message: "the objects capability requires sql and schemaTree", path: ["capabilities"] },
  )
  // A listed session's query opens in a console, and the engine lists sessions on its catalog or
  // key-tree session (decision 088, plan 058).
  .refine(
    (manifest) =>
      !manifest.capabilities.includes("sessions") ||
      (includesAny(manifest.capabilities, "sql", "commands") &&
        includesAny(manifest.capabilities, "schemaTree", "keyValue")),
    {
      message: "the sessions capability requires sql or commands, and schemaTree or keyValue",
      path: ["capabilities"],
    },
  )
  // A call runs in a console and is built from the routine the introspector describes (decision 090).
  .refine(
    (manifest) =>
      !manifest.capabilities.includes("routineCall") ||
      (manifest.capabilities.includes("sql") && manifest.capabilities.includes("schemaTree")),
    { message: "the routineCall capability requires sql and schemaTree", path: ["capabilities"] },
  );

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
