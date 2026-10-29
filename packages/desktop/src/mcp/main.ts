import { randomUUID } from "node:crypto";
import type { MessagePortMain, ParentPort } from "electron";
import { createLogger } from "@table-craft/desktop/log/record.js";
import type { EnginePort } from "@table-craft/desktop/mcp/engines.js";
import { createMcpHost } from "@table-craft/desktop/mcp/host.js";
import {
  MCP_LOG_MESSAGE,
  MCP_SHUTDOWN_MESSAGE,
  type MainToMcp,
  type McpToMain,
} from "@table-craft/desktop/mcp/messages.js";

interface UtilityProcess {
  readonly parentPort: ParentPort;
}

process.setSourceMapsEnabled(true);

const parentPort = (process as unknown as UtilityProcess).parentPort;
const send = (message: McpToMain): void => parentPort.postMessage(message);
const log = createLogger({ process: "mcp", scope: "mcp", sink: (record) => send({ kind: MCP_LOG_MESSAGE, record }) });
const UNCAUGHT_EXIT_CODE = 1;

function crash(msg: string, cause: unknown): void {
  log.error(msg, { err: cause });
  // A turn later, so the record posted above leaves the port before the process does.
  setImmediate(() => process.exit(UNCAUGHT_EXIT_CODE));
}

process.on("uncaughtException", (cause) => crash("uncaught exception", cause));
process.on("unhandledRejection", (cause) => crash("unhandled rejection", cause));

function enginePort(port: MessagePortMain): EnginePort {
  const adapted: EnginePort = {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on("message", (event) => listener(event.data)),
    onClose: (listener) => port.on("close", listener),
    close: () => port.close(),
  };
  port.start();
  return adapted;
}

const host = createMcpHost({ send, log, newSessionId: randomUUID });

parentPort.on("message", (event) => {
  const message = event.data as MainToMcp;
  const [port] = event.ports;
  if (message.kind === MCP_SHUTDOWN_MESSAGE) {
    void host.close().finally(() => process.exit(0));
    return;
  }
  host.handle(message, port === undefined ? undefined : enginePort(port));
});
