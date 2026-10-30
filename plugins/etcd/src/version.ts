import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { GrpcTls } from "./tls.js";

/** etcd serves its version over plain HTTP on the client port, to anyone, auth on or off. */
const VERSION_PATH = "/version";
const OK = 200;
const MAX_VERSION_BYTES = 64 * 1024;

/**
 * The server's version from `GET /version` on the endpoint gRPC uses (decision 10 of plan 110),
 * for a user etcd keeps from the status call; null when it does not answer.
 */
export function httpVersion(address: string, tls: GrpcTls | null, timeoutMs: number): Promise<string | null> {
  const separator = address.lastIndexOf(":");
  const host = address.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
  const port = Number(address.slice(separator + 1));
  return new Promise((resolve) => {
    const options = { host, port, path: VERSION_PATH, timeout: timeoutMs };
    const done = (response: IncomingMessage) => {
      if (response.statusCode !== OK) {
        response.resume();
        resolve(null);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("error", () => resolve(null));
      response.on("aborted", () => resolve(null));
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_VERSION_BYTES) {
          response.destroy();
          resolve(null);
        }
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { etcdserver?: unknown };
          resolve(typeof parsed.etcdserver === "string" ? parsed.etcdserver : null);
        } catch {
          resolve(null);
        }
      });
    };
    const request =
      tls === null
        ? httpRequest(options, done)
        : httpsRequest(
            {
              ...options,
              ...(tls.rootCertificate === null ? {} : { ca: tls.rootCertificate }),
              ...(tls.certChain === null ? {} : { cert: tls.certChain }),
              ...(tls.privateKey === null ? {} : { key: tls.privateKey }),
              ...(tls.serverName === null || isIP(tls.serverName) !== 0 ? {} : { servername: tls.serverName }),
              rejectUnauthorized: tls.rejectUnauthorized,
              checkServerIdentity: tls.checkServerIdentity,
            },
            done,
          );
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}
