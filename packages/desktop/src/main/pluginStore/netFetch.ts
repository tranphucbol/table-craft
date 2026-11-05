/**
 * The plugin store's fetch over Electron's `net`, so the system proxy applies (decision 110).
 * `net.fetch` rejects a `redirect: "manual"` request with "Redirect was cancelled" instead of
 * answering the 3xx, so those go through `net.request`, whose `redirect` event names the target:
 * a private registry follows redirects itself, one hop at a time (decision 158).
 */
import { net, type IncomingMessage } from "electron";
import type { RegistryFetch } from "@table-craft/desktop/main/pluginStore/registry.js";

/** Statuses a `Response` must be built without a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function headersOf(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const each of [value].flat()) headers.append(name, each);
  }
  return headers;
}

function bodyOf(message: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      message.on("end", () => controller.close());
      message.on("error", (error: Error) => controller.error(error));
    },
  });
}

function withoutRedirects(url: string, headers: Readonly<Record<string, string>>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: "manual" });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    request.on("redirect", (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on("response", (message) => {
      const status = message.statusCode;
      resolve(
        new Response(NULL_BODY_STATUSES.has(status) ? null : bodyOf(message), { status, headers: headersOf(message) }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

export const netFetch: RegistryFetch = (url, init) =>
  init.redirect === "manual" ? withoutRedirects(url, init.headers ?? {}) : net.fetch(url, init);
