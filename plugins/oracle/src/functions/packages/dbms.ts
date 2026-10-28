import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";

/**
 * Members of the most used DBMS_ supplied packages, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/ (one page per package, such as
 * DBMS_OUTPUT.html) and https://docs.oracle.com/en/database/oracle/oracle-database/23/arpls/.
 * A procedure's signature returns nothing (`"line ->"`).
 */
export const DBMS_FUNCTIONS: readonly FunctionSpec[] = [
  ...functionSpecs("server", [
    ["DBMS_OUTPUT.DISABLE", "->", "Stops collecting output and drops what the buffer holds."],
    ["DBMS_OUTPUT.ENABLE", "buffer_size? ->", "Starts collecting output; null leaves the buffer unlimited."],
    ["DBMS_OUTPUT.GET_LINE", "line, status ->", "Reads one buffered line into line; status 1 when none is left."],
    [
      "DBMS_OUTPUT.GET_LINES",
      "lines, count ->",
      "Reads up to count buffered lines into an array and sets count to how many came.",
    ],
    ["DBMS_OUTPUT.NEW_LINE", "->", "Ends the line PUT started."],
    ["DBMS_OUTPUT.PUT", "text ->", "Adds text to the current line of the output buffer."],
    ["DBMS_OUTPUT.PUT_LINE", "line ->", "Writes a line to the output buffer, which TableCraft shows in Output."],
  ]),
  ...functionSpecs("misc", [
    ["DBMS_LOB.APPEND", "dest, src ->", "Adds one LOB's contents to the end of another."],
    ["DBMS_LOB.CLOSE", "lob ->", "Closes a LOB opened with OPEN."],
    [
      "DBMS_LOB.COMPARE",
      "a, b, amount?, offset_a?, offset_b? -> number",
      "0 when two LOBs match over a range, else a non-zero difference.",
    ],
    [
      "DBMS_LOB.CONVERTTOBLOB",
      "dest, src, amount, dest_offset, src_offset, charset, lang_context, warning ->",
      "Writes a CLOB's characters into a BLOB in a character set.",
    ],
    [
      "DBMS_LOB.CONVERTTOCLOB",
      "dest, src, amount, dest_offset, src_offset, charset, lang_context, warning ->",
      "Reads a BLOB's bytes into a CLOB from a character set.",
    ],
    ["DBMS_LOB.COPY", "dest, src, amount, dest_offset?, src_offset? ->", "Copies part of one LOB into another."],
    ["DBMS_LOB.CREATETEMPORARY", "lob, cache, duration? ->", "Makes a temporary LOB for the session or call."],
    ["DBMS_LOB.ERASE", "lob, amount, offset? ->", "Blanks out part of a LOB; amount returns how much was erased."],
    ["DBMS_LOB.FILEEXISTS", "bfile -> number", "1 when the file a BFILE points at exists."],
    ["DBMS_LOB.FREETEMPORARY", "lob ->", "Frees a temporary LOB."],
    ["DBMS_LOB.GETLENGTH", "lob -> number", "How many characters or bytes a LOB holds."],
    [
      "DBMS_LOB.INSTR",
      "lob, pattern, offset?, nth? -> number",
      "Where the nth match of a pattern starts in a LOB, from 1; 0 when absent.",
    ],
    ["DBMS_LOB.ISOPEN", "lob -> number", "1 when a LOB is open."],
    ["DBMS_LOB.ISTEMPORARY", "lob -> number", "1 when a LOB is temporary."],
    [
      "DBMS_LOB.LOADFROMFILE",
      "dest, src_bfile, amount, dest_offset?, src_offset? ->",
      "Copies part of a BFILE into a LOB.",
    ],
    ["DBMS_LOB.OPEN", "lob, mode ->", "Opens a LOB for reading or writing, LOB_READONLY or LOB_READWRITE."],
    ["DBMS_LOB.READ", "lob, amount, offset, buffer ->", "Reads part of a LOB into a buffer."],
    [
      "DBMS_LOB.SUBSTR",
      "lob, amount?, offset? -> string",
      "Part of a LOB as VARCHAR2 or RAW: amount characters or bytes from offset, 32767 from 1 by default.",
    ],
    ["DBMS_LOB.TRIM", "lob, length ->", "Cuts a LOB to a length."],
    ["DBMS_LOB.WRITE", "lob, amount, offset, buffer ->", "Writes a buffer into a LOB at an offset."],
    ["DBMS_LOB.WRITEAPPEND", "lob, amount, buffer ->", "Writes a buffer at the end of a LOB."],
  ]),
  ...functionSpecs("numeric", [
    ["DBMS_RANDOM.NORMAL", "-> number", "A random number from the standard normal distribution."],
    ["DBMS_RANDOM.SEED", "seed ->", "Seeds the generator, to repeat a sequence."],
    [
      "DBMS_RANDOM.STRING",
      "option, length -> string",
      "A random string: 'U' upper, 'L' lower, 'A' mixed letters, 'X' upper alphanumeric, 'P' printable.",
    ],
    [
      "DBMS_RANDOM.VALUE",
      ["-> number", "low, high -> number"],
      "A random number from 0 up to 1, or from low up to high.",
    ],
  ]),
  ...functionSpecs("server", [
    ["DBMS_UTILITY.COMMA_TO_TABLE", "list, count, names ->", "Splits a comma-separated list of names into an array."],
    [
      "DBMS_UTILITY.COMPILE_SCHEMA",
      "schema, compile_all?, reuse_settings? ->",
      "Recompiles the procedures, functions, packages, views and triggers of a schema.",
    ],
    ["DBMS_UTILITY.DB_VERSION", "version, compatibility ->", "Reads the database version and compatible setting."],
    ["DBMS_UTILITY.EXEC_DDL_STATEMENT", "statement ->", "Runs a DDL statement."],
    [
      "DBMS_UTILITY.EXPAND_SQL_TEXT",
      "input, output ->",
      "Writes a query with every view it reads expanded into its definition.",
    ],
    ["DBMS_UTILITY.FORMAT_CALL_STACK", "-> string", "The current call stack as text."],
    [
      "DBMS_UTILITY.FORMAT_ERROR_BACKTRACE",
      "-> string",
      "Where the current exception was raised, as a line-numbered backtrace.",
    ],
    ["DBMS_UTILITY.FORMAT_ERROR_STACK", "-> string", "The current error stack as text."],
    ["DBMS_UTILITY.GET_CPU_TIME", "-> number", "CPU time used, in hundredths of a second, to time code by difference."],
    [
      "DBMS_UTILITY.GET_HASH_VALUE",
      "name, base, size -> number",
      "A hash of a string between base and base + size - 1.",
    ],
    ["DBMS_UTILITY.GET_TIME", "-> number", "Elapsed time in hundredths of a second, to time code by difference."],
    ["DBMS_UTILITY.TABLE_TO_COMMA", "names, count, list ->", "Joins an array of names into a comma-separated list."],
  ]),
  ...functionSpecs("server", [
    [
      "DBMS_SESSION.CLEAR_CONTEXT",
      "namespace, client_id?, attribute? ->",
      "Clears an application context or one attribute.",
    ],
    ["DBMS_SESSION.CLEAR_IDENTIFIER", "->", "Clears the session's client identifier."],
    ["DBMS_SESSION.IS_ROLE_ENABLED", "role -> boolean", "Whether a role is enabled in the session."],
    ["DBMS_SESSION.RESET_PACKAGE", "->", "Drops the state of every package in the session."],
    ["DBMS_SESSION.SESSION_TRACE_DISABLE", "->", "Stops SQL tracing in the session."],
    [
      "DBMS_SESSION.SESSION_TRACE_ENABLE",
      "waits?, binds?, plan_stat? ->",
      "Starts SQL tracing in the session, with waits and binds if asked.",
    ],
    [
      "DBMS_SESSION.SET_CONTEXT",
      "namespace, attribute, value, username?, client_id? ->",
      "Sets an attribute of an application context, from the package the context names.",
    ],
    [
      "DBMS_SESSION.SET_IDENTIFIER",
      "client_id ->",
      "Sets the session's client identifier, which audit and V$SESSION show.",
    ],
    ["DBMS_SESSION.SET_NLS", "parameter, value ->", "Sets an NLS parameter, as ALTER SESSION does."],
    ["DBMS_SESSION.SET_ROLE", "roles ->", "Enables roles, as SET ROLE does."],
    ["DBMS_SESSION.SLEEP", "seconds ->", "Pauses the session, to the hundredth of a second."],
    ["DBMS_SESSION.UNIQUE_SESSION_ID", "-> string", "An id unique among the sessions connected now."],
  ]),
  ...functionSpecs("locking", [
    [
      "DBMS_LOCK.ALLOCATE_UNIQUE",
      "name, handle, expiration_secs? ->",
      "A lock handle for a named user lock, made once and shared by every session asking for the name.",
    ],
    ["DBMS_LOCK.CONVERT", "id, mode, timeout? -> number", "Changes the mode of a held user lock; 0 on success."],
    ["DBMS_LOCK.RELEASE", "id -> number", "Releases a user lock; 0 on success."],
    [
      "DBMS_LOCK.REQUEST",
      "id, mode?, timeout?, release_on_commit? -> number",
      "Takes a user lock by id or handle; 0 on success, 1 on timeout, 2 on deadlock.",
    ],
    ["DBMS_LOCK.SLEEP", "seconds ->", "Pauses the session; deprecated for DBMS_SESSION.SLEEP."],
  ]),
  ...functionSpecs("server", [
    ["DBMS_APPLICATION_INFO.READ_CLIENT_INFO", "client_info ->", "Reads the session's client info."],
    ["DBMS_APPLICATION_INFO.READ_MODULE", "module, action ->", "Reads the session's module and action."],
    ["DBMS_APPLICATION_INFO.SET_ACTION", "action ->", "Names the action the module is on, for V$SESSION."],
    ["DBMS_APPLICATION_INFO.SET_CLIENT_INFO", "client_info ->", "Sets free text about the client, for V$SESSION."],
    [
      "DBMS_APPLICATION_INFO.SET_MODULE",
      "module, action ->",
      "Names the module and action the session runs, for V$SESSION.",
    ],
  ]),
  ...functionSpecs("server", [
    [
      "DBMS_METADATA.GET_DDL",
      "object_type, name, schema?, version?, model?, transform? -> clob",
      "The DDL that recreates an object, such as GET_DDL('TABLE', 'ORDERS').",
    ],
    [
      "DBMS_METADATA.GET_DEPENDENT_DDL",
      "object_type, base_name, base_schema?, version?, model?, transform?, count? -> clob",
      "The DDL of objects that hang off another, such as a table's indexes, comments or grants.",
    ],
    [
      "DBMS_METADATA.GET_GRANTED_DDL",
      "object_type, grantee?, version?, model?, transform?, count? -> clob",
      "The DDL of the grants a user holds.",
    ],
    [
      "DBMS_METADATA.GET_XML",
      "object_type, name, schema?, version?, model?, transform? -> clob",
      "An object's metadata as XML.",
    ],
    [
      "DBMS_METADATA.SET_TRANSFORM_PARAM",
      "handle, name, value, object_type? ->",
      "Tunes the DDL GET_DDL writes, such as dropping storage clauses or adding terminators.",
    ],
  ]),
  ...functionSpecs("server", [
    [
      "DBMS_XPLAN.DISPLAY",
      "table?, statement_id?, format?, filter? -> table",
      "The plan EXPLAIN PLAN wrote to PLAN_TABLE, formatted; select from TABLE(...).",
    ],
    [
      "DBMS_XPLAN.DISPLAY_AWR",
      "sql_id, plan_hash_value?, db_id?, format? -> table",
      "Plans of a statement kept in the Automatic Workload Repository.",
    ],
    [
      "DBMS_XPLAN.DISPLAY_CURSOR",
      "sql_id?, child_number?, format? -> table",
      "The plan of a cursor in the shared pool, the session's last one by default; 'ALLSTATS LAST' adds run statistics.",
    ],
    [
      "DBMS_XPLAN.DISPLAY_SQL_PLAN_BASELINE",
      "sql_handle?, plan_name?, format? -> table",
      "The plans of a SQL plan baseline.",
    ],
  ]),
  ...functionSpecs("server", [
    ["DBMS_STATS.DELETE_INDEX_STATS", "owner, index, partition? ->", "Removes an index's optimizer statistics."],
    ["DBMS_STATS.DELETE_SCHEMA_STATS", "owner ->", "Removes the optimizer statistics of a schema's objects."],
    [
      "DBMS_STATS.DELETE_TABLE_STATS",
      "owner, table, partition? ->",
      "Removes a table's optimizer statistics, with its columns' and indexes'.",
    ],
    ["DBMS_STATS.GATHER_DATABASE_STATS", "->", "Gathers optimizer statistics for every schema."],
    [
      "DBMS_STATS.GATHER_INDEX_STATS",
      "owner, index, partition?, estimate_percent? ->",
      "Gathers optimizer statistics for an index.",
    ],
    [
      "DBMS_STATS.GATHER_SCHEMA_STATS",
      "owner, estimate_percent?, block_sample?, method_opt?, degree? ->",
      "Gathers optimizer statistics for a schema's objects.",
    ],
    [
      "DBMS_STATS.GATHER_TABLE_STATS",
      "owner, table, partition?, estimate_percent?, block_sample?, method_opt?, degree?, granularity?, cascade? ->",
      "Gathers optimizer statistics for a table, its columns and, with cascade, its indexes.",
    ],
  ]),
  ...functionSpecs("string", [
    ["DBMS_ASSERT.ENQUOTE_LITERAL", "text -> string", "Text in single quotes, refused when it holds a lone quote."],
    [
      "DBMS_ASSERT.ENQUOTE_NAME",
      "name, capitalize? -> string",
      "A name in double quotes, upper-cased unless told not to.",
    ],
    ["DBMS_ASSERT.NOOP", "text -> string", "Its argument unchanged, to mark input checked by other means."],
    [
      "DBMS_ASSERT.QUALIFIED_SQL_NAME",
      "name -> string",
      "The name when it is a valid qualified SQL name, else an error.",
    ],
    ["DBMS_ASSERT.SCHEMA_NAME", "name -> string", "The name when a schema of that name exists, else an error."],
    ["DBMS_ASSERT.SIMPLE_SQL_NAME", "name -> string", "The name when it is a valid simple SQL name, else an error."],
    ["DBMS_ASSERT.SQL_OBJECT_NAME", "name -> string", "The name when an object of that name exists, else an error."],
  ]),
  ...functionSpecs("encryption", [
    [
      "DBMS_CRYPTO.DECRYPT",
      "src, type, key, iv? -> raw",
      "Decrypts RAW data with a cipher, chaining and padding combined in type.",
    ],
    [
      "DBMS_CRYPTO.ENCRYPT",
      "src, type, key, iv? -> raw",
      "Encrypts RAW data with a cipher, chaining and padding combined in type.",
    ],
    ["DBMS_CRYPTO.HASH", "src, type -> raw", "A digest of RAW data or a LOB, such as DBMS_CRYPTO.HASH_SH256."],
    ["DBMS_CRYPTO.MAC", "src, type, key -> raw", "A keyed MAC of RAW data or a LOB, such as DBMS_CRYPTO.HMAC_SH256."],
    ["DBMS_CRYPTO.RANDOMBYTES", "count -> raw", "Cryptographically secure random bytes."],
    ["DBMS_CRYPTO.RANDOMINTEGER", "-> number", "A cryptographically secure random integer."],
    ["DBMS_CRYPTO.RANDOMNUMBER", "-> number", "A cryptographically secure random number below 2 ** 128."],
  ]),
  ...functionSpecs("server", [
    [
      "DBMS_SCHEDULER.CREATE_JOB",
      "job_name, job_type, job_action, arguments?, start_date?, repeat_interval?, end_date?, job_class?, enabled?, auto_drop?, comments? ->",
      "Creates a scheduler job that runs a PL/SQL block, a stored procedure or a program, once or on a calendar.",
    ],
    ["DBMS_SCHEDULER.DISABLE", "name, force?, commit_semantics? ->", "Disables a job, program or window."],
    [
      "DBMS_SCHEDULER.DROP_JOB",
      "job_name, force?, defer?, commit_semantics? ->",
      "Drops a job, stopping it first when force is true.",
    ],
    ["DBMS_SCHEDULER.ENABLE", "name, commit_semantics? ->", "Enables a job, program or window."],
    [
      "DBMS_SCHEDULER.RUN_JOB",
      "job_name, use_current_session? ->",
      "Runs a job now, in this session unless told to run it in the background.",
    ],
    [
      "DBMS_SCHEDULER.SET_ATTRIBUTE",
      "name, attribute, value ->",
      "Changes one attribute of a job, program or schedule.",
    ],
    ["DBMS_SCHEDULER.STOP_JOB", "job_name, force? ->", "Stops a running job."],
  ]),
];
