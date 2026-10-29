import {
  PluginError,
  type CancelReach,
  type ConnectOptions,
  type ExecuteOptions,
  type ExecuteResult,
  type KeySource,
  type ParameterValue,
  type ServerInfo,
  type ServerNode,
  type Session,
  type SlowCommand,
} from "@table-craft/plugin-api";
import { ErrorReply } from "redis";
import { CANCELLED_MESSAGE, UNBLOCKED, unblock } from "./cancel.js";
import type { RedisConfig } from "./config.js";
import { openConnection, type Connection } from "./connect.js";
import { docsFromReply, docsKnownTo, SNAPSHOT_DOCS, type CommandDocs } from "./docs.js";
import { featuresOf, keepsTtl, type RedisFeatures } from "./features.js";
import { keyBytesOf } from "./keyBytes.js";
import { keyTypeOf, RedisKeyspace } from "./keyspace.js";
import { wordsOf } from "./language.js";
import { commandTableOf, readOnlyRefusal, type CommandTable } from "./readOnly.js";
import { fannedOutResult, resultOf, utf8OrNull, wholeKeyResult } from "./replies.js";
import { Router, type Routed } from "./routing.js";
import { serverInfo, slowLog, type ServerHost } from "./server.js";
import { RedisSessionMonitor, sessionId } from "./sessions.js";
import { keyRead, QUEUED, readsWholeKey } from "./source.js";
import { tokenize } from "./tokens.js";

const CLOSE_GRACE_MS = 3000;
const BUSY_MESSAGE = "Another command is still running in this session.";
const CLOSED_MESSAGE = "The connection to Redis is closed.";
const CROSSSLOT_HINT = "keys must share a hash slot: wrap the common part in `{…}`, e.g. `user:{42}:profile`";
const KEY_COMPLETION_SCAN = "200";
const KEY_COMPLETION_LIMIT = 50;

/** Commands that open a feed the console cannot show yet (decision 7 of plan 058). */
const LIVE_FEEDS = new Set(["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR"]);
/** Commands that would change the connection under the session: protocol, identity, or its end. */
const CONNECTION_COMMANDS = new Set(["HELLO", "RESET", "QUIT"]);

/** A key completion offers, with its type for the popup's detail. */
export interface KeySuggestion {
  readonly name: string;
  readonly type: string;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const CANCEL_REACH: CancelReach = { method: "CLIENT UNBLOCK", reaches: "blockingCommands" };

export class RedisSession implements Session {
  readonly serverVersion: string;
  /** The manifest's one brand. */
  readonly serverBrand = "redis";
  readonly cancelReach: CancelReach = CANCEL_REACH;
  readonly tls = null;
  readonly delimiter: string;
  readonly keyspace: RedisKeyspace;
  readonly sessions: RedisSessionMonitor;
  /** The console's own connection as the sessions view lists it: in a cluster, the first primary's. */
  serverSessionId = "";
  readonly #server: ServerHost;
  readonly #connection: Connection;
  readonly #router: Router;
  readonly #readOnly: boolean;
  #database: number;
  #running = false;
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();
  #table: Promise<CommandTable> | undefined;
  #docs: Promise<CommandDocs> | undefined;
  #features: Promise<RedisFeatures> | undefined;

  private constructor(connection: Connection, config: RedisConfig, options: ConnectOptions) {
    this.#connection = connection;
    this.#readOnly = options.readOnly;
    this.#database = config.mode === "cluster" ? 0 : config.database;
    this.serverVersion = connection.version;
    this.delimiter = config.keyDelimiter;
    this.#router = new Router(connection, () => this.commandTable());
    this.keyspace = new RedisKeyspace({
      mode: connection.mode,
      delimiter: config.keyDelimiter,
      scanBatch: config.scanBatch,
      configuredDatabase: this.#database,
      router: this.#router,
      readOnly: options.readOnly,
      keepTtl: keepsTtl(connection.version),
      onDatabase: (database, work) => this.#onDatabase(database, work),
      features: () => this.features(),
    });
    const queued = <T>(work: () => Promise<T>): Promise<T> => this.#onDatabase(this.#database, work);
    const primaries = () => this.#router.primaries();
    this.sessions = new RedisSessionMonitor({ mode: connection.mode, primaries, queued });
    this.#server = {
      mode: connection.mode,
      primaries,
      queued,
      multiSectionInfo: () => this.features().then((features) => features.multiSectionInfo),
      clientOf: async (node) => {
        if (node !== null) return { node, client: await this.#router.clientOf(node) };
        const [first] = await primaries();
        if (first === undefined) throw new PluginError("connectionLost", "The cluster has no reachable primary.");
        return { node: connection.mode === "cluster" ? first.node : null, client: first.client };
      },
    };
  }

  static async open(config: RedisConfig, options: ConnectOptions): Promise<RedisSession> {
    const session = new RedisSession(await openConnection(config, options), config, options);
    try {
      const [first] = await session.#router.primaries();
      if (first === undefined) throw new PluginError("connectionFailed", "The cluster has no reachable primary.");
      const clientId = String(await first.client.sendCommand(["CLIENT", "ID"]));
      session.serverSessionId = sessionId(clientId, session.mode === "cluster" ? first.node : null);
    } catch (cause) {
      await session.close();
      throw cause instanceof PluginError ? cause : new PluginError("connectionFailed", errorText(cause), { cause });
    }
    return session;
  }

  get mode(): Connection["mode"] {
    return this.#connection.mode;
  }

  /** The database the session's commands run against; always 0 in a cluster. */
  get database(): number {
    return this.#database;
  }

  /** The server's command table, read once (decision 10 of plan 058). */
  commandTable(): Promise<CommandTable> {
    this.#table ??= this.#send(["COMMAND"]).then(commandTableOf);
    this.#table.catch(() => (this.#table = undefined));
    return this.#table;
  }

  /**
   * `COMMAND DOCS` over the 7.4 snapshot, or before 7.0 the snapshot narrowed to what the server
   * knows (decision 116).
   */
  commandDocs(): Promise<CommandDocs> {
    this.#docs ??= this.features().then(async (features) =>
      features.commandDocs
        ? docsFromReply(await this.#send(["COMMAND", "DOCS"]))
        : docsKnownTo(SNAPSHOT_DOCS, new Set((await this.commandTable()).keys()), features.version),
    );
    this.#docs.catch(() => (this.#docs = undefined));
    return this.#docs;
  }

  features(): Promise<RedisFeatures> {
    this.#features ??= this.commandTable().then((table) => featuresOf(this.serverVersion, new Set(table.keys())));
    this.#features.catch(() => (this.#features = undefined));
    return this.#features;
  }

  async execute(sql: string, _params?: readonly ParameterValue[], options?: ExecuteOptions): Promise<ExecuteResult> {
    this.#checkOpen();
    if (this.#running) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    this.#running = true;
    try {
      const tokens = tokenize(sql.trim());
      if (tokens.length === 0) throw new PluginError("statementFailed", "Nothing to run: the line holds no command.");
      if (tokens.some((token) => !token.closed)) {
        throw new PluginError("statementFailed", "Invalid argument(s): a quote is not closed.");
      }
      const words = wordsOf(tokens);
      this.#refuse(words);
      if (this.#readOnly) {
        const refusal = readOnlyRefusal(await this.commandTable(), words);
        if (refusal !== null) throw new PluginError("statementFailed", refusal);
      }
      const args = tokens.map((token) => token.bytes);
      const routed = await this.#run(args, words, options?.node);
      if (words[0] === "SELECT" && !routed.fanned) this.#database = Number(words[1]);
      if (routed.fanned) return fannedOutResult(routed.replies, { fullBytes: options?.fullBytes === true });
      const key = routed.reply === QUEUED ? null : keyRead(await this.commandTable(), words, args);
      const source = key === null ? null : await this.#sourceOf(key, words);
      // One key's values are read as the key tab reads them, every byte, so they decode and edit alike.
      const wire = { fullBytes: options?.fullBytes === true || key !== null };
      const whole = source?.whole === true ? wholeKeyResult(routed.reply, source.type, wire) : null;
      const result = whole ?? resultOf(routed.reply, wire, key !== null);
      return source === null ? result : { ...result, source };
    } finally {
      this.#running = false;
    }
  }

  async ping(): Promise<void> {
    this.#checkOpen();
    try {
      await this.#send(["PING"]);
    } catch (cause) {
      throw new PluginError("connectionLost", errorText(cause), { cause });
    }
  }

  /** Unblocks the console's blocking command; one that does not block finishes (decision 22 of plan 058). */
  async cancel(): Promise<void> {
    const running = this.#router.running();
    if (running.length === 0 || this.#closed) return;
    try {
      await unblock(this.#connection.open, running);
    } catch (cause) {
      throw new PluginError("statementFailed", `Cancel failed: ${errorText(cause)}`, { cause });
    }
  }

  serverInfo(node: string | null): Promise<ServerInfo> {
    return serverInfo(this.#server, node);
  }

  slowLog(node: string | null, limit: number): Promise<readonly SlowCommand[]> {
    return slowLog(this.#server, node, limit);
  }

  async nodes(): Promise<readonly ServerNode[]> {
    this.#checkOpen();
    return this.#failures(() => this.#router.nodes());
  }

  /** Keys starting with `prefix`, at most 50, for completing a key argument (decision 8 of plan 058). */
  suggestKeys(prefix: string): Promise<KeySuggestion[]> {
    return this.#onDatabase(this.#database, () => this.#suggestKeys(prefix));
  }

  async #suggestKeys(prefix: string): Promise<KeySuggestion[]> {
    const pattern = `${prefix.replace(/[*?[\]\\]/g, (char) => `\\${char}`)}*`;
    const routed = await this.#router.run(
      ["SCAN", "0", "MATCH", pattern, "COUNT", KEY_COMPLETION_SCAN].map((word) => Buffer.from(word)),
      ["SCAN"],
      undefined,
    );
    const replies = routed.fanned ? routed.replies.map((entry) => entry.reply) : [routed.reply];
    const names = new Set<string>();
    for (const reply of replies) {
      const keys = Array.isArray(reply) ? (reply[1] as unknown) : [];
      for (const key of Array.isArray(keys) ? keys : []) {
        const name = key instanceof Uint8Array ? utf8OrNull(key) : null;
        if (name !== null && names.size < KEY_COMPLETION_LIMIT) names.add(name);
      }
    }
    return Promise.all(
      [...names].map(async (name) => {
        const type = await this.#router.run([Buffer.from("TYPE"), Buffer.from(name)], ["TYPE"], undefined);
        return { name, type: type.fanned ? "" : String(type.reply) };
      }),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#router.close();
    const connection = this.#connection;
    const target = connection.mode === "cluster" ? connection.cluster : connection.client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CLOSE_GRACE_MS)));
    try {
      const closed = await Promise.race([target.close().then(() => "closed" as const), grace]);
      if (closed === "late") target.destroy();
    } catch {
      target.destroy();
    } finally {
      clearTimeout(timer);
    }
  }

  #checkOpen(): void {
    const connection = this.#connection;
    const ready = connection.mode === "cluster" ? connection.cluster.isOpen : connection.client.isReady;
    if (this.#closed || !ready) throw new PluginError("connectionLost", CLOSED_MESSAGE);
  }

  #refuse(words: readonly string[]): void {
    const name = words[0] ?? "";
    if (LIVE_FEEDS.has(name)) throw new PluginError("statementFailed", `${name} opens a live feed; not supported yet.`);
    if (CONNECTION_COMMANDS.has(name)) {
      throw new PluginError("statementFailed", `${name} would change the console's connection; reconnect instead.`);
    }
    if (name === "SELECT" && this.#connection.mode === "cluster") {
      throw new PluginError("statementFailed", "SELECT is not allowed in a cluster: it has database 0 only.");
    }
  }

  /**
   * Keyspace work, one call at a time: on another database than the session's, the connection
   * selects it for the call and selects the session's own back after, so a console keeps its
   * `SELECT`.
   */
  #onDatabase<T>(database: number, work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      this.#checkOpen();
      return this.#failures(async () => {
        const connection = this.#connection;
        const home = this.#database;
        if (connection.mode === "cluster" || database === home) return work();
        await connection.client.sendCommand(["SELECT", String(database)]);
        try {
          return await work();
        } finally {
          await connection.client.sendCommand(["SELECT", String(home)]);
        }
      });
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The key the command read, typed by `TYPE` (decision 119); null when it is gone or `TYPE` is refused. */
  async #sourceOf(key: Buffer, words: readonly string[]): Promise<KeySource | null> {
    try {
      const type = keyTypeOf(String(await this.#router.onKey(key, ["TYPE", key])));
      if (type === null) return null;
      return { database: this.#database, key: keyBytesOf(key), type, whole: readsWholeKey(words, type) };
    } catch {
      return null;
    }
  }

  #run(args: readonly Buffer[], words: readonly string[], node: string | undefined): Promise<Routed> {
    return this.#failures(() => this.#router.run(args, words, node));
  }

  async #failures<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof PluginError) throw cause;
      if (cause instanceof ErrorReply && UNBLOCKED.test(cause.message)) {
        throw new PluginError("cancelled", CANCELLED_MESSAGE, { cause });
      }
      if (cause instanceof ErrorReply) {
        const message = cause.message.startsWith("CROSSSLOT") ? `${cause.message}; ${CROSSSLOT_HINT}` : cause.message;
        throw new PluginError("statementFailed", message, { cause });
      }
      throw new PluginError("connectionLost", errorText(cause), { cause });
    }
  }

  /** One command on the server, or a random primary of a cluster. */
  #send(args: readonly string[]): Promise<unknown> {
    return this.#router.anyPrimary(args);
  }
}
