import {
  PluginError,
  type ConnectOptions,
  type ExecuteOptions,
  type ExecuteResult,
  type ParameterValue,
  type ServerNode,
  type Session,
} from "@table-craft/plugin-api";
import { ErrorReply } from "redis";
import type { RedisConfig } from "./config.js";
import { openConnection, type Connection } from "./connect.js";
import { docsFromReply, docsKnownTo, SNAPSHOT_DOCS, type CommandDocs } from "./docs.js";
import { featuresOf, type RedisFeatures } from "./features.js";
import { RedisKeyspace } from "./keyspace.js";
import { wordsOf } from "./language.js";
import { commandTableOf, readOnlyRefusal, type CommandTable } from "./readOnly.js";
import { fannedOutResult, resultOf, utf8OrNull } from "./replies.js";
import { Router, type Routed } from "./routing.js";
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

export class RedisSession implements Session {
  readonly serverVersion: string;
  readonly tls = null;
  readonly delimiter: string;
  readonly keyspace: RedisKeyspace;
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
      onDatabase: (database, work) => this.#onDatabase(database, work),
      hashFieldTtl: () => this.features().then((features) => features.hashFieldTtl),
    });
  }

  static async open(config: RedisConfig, options: ConnectOptions): Promise<RedisSession> {
    return new RedisSession(await openConnection(config, options), config, options);
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
   * `COMMAND DOCS` over the 7.4 snapshot, or on 6.2 the snapshot narrowed to the server's commands
   * (decision 8 of plan 058).
   */
  commandDocs(): Promise<CommandDocs> {
    this.#docs ??= this.features().then(async (features) =>
      features.commandDocs
        ? docsFromReply(await this.#send(["COMMAND", "DOCS"]))
        : docsKnownTo(SNAPSHOT_DOCS, new Set((await this.commandTable()).keys())),
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
      const routed = await this.#run(
        tokens.map((token) => token.bytes),
        words,
        options?.node,
      );
      if (words[0] === "SELECT" && !routed.fanned) this.#database = Number(words[1]);
      const wire = { fullBytes: options?.fullBytes === true };
      return routed.fanned ? fannedOutResult(routed.replies, wire) : resultOf(routed.reply, wire);
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

  #run(args: readonly Buffer[], words: readonly string[], node: string | undefined): Promise<Routed> {
    return this.#failures(() => this.#router.run(args, words, node));
  }

  async #failures<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof PluginError) throw cause;
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
