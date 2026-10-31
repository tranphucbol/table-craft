import {
  CatalogCache,
  ResultStore,
  completionCatalog,
  loadedPlugin,
  tableCount,
  type Connector,
} from "@table-craft/core";
import {
  isPluginError,
  switchableTo,
  type CommandLanguage,
  type CompletionCatalog,
  type CompletionRequest,
  type CompletionResult,
  type Declaration,
  type InspectionRequest,
  type Namespace,
  type Problem,
  type NamespaceSwitch,
  type Relation,
  type ResolveRequest,
  type SignatureHelp,
  type Routine,
  type RoutineArgument,
  type RoutineCall,
  type Row,
  type Session,
  type SessionListing,
  type SessionMonitor,
  type SessionTarget,
  type SqlLanguage,
  type WireValue,
} from "@table-craft/plugin-api";
import { connectDatasource } from "@table-craft/desktop/engine/connect.js";
import type { EngineOptions } from "@table-craft/desktop/engine/engine.js";
import {
  BUG_HINT,
  EngineFailure,
  FORMAT_HINT,
  READ_ONLY_SESSIONS,
  READ_ONLY_SESSIONS_HINT,
  ROUTINE_ARGUMENTS_HINT,
  SESSION_STOP_HINT,
  SYNCHRONIZE_HINT,
  introspectionFailed,
  messageOf,
  statementFailed,
} from "@table-craft/desktop/engine/failures.js";
import { objectContext } from "@table-craft/desktop/engine/objectChanges.js";
import type {
  ClassifiedStatement,
  EngineError,
  FormatOptions,
  GeneratorStatement,
  ReferencingKey,
  SwitchStatement,
} from "@table-craft/desktop/engine/protocol.js";
import { connectionTarget, type LoggedRequest, type RequestContext } from "@table-craft/desktop/engine/requestLog.js";
import { learnInstance, repeatedIds } from "@table-craft/desktop/engine/serverInstances.js";
import { transferContext } from "@table-craft/desktop/engine/transfers.js";
import type { LogFields, Logger } from "@table-craft/desktop/log/record.js";

const SESSION_PREFIX = "session-";

interface Introspection {
  readonly session: Session;
  readonly cache: CatalogCache;
}

const EMPTY_COMPLETION_CATALOG: CompletionCatalog = {
  current: null,
  server: { version: null },
  namespaces: () => Promise.resolve([]),
  relations: () => Promise.resolve([]),
  referencing: () => Promise.resolve([]),
};

/** COUNT(*) comes back as a number, a decimal string or a bigint, by driver. */
function countOf(value: WireValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "object" && value !== null && value.kind === "bigint") return Number(value.value);
  throw new EngineFailure({ code: "internal", message: "COUNT(*) returned no number.", hint: BUG_HINT });
}

function baseContext(options: EngineOptions, connector: Connector, now: () => number) {
  const log = options.log ?? null;
  const sessionLog = log?.child("session") ?? null;
  let target: LogFields | null = null;

  /** Classified for the record only; a plugin that cannot classify leaves the kind unknown. */
  function statementKind(request: LoggedRequest): string | null {
    if (typeof request.sql !== "string") return null;
    try {
      return consoleLanguage().classify(request.sql).kind;
    } catch {
      return null;
    }
  }

  function logContext(request: LoggedRequest, started: number): RequestContext {
    const manifest = options.plugins.find((entry) => entry.manifest?.id === options.datasource.pluginId)?.manifest;
    target ??= connectionTarget(manifest?.connection.fields ?? [], options.datasource.config);
    return {
      log: log as Logger,
      elapsedMs: now() - started,
      statementKind: statementKind(request),
      target: { pluginId: options.datasource.pluginId, datasourceId: options.datasource.id, ...target },
    };
  }

  function sqlLanguage(): SqlLanguage {
    const { language } = loadedPlugin(options.plugins, options.datasource.pluginId).plugin;
    if (language === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the sql capability.",
        hint: BUG_HINT,
      });
    }
    return language;
  }

  function datasourcePlugin() {
    return loadedPlugin(options.plugins, options.datasource.pluginId).plugin;
  }

  /** The command language of a `commands` datasource (decision 112); null for a SQL one. */
  function commandLanguage(): CommandLanguage | null {
    return datasourcePlugin().commandLanguage ?? null;
  }

  /** What splits and classifies the console's text: the SQL language or the command language. */
  function consoleLanguage(): Pick<SqlLanguage, "split" | "classify"> {
    return commandLanguage() ?? sqlLanguage();
  }

  function splitScript(text: string): ClassifiedStatement[] {
    const commands = commandLanguage();
    if (commands !== null) {
      return commands.split(text).map((span) => {
        const { kind, destructive, costly, confirmByName } = commands.classify(span.sql);
        return {
          ...span,
          kind,
          destructive,
          parameters: [],
          ...(costly === undefined ? {} : { costly }),
          ...(confirmByName === undefined ? {} : { confirmByName }),
        };
      });
    }
    const language = sqlLanguage();
    return language.split(text).map((span) => {
      const { kind, destructive } = language.classify(span.sql);
      return { ...span, kind, destructive, parameters: language.parameters(span.sql) };
    });
  }

  /**
   * One session a `commands` datasource answers completion, the key tree and the session monitor
   * on, opened on first use like the catalog's (decision 022). A failed open is forgotten.
   */
  let helper: Promise<Session> | null = null;

  function helperSession(): Promise<Session> {
    if (helper === null) {
      const opening = connectDatasource(options, connector);
      helper = opening;
      opening.catch(() => {
        if (helper === opening) helper = null;
      });
    }
    return helper;
  }

  /** A lost helper session is dropped and the read runs once more on a fresh one. */
  async function onHelper<T>(read: (session: Session) => Promise<T>): Promise<T> {
    const opening = helperSession();
    const session = await opening;
    try {
      return await read(session);
    } catch (cause) {
      if (!isPluginError(cause) || cause.code !== "connectionLost") throw cause;
      if (helper === opening) {
        helper = null;
        void session.close().catch(() => undefined);
      }
      return read(await helperSession());
    }
  }

  function formatText(text: string, format: FormatOptions): string {
    try {
      return sqlLanguage().format(text, format);
    } catch (cause) {
      if (cause instanceof EngineFailure) throw cause;
      throw new EngineFailure({ code: "formatFailed", message: messageOf(cause), hint: FORMAT_HINT });
    }
  }

  const results = new ResultStore();
  let nextSession = 1;
  /** One session for every connection's catalog calls, opened on first use (decision 022). */
  let introspection: Promise<Introspection> | null = null;

  async function openIntrospection(): Promise<Introspection> {
    const session = await connectDatasource(options, connector);
    if (session.introspector === undefined) {
      await session.close().catch(() => undefined);
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the schemaTree capability.",
        hint: BUG_HINT,
      });
    }
    return { session, cache: new CatalogCache(session.introspector) };
  }

  /** A failed open is forgotten, so the next catalog call connects again. */
  function catalog(): Promise<Introspection> {
    if (introspection === null) {
      const opening = openIntrospection();
      introspection = opening;
      opening.catch(() => {
        if (introspection === opening) introspection = null;
      });
    }
    return introspection;
  }

  /**
   * A failed read is tried once more on a fresh session. The contract cannot tell a dropped link from
   * a refused read, and without this one dropped link (an import's network failure, a server
   * restart) would fail every catalog call until the datasource is reconnected.
   */
  async function introspect<T>(read: (open: Introspection) => Promise<T> | T): Promise<T> {
    const opening = catalog();
    const open = await opening;
    try {
      return await read(open);
    } catch (cause) {
      if (!isPluginError(cause)) throw cause;
      if (introspection === opening) {
        introspection = null;
        void open.session.close().catch(() => undefined);
      }
      try {
        return await read(await catalog());
      } catch (again) {
        throw introspectionFailed(again);
      }
    }
  }

  /** `name` in `path` from the catalog cache, described afresh once when the cache lacks it. */
  function relationOf(path: readonly string[], name: string): Promise<{ relation: Relation; qualified: string }> {
    return introspect(async ({ cache, session }) => {
      const find = (described: { readonly catalog: { readonly relations: readonly Relation[] } }) =>
        described.catalog.relations.find((relation) => relation.name === name);
      const relation = find(await cache.describe(path)) ?? find(await cache.describe(path, true));
      if (relation === undefined) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: `There is no table ${name} in ${path.join(".")}.`,
          hint: SYNCHRONIZE_HINT,
        });
      }
      return { relation, qualified: session.introspector?.qualifiedName(path, name) ?? name };
    });
  }

  /** Read afresh on every call, never from the cache (decision 029). */
  function definitionOf(path: readonly string[], name: string): Promise<string> {
    const { plugin } = loadedPlugin(options.plugins, options.datasource.pluginId);
    if (!plugin.capabilities.includes("ddl")) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the ddl capability.",
        hint: BUG_HINT,
      });
    }
    return introspect(async ({ session }) => {
      const introspector = session.introspector;
      if (introspector?.definition === undefined) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: "This datasource's plugin declares ddl but its introspector has no definition.",
          hint: BUG_HINT,
        });
      }
      return introspector.definition(path, name);
    });
  }

  async function generate(path: readonly string[], name: string, statement: GeneratorStatement): Promise<string> {
    if (statement === "create") return definitionOf(path, name);
    const language = sqlLanguage();
    const { relation, qualified } = await relationOf(path, name);
    return language.generate(statement, relation, qualified);
  }

  /** Written by the plugin from the cached routine, described afresh once when the cache lacks it (decision 090). */
  async function routineCall(
    path: readonly string[],
    target: Pick<Routine, "name" | "kind" | "signature">,
    args: readonly RoutineArgument[],
  ): Promise<RoutineCall> {
    const language = sqlLanguage();
    const call = language.routineCall?.bind(language);
    if (call === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the routineCall capability.",
        hint: BUG_HINT,
      });
    }
    const { routine, qualified } = await introspect(async ({ cache, session }) => {
      const find = (described: { readonly catalog: { readonly routines: readonly Routine[] } }) =>
        described.catalog.routines.find(
          (routine) =>
            routine.name === target.name && routine.kind === target.kind && routine.signature === target.signature,
        );
      const routine = find(await cache.describe(path)) ?? find(await cache.describe(path, true));
      if (routine === undefined) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: `There is no ${target.kind} ${target.name}(${target.signature}) in ${path.join(".")}.`,
          hint: SYNCHRONIZE_HINT,
        });
      }
      return { routine, qualified: session.introspector?.qualifiedName(path, routine.name) ?? routine.name };
    });
    // Outside `introspect`, which takes a plugin error for a broken session and reopens it.
    try {
      return call(routine, qualified, args);
    } catch (cause) {
      if (!isPluginError(cause)) throw cause;
      throw new EngineFailure({ code: "statementFailed", message: cause.message, hint: ROUTINE_ARGUMENTS_HINT }, cause);
    }
  }

  /** Foreign keys in every described namespace that target `path`.`name`. */
  function referencingKeys(path: readonly string[], name: string): Promise<ReferencingKey[]> {
    const target = JSON.stringify(path);
    return introspect(({ cache }) =>
      cache
        .described()
        .flatMap(({ catalog: described }) =>
          described.relations.flatMap((relation) =>
            relation.foreignKeys
              .filter((key) => key.target.relation === name && JSON.stringify(key.target.path) === target)
              .map((foreignKey) => ({ path: described.path, relation: relation.name, foreignKey })),
          ),
        ),
    );
  }

  /**
   * Completion and navigation read the catalog cache through the introspection session, never a
   * console's (decision 028). When that session cannot open they answer from no catalog at all.
   */
  async function completionCatalogOf(current: readonly string[] | undefined): Promise<CompletionCatalog> {
    const open = await catalog().catch(() => null);
    if (open === null)
      return current === undefined ? EMPTY_COMPLETION_CATALOG : { ...EMPTY_COMPLETION_CATALOG, current };
    const serverVersion = open.session.serverVersion;
    return completionCatalog(open.cache, current === undefined ? { serverVersion } : { current, serverVersion });
  }

  function checkedOffset(text: string, offset: number): void {
    if (offset > text.length) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: `The caret offset ${offset} is past the end of the ${text.length}-character text.`,
        hint: BUG_HINT,
      });
    }
  }

  async function complete(request: CompletionRequest, current?: readonly string[]): Promise<CompletionResult> {
    checkedOffset(request.text, request.offset);
    const commands = commandLanguage();
    if (commands !== null) return commands.complete(request, await helperSession().catch(() => null));
    const language = sqlLanguage();
    return language.complete(request, await completionCatalogOf(current));
  }

  async function resolve(request: ResolveRequest, current?: readonly string[]): Promise<Declaration | null> {
    checkedOffset(request.text, request.offset);
    if (commandLanguage() !== null) return null;
    const language = sqlLanguage();
    return language.resolve(request, await completionCatalogOf(current));
  }

  /**
   * Live problems in `text` (plan 108). A plugin without `inspect`, or one that throws, finds
   * nothing: inspection decorates the editor and must never fail it.
   */
  async function inspect(
    text: string,
    current?: readonly string[],
    disabled?: readonly string[],
  ): Promise<readonly Problem[]> {
    const { language, commandLanguage: commands } = datasourcePlugin();
    const request: InspectionRequest = disabled === undefined ? { text } : { text, disabled };
    try {
      if (commands !== undefined) return (await commands.inspect?.(request)) ?? [];
      if (language?.inspect === undefined) return [];
      return await language.inspect(request, await completionCatalogOf(current));
    } catch (cause) {
      log?.warn("inspection failed", { message: messageOf(cause) });
      return [];
    }
  }

  async function signatureAt(request: CompletionRequest): Promise<SignatureHelp | null> {
    checkedOffset(request.text, request.offset);
    const commands = commandLanguage();
    if (commands !== null) {
      return (await commands.signatureAt?.(request, await helperSession().catch(() => null))) ?? null;
    }
    const language = sqlLanguage();
    if (language.signatureAt === undefined) return null;
    return language.signatureAt(request, await completionCatalogOf(undefined));
  }

  /** Count Rows on a session of its own: the editor's session would close its open cursor. */
  async function countRows(path: readonly string[], name: string, where: string): Promise<number> {
    const { qualified } = await relationOf(path, name);
    const session = await connectDatasource(options, connector);
    try {
      const result = await session.execute(tableCount(qualified, where));
      let first: Row | undefined;
      for await (const row of result.rows) first ??= row;
      return countOf(first?.[0]);
    } catch (cause) {
      throw cause instanceof EngineFailure ? cause : statementFailed(cause, options.datasource.readOnly);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  function namespaceSwitch(): NamespaceSwitch {
    const { plugin } = loadedPlugin(options.plugins, options.datasource.pluginId);
    const switcher = plugin.language?.namespaceSwitch;
    if (!plugin.capabilities.includes("currentNamespace") || switcher === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the currentNamespace capability.",
        hint: BUG_HINT,
      });
    }
    return switcher;
  }

  async function switchTargets(refresh: boolean | undefined): Promise<Namespace[]> {
    const { targets } = namespaceSwitch();
    const namespaces = await introspect(({ cache }) => cache.namespaces(refresh));
    return namespaces.filter((namespace) => switchableTo(targets, namespace));
  }

  function namespaceSwitchable(): boolean {
    const { plugin } = loadedPlugin(options.plugins, options.datasource.pluginId);
    return plugin.capabilities.includes("currentNamespace") && plugin.language?.namespaceSwitch !== undefined;
  }

  function switchStatement(path: readonly string[]): SwitchStatement {
    const switcher = namespaceSwitch();
    return { sql: switcher.statement(path), transactional: switcher.transactional };
  }

  async function qualifiedOf(path: readonly string[], name: string): Promise<string> {
    return introspect(({ session }) => session.introspector?.qualifiedName(path, name) ?? name);
  }

  const NO_SESSIONS: EngineError = {
    code: "invalidRequest",
    message: "This datasource's plugin does not declare the sessions capability.",
    hint: BUG_HINT,
  };

  /** Checked before the catalog connects, so a plugin without the capability opens nothing. */
  function requireSessions(): void {
    const { capabilities } = loadedPlugin(options.plugins, options.datasource.pluginId).plugin;
    if (!capabilities.includes("sessions")) throw new EngineFailure(NO_SESSIONS);
  }

  function monitorOf(session: Session): SessionMonitor {
    if (session.sessions === undefined) throw new EngineFailure(NO_SESSIONS);
    return session.sessions;
  }

  /**
   * The listing, and the catalog's own connection, which is this engine's too. The catalog learns
   * its server in the same turn, so the plugin never sees the lookup beside other work.
   */
  function listServerSessions(): Promise<{ readonly listing: SessionListing; readonly catalog: Session }> {
    requireSessions();
    const listOn = async (session: Session) => {
      const listing = await monitorOf(session).list();
      await learnInstance(session, repeatedIds(listing.sessions));
      return { listing, catalog: session };
    };
    if (commandLanguage() !== null) return onHelper(listOn);
    return introspect(({ session }) => listOn(session));
  }

  /** Runs the row's statement on the plugin's fresh connection; no retry, since a kill is not idempotent. */
  async function stopServerSession(target: SessionTarget, stop: "cancel" | "terminate"): Promise<null> {
    requireSessions();
    if (options.datasource.readOnly) {
      throw new EngineFailure({ code: "invalidRequest", message: READ_ONLY_SESSIONS, hint: READ_ONLY_SESSIONS_HINT });
    }
    const session = commandLanguage() !== null ? await helperSession() : (await catalog()).session;
    const monitor = monitorOf(session);
    try {
      await (stop === "cancel" ? monitor.cancelSession(target) : monitor.terminateSession(target));
    } catch (cause) {
      throw new EngineFailure({ code: "statementFailed", message: messageOf(cause), hint: SESSION_STOP_HINT }, cause);
    }
    return null;
  }

  function nextSessionId(): string {
    return `${SESSION_PREFIX}${String(nextSession++)}`;
  }

  async function closeIntrospection(): Promise<void> {
    const open = introspection;
    introspection = null;
    if (open !== null) await open.then((entry) => entry.session.close()).catch(() => undefined);
    const opened = helper;
    helper = null;
    if (opened !== null) await opened.then((session) => session.close()).catch(() => undefined);
  }

  return {
    options,
    now,
    connector,
    log,
    sessionLog,
    statementKind,
    logContext,
    sqlLanguage,
    datasourcePlugin,
    commandLanguage,
    consoleLanguage,
    helperSession,
    onHelper,
    splitScript,
    formatText,
    results,
    openIntrospection,
    catalog,
    introspect,
    relationOf,
    definitionOf,
    generate,
    routineCall,
    referencingKeys,
    completionCatalogOf,
    checkedOffset,
    complete,
    resolve,
    inspect,
    signatureAt,
    countRows,
    namespaceSwitch,
    switchTargets,
    namespaceSwitchable,
    switchStatement,
    qualifiedOf,
    NO_SESSIONS,
    requireSessions,
    monitorOf,
    listServerSessions,
    stopServerSession,
    nextSessionId,
    closeIntrospection,
  };
}

export type BaseContext = ReturnType<typeof baseContext>;

/** What every connection shares: the stores, the catalog, the transfer tasks and the object editor. */
export function createEngineContext(options: EngineOptions, connector: Connector, now: () => number) {
  const base = baseContext(options, connector, now);
  const transfers = transferContext(base);
  return { ...base, ...transfers, ...objectContext(base, transfers) };
}

export type EngineContext = ReturnType<typeof createEngineContext>;
