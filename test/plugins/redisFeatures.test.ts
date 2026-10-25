import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import redis from "@table-craft/plugin-redis";
import { featuresOf, lowestVersion } from "@table-craft/plugin-redis/features";
import { PluginError } from "@table-craft/plugin-api";
import { afterEach, describe, expect, it } from "vitest";

const OLD_VERSION = "6.0.20";
const CRLF = "\r\n";

function bulk(text: string): string {
  return `$${Buffer.byteLength(text)}${CRLF}${text}${CRLF}`;
}

/** Each complete RESP array of bulk strings in `buffer`, and what is left of it. */
function commandsIn(buffer: string): { commands: string[][]; rest: string } {
  const commands: string[][] = [];
  let rest = buffer;
  for (;;) {
    const lines = rest.split(CRLF);
    const header = /^\*(\d+)$/.exec(lines[0] ?? "");
    if (header === null) return { commands, rest };
    const count = Number(header[1]);
    if (lines.length < 1 + count * 2 + 1) return { commands, rest };
    const args = Array.from({ length: count }, (_, index) => lines[2 + index * 2] ?? "");
    commands.push(args);
    rest = lines.slice(1 + count * 2).join(CRLF);
  }
}

/** A server that answers like Redis `version` would: `HELLO`, `INFO` and OK to the rest. */
function fakeRedis(version: string): Promise<Server> {
  const reply = (args: readonly string[]): string => {
    switch (args[0]?.toUpperCase()) {
      case "HELLO":
        return `%3${CRLF}${bulk("server")}${bulk("redis")}${bulk("version")}${bulk(version)}${bulk("proto")}:3${CRLF}`;
      case "INFO":
        return bulk(`# Server${CRLF}redis_version:${version}${CRLF}redis_mode:standalone${CRLF}`);
      default:
        return `+OK${CRLF}`;
    }
  };
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const { commands, rest } = commandsIn(buffer + chunk);
      buffer = rest;
      for (const command of commands) socket.write(reply(command));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

describe("redis features", () => {
  it("givenServer60_whenConnect_thenConnectionFailedNamingTheVersion", async () => {
    server = await fakeRedis(OLD_VERSION);
    const { port } = server.address() as AddressInfo;
    const config = redis.connectionSchema.parse({ mode: "standalone", host: "127.0.0.1", port });
    const error: unknown = await redis.connect(config, { readOnly: false }).then(
      async (session) => {
        await session.close();
        return null;
      },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({
      code: "connectionFailed",
      message: `Redis 6.2 or later is required (server is ${OLD_VERSION}).`,
    });
  });

  it("givenMixedVersionCluster_whenFeatures_thenLowestVersionWins", () => {
    const version = lowestVersion(["7.4.1", "6.2.14", "7.2.0"]);
    expect(version).toBe("6.2.14");
    expect(featuresOf(version, new Set(["GET"]))).toMatchObject({
      version: "6.2.14",
      commandDocs: false,
      multiSectionInfo: false,
      hashFieldTtl: false,
      expireTime: false,
    });
    expect(featuresOf("7.4.1", new Set(["HTTL", "EXPIRETIME"]))).toMatchObject({
      commandDocs: true,
      hashFieldTtl: true,
      expireTime: true,
    });
  });
});
