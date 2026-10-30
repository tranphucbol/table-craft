import { PluginError, type KeyRange } from "@table-craft/plugin-api";
import type { IDuplexStream, IWatchRequest, IWatchResponse } from "etcd3";
import type { Call } from "./admin.js";
import { closeStream } from "./client.js";
import { bytesOf } from "./keyBytes.js";
import { NO_END, prefixEnd } from "./scan.js";

/** The sole byte-level namespace boundary for raw KV operations. */
export class NamespaceMapper {
  readonly prefix: Buffer;
  constructor(prefix: Uint8Array = Buffer.alloc(0)) {
    this.prefix = Buffer.from(prefix);
  }
  key(key: Uint8Array): Buffer {
    return Buffer.concat([this.prefix, key]);
  }
  contains(key: Uint8Array): boolean {
    return Buffer.from(key).subarray(0, this.prefix.length).equals(this.prefix);
  }
  strip(key: Uint8Array): Buffer {
    if (!this.contains(key))
      throw new PluginError(
        "statementFailed",
        "etcd returned a key outside the configured namespace. Disconnect and inspect the endpoint.",
      );
    return Buffer.from(key).subarray(this.prefix.length);
  }
  range(range: KeyRange): { key: Buffer; range_end?: Buffer } {
    switch (range.kind) {
      case "key":
        return { key: this.key(bytesOf(range.key)) };
      case "all":
        return this.rawRange(NO_END, NO_END);
      case "prefix": {
        const prefix = bytesOf(range.prefix);
        return this.rawRange(prefix.length === 0 ? NO_END : prefix, prefix.length === 0 ? NO_END : prefixEnd(prefix));
      }
      case "range": {
        const from = bytesOf(range.from);
        const to = bytesOf(range.to);
        if (Buffer.compare(from, to) >= 0)
          throw new PluginError("statementFailed", "The range end must be after its start.");
        return { key: this.key(from), range_end: this.key(to) };
      }
    }
  }
  rawRange(key: Buffer, end?: Buffer): { key: Buffer; range_end?: Buffer } {
    if (end?.length === 0) end = undefined;
    if (this.prefix.length === 0) return { key, ...(end === undefined ? {} : { range_end: end }) };
    const all = end?.equals(NO_END) === true;
    return {
      key: all && key.equals(NO_END) ? this.prefix : this.key(key),
      ...(end === undefined ? {} : { range_end: all ? prefixEnd(this.prefix) : this.key(end) }),
    };
  }
}

type ObjectValue = Record<string, unknown>;
function mapRequest(value: ObjectValue, mapper: NamespaceMapper, serializable = false): ObjectValue {
  const mapped = { ...value };
  for (const field of ["key", "range_end"])
    if (value[field] !== undefined && !Buffer.isBuffer(value[field]))
      throw new PluginError("statementFailed", "Raw etcd key ranges must use Buffer bytes; the request was not sent.");
  if (Buffer.isBuffer(value.key))
    Object.assign(mapped, mapper.rawRange(value.key, Buffer.isBuffer(value.range_end) ? value.range_end : undefined));
  for (const field of ["compare", "success", "failure"])
    if (Array.isArray(value[field]))
      mapped[field] = value[field].map((item: ObjectValue) => mapRequest(item, mapper, serializable));
  for (const field of ["request_range", "request_put", "request_delete_range", "request_txn", "create_request"]) {
    if (value[field] !== undefined) {
      const request = mapRequest(value[field] as ObjectValue, mapper, serializable);
      if (field === "request_range" && request.serializable === undefined) request.serializable = serializable;
      mapped[field] = request;
    }
  }
  return mapped;
}
function mapResponse(value: unknown, mapper: NamespaceMapper): unknown {
  if (Array.isArray(value)) return value.map((item) => mapResponse(item, mapper));
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  const mapped: ObjectValue = {};
  if ("key" in value && !Buffer.isBuffer(value.key))
    throw new PluginError("statementFailed", "etcd returned a non-Buffer key. Disconnect and inspect the endpoint.");
  for (const [field, item] of Object.entries(value))
    mapped[field] =
      field === "key" && Buffer.isBuffer(item)
        ? item.length === 0
          ? item
          : mapper.strip(item)
        : mapResponse(item, mapper);
  return mapped;
}

/** Scope raw KV and Watch only; global RBAC, cluster and lease RPCs are deliberately untouched. */
export function namespaceCall(call: Call, mapper: NamespaceMapper, serializable = false): Call {
  return (work) =>
    call((etcd) => {
      const kv = new Proxy(etcd.kv, {
        get(target, property) {
          const method = Reflect.get(target, property) as unknown;
          if (typeof method !== "function") return method;
          return async (request: ObjectValue, ...args: unknown[]) => {
            const input = mapRequest(request, mapper, serializable);
            if (property === "range" && input.serializable === undefined) input.serializable = serializable;
            return mapResponse(await Reflect.apply(method, target, [input, ...args]), mapper);
          };
        },
      });
      const watchClient = new Proxy(etcd.watchClient, {
        get(target, property) {
          if (property !== "watch") {
            const value = Reflect.get(target, property) as unknown;
            return typeof value === "function" ? (value.bind(target) as unknown) : value;
          }
          return async (...args: unknown[]) => {
            const stream = (await Reflect.apply(target.watch.bind(target), undefined, args)) as IDuplexStream<
              IWatchRequest,
              IWatchResponse
            >;
            const errors = new Set<(...values: unknown[]) => void>();
            const scoped = new Proxy(stream, {
              get(raw, field) {
                if (field === "write") return (request: ObjectValue) => raw.write(mapRequest(request, mapper));
                if (field === "on")
                  return (event: string, listener: (...values: unknown[]) => void) => {
                    if (event === "error") errors.add(listener);
                    raw.on(
                      event as "data",
                      event === "data"
                        ? (response: IWatchResponse) => {
                            try {
                              listener(mapResponse(response, mapper));
                            } catch (error) {
                              for (const handler of errors) handler(error);
                              closeStream(raw);
                            }
                          }
                        : listener,
                    );
                    return scoped;
                  };
                const value = Reflect.get(raw, field) as unknown;
                return typeof value === "function" ? (value.bind(raw) as unknown) : value;
              },
            });
            return scoped;
          };
        },
      });
      return work(
        new Proxy(etcd, {
          get(target, property) {
            if (property === "kv") return kv;
            if (property === "watchClient") return watchClient;
            const value = Reflect.get(target, property) as unknown;
            return typeof value === "function" ? (value.bind(target) as unknown) : value;
          },
        }),
      );
    });
}
