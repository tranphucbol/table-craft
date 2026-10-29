/**
 * A loopback npm registry and the tarballs it serves, so no test reaches registry.npmjs.org
 * (decision 110). `startRegistry` answers packuments at `/<scope>%2f<name>` and tarballs at
 * `/tarballs/<file>`, the shapes `pluginStore/registry.ts` reads.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_BYTES = 100;
const END_BLOCKS = 2;
const LOOPBACK = "127.0.0.1";
/** Asked for this, registry.npmjs.org leaves custom fields such as `tableCraft` out, and so does this fixture. */
const ABBREVIATED_PACKUMENT = "application/vnd.npm.install-v1+json";

export interface TarEntry {
  readonly path: string;
  readonly data?: string | Buffer;
  /** ustar type flag: `0` file (default), `2` symlink, `5` directory, `x` pax header. */
  readonly type?: string;
  readonly linkName?: string;
}

function field(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value.slice(0, length), offset, length, "utf8");
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  field(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function header(entry: TarEntry, size: number): Buffer {
  if (Buffer.byteLength(entry.path) > NAME_BYTES) throw new Error(`tar fixture path too long: ${entry.path}`);
  const block = Buffer.alloc(BLOCK);
  field(block, 0, NAME_BYTES, entry.path);
  octal(block, 100, 8, 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  block.fill(" ", 148, 156);
  field(block, 156, 1, entry.type ?? "0");
  field(block, 157, NAME_BYTES, entry.linkName ?? "");
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** A gzipped ustar archive of `entries`, in order. */
export function tarball(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    parts.push(header(entry, data.length), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * END_BLOCKS));
  return gzipSync(Buffer.concat(parts));
}

/** One pax `path=` record, for a header of type `x`. */
export function paxPath(path: string): string {
  const body = ` path=${path}\n`;
  let length = body.length;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${String(length)}${body}`;
}

export interface PluginPackage {
  readonly id: string;
  readonly version: string;
  readonly apiVersion?: string;
  readonly name?: string;
  /** The manifest to ship; defaults to the source tree's manifest of `id`, renamed to `version`. */
  readonly manifest?: Record<string, unknown>;
  readonly indexJs?: string | Buffer;
  readonly extra?: readonly TarEntry[];
}

const SOURCE_MANIFEST = (id: string) => join("plugins", id, "table-craft-plugin.json");

export function pluginPackageName(id: string): string {
  return `@tablecraft-app/plugin-${id}`;
}

/** A plugin `.tgz` laid out as `scripts/plugins/pack.ts` lays it out. */
export function pluginTarball(plugin: PluginPackage): Buffer {
  const apiVersion = plugin.apiVersion ?? "1.0.0";
  const name = plugin.name ?? pluginPackageName(plugin.id);
  const manifest = plugin.manifest ?? {
    ...(JSON.parse(readFileSync(SOURCE_MANIFEST(plugin.id), "utf8")) as Record<string, unknown>),
    version: plugin.version,
    apiVersion,
  };
  const packageJson = {
    name,
    version: plugin.version,
    type: "module",
    main: "index.js",
    tableCraft: { id: plugin.id, apiVersion },
  };
  return tarball([
    { path: "package/package.json", data: JSON.stringify(packageJson, null, 2) },
    { path: "package/table-craft-plugin.json", data: JSON.stringify(manifest, null, 2) },
    { path: "package/index.js", data: plugin.indexJs ?? "export default {};\n" },
    ...(plugin.extra ?? []),
  ]);
}

export function sha512(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export interface RegistryRelease {
  readonly version: string;
  readonly apiVersion: string;
  readonly pluginId: string;
  readonly bytes: Buffer;
  /** What the packument claims; defaults to the bytes' real sha512. A different value is a tampered mirror. */
  readonly integrity?: string;
}

/** `plugin` as the registry serves it; `bytes` replaces the fixture tarball with a real `npm pack`. */
export function release(plugin: PluginPackage, integrity?: string, bytes = pluginTarball(plugin)): RegistryRelease {
  return {
    version: plugin.version,
    apiVersion: plugin.apiVersion ?? "1.0.0",
    pluginId: plugin.id,
    bytes,
    ...(integrity === undefined ? {} : { integrity }),
  };
}

export interface LoopbackRegistry {
  readonly url: string;
  /** Request paths in arrival order. */
  readonly requests: string[];
  publish(packageName: string, releases: readonly RegistryRelease[]): void;
  /** Answers every request after `delayMs`, so a test can see the progress state. */
  slowDown(delayMs: number): void;
  close(): Promise<void>;
}

function tarballFile(packageName: string, version: string): string {
  return `${packageName.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

export async function startRegistry(
  packages: Readonly<Record<string, readonly RegistryRelease[]>> = {},
): Promise<LoopbackRegistry> {
  const published = new Map<string, readonly RegistryRelease[]>(Object.entries(packages));
  const requests: string[] = [];
  let delayMs = 0;
  let base = "";

  function packument(name: string, abbreviated: boolean): unknown {
    const releases = published.get(name) ?? [];
    const versions = Object.fromEntries(
      releases.map((entry) => [
        entry.version,
        {
          name,
          version: entry.version,
          ...(abbreviated ? {} : { tableCraft: { id: entry.pluginId, apiVersion: entry.apiVersion } }),
          dist: {
            tarball: `${base}/tarballs/${tarballFile(name, entry.version)}`,
            integrity: entry.integrity ?? sha512(entry.bytes),
          },
        },
      ]),
    );
    return { name, "dist-tags": { latest: releases.at(-1)?.version }, versions };
  }

  function tarballBytes(file: string): Buffer | undefined {
    for (const [name, releases] of published) {
      const found = releases.find((entry) => tarballFile(name, entry.version) === file);
      if (found !== undefined) return found.bytes;
    }
    return undefined;
  }

  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    const answer = () => {
      if (path.startsWith("/tarballs/")) {
        const bytes = tarballBytes(path.slice("/tarballs/".length));
        if (bytes === undefined) return response.writeHead(404).end();
        return response
          .writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length })
          .end(bytes);
      }
      const name = decodeURIComponent(path.slice(1));
      if (!published.has(name)) return response.writeHead(404, { "content-type": "application/json" }).end("{}");
      const abbreviated = (request.headers.accept ?? "").includes(ABBREVIATED_PACKUMENT);
      return response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(packument(name, abbreviated)));
    };
    if (delayMs === 0) answer();
    else setTimeout(answer, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  base = `http://${LOOPBACK}:${String((server.address() as AddressInfo).port)}`;
  return {
    url: base,
    requests,
    publish: (name, releases) => published.set(name, releases),
    slowDown: (ms) => {
      delayMs = ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
