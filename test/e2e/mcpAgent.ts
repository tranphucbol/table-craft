import { createServer } from "node:net";

const PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER = "mcp-session-id";

export async function freePort(): Promise<number> {
  return new Promise((settle, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => settle(port));
    });
  });
}

export interface ToolText {
  readonly text: string;
  readonly isError: boolean;
}

/** A minimal Streamable HTTP client, as Claude Code or OpenCode would speak to the server. */
export class AgentClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  async initialize(name: string): Promise<void> {
    const response = await this.post({
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version: "1.0.0" } },
    });
    this.sessionId = response.headers.get(SESSION_HEADER);
    await this.post({ method: "notifications/initialized" }, false);
  }

  async tool(name: string, args: Record<string, unknown>): Promise<ToolText> {
    const response = await this.post({ method: "tools/call", params: { name, arguments: args } });
    const body = (await response.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    return { text: body.result.content.map((part) => part.text).join("\n"), isError: body.result.isError === true };
  }

  /** Ends the MCP session the way a client does when it quits. */
  async close(): Promise<void> {
    if (this.sessionId === null) return;
    await fetch(`http://127.0.0.1:${String(this.port)}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.token}`, [SESSION_HEADER]: this.sessionId },
    });
    this.sessionId = null;
  }

  private async post(message: Record<string, unknown>, request = true): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.sessionId !== null) headers[SESSION_HEADER] = this.sessionId;
    const body = { jsonrpc: "2.0", ...message, ...(request ? { id: this.nextId++ } : {}) };
    const response = await fetch(`http://127.0.0.1:${String(this.port)}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 202) throw new Error(`MCP answered ${String(response.status)}`);
    return response;
  }
}
