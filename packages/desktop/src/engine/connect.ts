import type { Connector } from "@table-craft/core";
import type { ConnectOptions, Row, Session } from "@table-craft/plugin-api";
import type { EngineOptions } from "@table-craft/desktop/engine/engine.js";
import { connectionFailed } from "@table-craft/desktop/engine/failures.js";
import type { DatasourceConfig } from "@table-craft/desktop/engine/protocol.js";

export const MS_PER_SECOND = 1_000;

/** Every connection the engine opens asks for TCP keepalive at the data source's interval (decision 054). */
export function connectOptions(datasource: DatasourceConfig, readOnly: boolean): ConnectOptions {
  const { keepAliveSeconds } = datasource;
  return keepAliveSeconds > 0 ? { readOnly, keepAliveInitialDelayMs: keepAliveSeconds * MS_PER_SECOND } : { readOnly };
}

export function connectDatasource(
  options: EngineOptions,
  connector: Connector,
  readOnly = options.datasource.readOnly,
): Promise<Session> {
  return connector.connect(connectOptions(options.datasource, readOnly)).catch((cause: unknown) => {
    throw connectionFailed(cause);
  });
}

/** Reads a result to its end, so a statement run for its effect has finished. */
export async function drained(result: { readonly rows: AsyncIterable<Row> }): Promise<void> {
  for await (const row of result.rows) void row;
}
