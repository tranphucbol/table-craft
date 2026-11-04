# DuckDB

The DuckDB plugin opens a DuckDB database file, or a Parquet, CSV or JSON file on its own, and
queries it with DuckDB's SQL. It downloads on demand like the other
[plugins](plugins.md#databases-in-the-box-and-on-demand); unlike them it carries DuckDB itself, so
each computer gets the build for its system, about 20 to 29 MB.

- **The file.** **Path** takes a `.duckdb` file (a missing one is created), `:memory:` for a
  scratch database that lives as long as the connection, or a data file: `.parquet`, `.csv`,
  `.tsv`, `.json`, `.ndjson` or `.jsonl`, compressed as `.gz` or `.zst` too. A data file opens as
  an in-memory database with one view named after the file, `orders` for `orders.parquet`; a glob
  such as `/data/2026-*.parquet` makes one view named `data`. Paste `duckdb:///path/to/file` to
  fill it in.
- **Files from a console.** Any data source on this plugin reads files by path:
  `SELECT * FROM 'events.csv.zst'`, `FROM read_parquet('logs/*.parquet')`, or
  `CREATE TABLE t AS FROM 'x.csv'` to copy one into the database.
- **One program at a time.** DuckDB locks a database file for the program that opens it for
  writing. Consoles of the same data source share one open file; a second data source on the same
  file, or another program, is refused with the name and process id of the program holding it.
  **Open the file read-only** (under Advanced), in every program that uses the file, lets them
  share it. A data source marked read-only runs each statement in a read-only transaction.
- **Values.** `HUGEINT` and `BIGINT` keep every digit and `DECIMAL` its scale. Lists, structs, maps
  and unions read as JSON, a map as an array of `{"key", "value"}` pairs. `TIMESTAMPTZ` shows in
  DuckDB's time zone setting, and `INTERVAL`, `UUID` and `BIT` as DuckDB prints them.
- **Transactions.** In manual mode the first statement opens a transaction. An error inside it
  aborts the whole transaction: every later statement fails until you roll back, and a **Commit**
  then keeps nothing. Two consoles changing the same row conflict at once (`Conflict on update`),
  and two inserting the same key fail at the second commit. DuckDB has no savepoints, so editing a
  result in a console with an open transaction is refused until you commit or roll back; the
  table editor works as usual.
- **Explain.** **Explain Plan** and **Explain Analyse** show DuckDB's operator tree, with the
  estimated rows of each step, and its rows and time once analysed.
- **Extensions.** Parquet, JSON, ICU and the core functions are built in. Reading `https://` or
  `s3://` paths or other formats makes DuckDB download an extension from `extensions.duckdb.org`;
  turn off **Let DuckDB download extensions it needs** (under Advanced) to keep it offline, and
  `INSTALL` or `LOAD` one by hand. Credentials for remote files go in a `CREATE SECRET` statement;
  it is kept in the query history like any other statement, so prefer `PROVIDER credential_chain`
  over writing keys into it.
- **Windows** needs the Microsoft Visual C++ Redistributable; without it, connecting says so.
