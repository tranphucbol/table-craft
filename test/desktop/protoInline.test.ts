import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { inlineProtoLoad } from "../../packages/desktop/vite.plugins.config.js";

/** etcd3 as the etcd plugin depends on it, so the test follows the version the bundle takes. */
const fromEtcdPlugin = createRequire(join(import.meta.dirname, "..", "..", "plugins", "etcd", "package.json"));
const CONNECTION_POOL = fromEtcdPlugin.resolve("etcd3/lib/connection-pool.js");
/** Where the inlined module believes it lives: no `.proto` file is anywhere near it. */
const NOWHERE = "/nonexistent/table-craft/etcd3/lib";
const INLINED_JSON = /\.fromJSON\)\((\{.*?\}),\s*\{\s*keepCase/s;

/** proto-loader's definition: a service is its methods by name, a message its descriptor. */
type Definition = Readonly<Record<string, { readonly type?: { readonly field?: readonly { name: string }[] } }>>;

function inlined(): string {
  return inlineProtoLoad(readFileSync(CONNECTION_POOL, "utf8"), CONNECTION_POOL);
}

describe("etcd proto inlining (plan 110)", () => {
  it("givenEtcd3ConnectionPool_whenInlined_thenNoProtoFileIsRead", () => {
    const code = inlined();
    expect(code).not.toContain("__dirname}/../proto");
    expect(code).not.toMatch(/loadSync\)\(/);
    // Evaluated as Node would a CommonJS module far from etcd3's proto directory, with its real deps.
    const module = { exports: {} as Record<string, unknown> };
    const evaluate = runInThisContext(`(function (exports, require, module, __filename, __dirname) {${code}\n})`) as (
      ...args: unknown[]
    ) => void;
    evaluate(module.exports, createRequire(CONNECTION_POOL), module, join(NOWHERE, "connection-pool.js"), NOWHERE);
    expect(typeof module.exports.ConnectionPool).toBe("function");
  });

  it("givenInlinedDefinitions_whenLoaded_thenEtcdServicesKeepTheirMethodsAndFieldNames", () => {
    const json: unknown = JSON.parse(INLINED_JSON.exec(inlined())?.[1] ?? "null");
    const fromEtcd3 = createRequire(CONNECTION_POOL);
    const loader = fromEtcd3("@grpc/proto-loader") as {
      fromJSON(json: unknown, options: object): Definition;
    };
    const definition = loader.fromJSON(json, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    expect(Object.keys(definition["etcdserverpb.KV"] ?? {})).toEqual(
      expect.arrayContaining(["Range", "Put", "DeleteRange", "Txn", "Compact"]),
    );
    expect(Object.keys(definition["etcdserverpb.Maintenance"] ?? {})).toEqual(
      expect.arrayContaining(["Status", "HashKV", "Alarm", "Defragment"]),
    );
    expect(definition["etcdserverpb.Auth"]).toHaveProperty("Authenticate");
    const rangeFields = definition["etcdserverpb.RangeRequest"]?.type?.field?.map((field) => field.name);
    expect(rangeFields).toEqual(expect.arrayContaining(["range_end", "keys_only", "count_only"]));
  });

  it("givenModuleWithoutTheCall_whenInlined_thenTheBuildFailsNamingWhatToUpdate", () => {
    expect(() => inlineProtoLoad("module.exports = 1;", CONNECTION_POOL)).toThrow(/update PROTO_LOAD_CALL/);
  });
});
