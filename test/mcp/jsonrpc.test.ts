import { describe, expect, it } from "vitest";
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
  RpcError,
  idOf,
  parseMessage,
} from "@table-craft/desktop/mcp/jsonrpc.js";
import { negotiatedVersion, SUPPORTED_PROTOCOL_VERSIONS } from "@table-craft/desktop/mcp/server.js";

function codeOf(text: string): number | null {
  try {
    parseMessage(text);
    return null;
  } catch (cause) {
    return cause instanceof RpcError ? cause.code : null;
  }
}

describe("MCP JSON-RPC", () => {
  it("givenRequest_whenParsed_thenIdMethodAndParamsKept", () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":7,"method":"tools/list"}')).toEqual({
      kind: "request",
      id: 7,
      method: "tools/list",
      params: {},
    });
  });

  it("givenNoId_whenParsed_thenNotification", () => {
    expect(parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toMatchObject({
      kind: "notification",
    });
  });

  it("givenResultFromClient_whenParsed_thenResponse", () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ kind: "response" });
  });

  it("givenBrokenBodies_whenParsed_thenTheMatchingErrorCode", () => {
    expect(codeOf("{")).toBe(PARSE_ERROR);
    expect(codeOf('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).toBe(INVALID_REQUEST);
    expect(codeOf('{"id":1,"method":"ping"}')).toBe(INVALID_REQUEST);
    expect(codeOf('{"jsonrpc":"2.0","id":1.5,"method":"ping"}')).toBe(INVALID_REQUEST);
    expect(codeOf('{"jsonrpc":"2.0","id":1,"method":"ping","params":[1]}')).toBe(INVALID_PARAMS);
  });

  it("givenBrokenMessageWithId_whenIdRead_thenTheIdIsAnswered", () => {
    expect(idOf('{"jsonrpc":"1.0","id":"a"}')).toBe("a");
    expect(idOf("not json")).toBeNull();
  });

  it("givenClientVersion_whenNegotiated_thenSupportedOnesEchoAndOthersGetTheLatest", () => {
    expect(negotiatedVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiatedVersion("2024-11-05")).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiatedVersion(null)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });
});
