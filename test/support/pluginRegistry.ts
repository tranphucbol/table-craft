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
import { API_VERSION } from "@table-craft/plugin-api";
import { manifestVersion } from "../../scripts/plugins/pack.js";

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
  /** A native plugin's package for one platform: named `<package>-<platform>`, as decision 156 publishes it. */
  readonly platform?: string;
}

const SOURCE_MANIFEST = (id: string) => join("plugins", id, "table-craft-plugin.json");

export function pluginPackageName(id: string): string {
  return `@tablecraft-app/plugin-${id}`;
}

/** A plugin `.tgz` laid out as `scripts/plugins/pack.ts` lays it out. */
export function pluginTarball(plugin: PluginPackage): Buffer {
  const apiVersion = plugin.apiVersion ?? API_VERSION;
  const name =
    plugin.name ??
    (plugin.platform === undefined
      ? pluginPackageName(plugin.id)
      : `${pluginPackageName(plugin.id)}-${plugin.platform}`);
  const manifest = plugin.manifest ?? {
    ...(JSON.parse(readFileSync(SOURCE_MANIFEST(plugin.id), "utf8")) as Record<string, unknown>),
    version: manifestVersion(plugin.version),
    apiVersion,
  };
  const packageJson = {
    name,
    version: plugin.version,
    type: "module",
    main: "index.js",
    tableCraft: { id: plugin.id, apiVersion, ...(plugin.platform === undefined ? {} : { platform: plugin.platform }) },
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
    apiVersion: plugin.apiVersion ?? API_VERSION,
    pluginId: plugin.id,
    bytes,
    ...(integrity === undefined ? {} : { integrity }),
  };
}

export interface LoopbackRequest {
  readonly path: string;
  /** `127.0.0.1` for the registry's own origin, `localhost` for the stand-in other origin. */
  readonly host: string;
  readonly authorization: string | undefined;
}

export interface LoopbackRegistry {
  /** The registry's address, with its path prefix. */
  readonly url: string;
  /** The same server reached as `localhost`: another origin, as a CDN or npmjs would be. */
  readonly otherOrigin: string;
  /** Request paths in arrival order. */
  readonly requests: string[];
  /** Every request with the host it was sent to and its Authorization header. */
  readonly received: LoopbackRequest[];
  publish(packageName: string, releases: readonly RegistryRelease[]): void;
  /** Answers every request after `delayMs`, so a test can see the progress state. */
  slowDown(delayMs: number): void;
  close(): Promise<void>;
}

export interface RegistryOptions {
  /** A path the registry lives under, as GitLab's `/api/v4/packages/npm`. */
  readonly prefix?: string;
  /** A bearer token the registry's origin requires: none answers 404, another 401, as GitLab does. */
  readonly token?: string;
  /**
   * GitLab's packument: no `tableCraft`, no `integrity`, a hex SHA-1 `shasum`; and a package it
   * does not hold answers a 302 to another origin, as GitLab forwards it to npmjs.
   */
  readonly gitlab?: boolean;
  /** Packuments name tarballs on the other origin. */
  readonly tarballsElsewhere?: boolean;
  /** Tarballs answer a redirect to the same path on the other origin. */
  readonly redirectTarballs?: boolean;
}

const OTHER_HOST = "localhost";
const REDIRECT = 302;

function tarballFile(packageName: string, version: string): string {
  return `${packageName.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

function sha1Hex(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

export async function startRegistry(
  packages: Readonly<Record<string, readonly RegistryRelease[]>> = {},
  options: RegistryOptions = {},
): Promise<LoopbackRegistry> {
  const published = new Map<string, readonly RegistryRelease[]>(Object.entries(packages));
  const requests: string[] = [];
  const received: LoopbackRequest[] = [];
  const prefix = options.prefix ?? "";
  let delayMs = 0;
  let base = "";
  let other = "";

  function dist(name: string, entry: RegistryRelease): Record<string, string> {
    const tarball = `${options.tarballsElsewhere === true ? other : base}${prefix}/tarballs/${tarballFile(name, entry.version)}`;
    if (options.gitlab === true) return { tarball, shasum: sha1Hex(entry.bytes) };
    return { tarball, integrity: entry.integrity ?? sha512(entry.bytes) };
  }

  function packument(name: string, abbreviated: boolean): unknown {
    const releases = published.get(name) ?? [];
    const declared = !abbreviated && options.gitlab !== true;
    const versions = Object.fromEntries(
      releases.map((entry) => [
        entry.version,
        {
          name,
          version: entry.version,
          ...(declared ? { tableCraft: { id: entry.pluginId, apiVersion: entry.apiVersion } } : {}),
          dist: dist(name, entry),
        },
      ]),
    );
    return { name, "dist-tags": { latest: releases.at(-1)?.version }, versions };
  }

  /** Null when the request may go on; otherwise the status the registry refuses it with. */
  function refusal(host: string, authorization: string | undefined): number | null {
    if (options.token === undefined || host === OTHER_HOST) return null;
    if (authorization === undefined) return 404;
    return authorization === `Bearer ${options.token}` ? null : 401;
  }

  function tarballBytes(file: string): Buffer | undefined {
    for (const [name, releases] of published) {
      const found = releases.find((entry) => tarballFile(name, entry.version) === file);
      if (found !== undefined) return found.bytes;
    }
    return undefined;
  }

  const server: Server = createServer((request, response) => {
    const fullPath = request.url ?? "/";
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    const authorization = request.headers.authorization;
    requests.push(fullPath);
    received.push({ path: fullPath, host, authorization });
    const answer = () => {
      if (!fullPath.startsWith(`${prefix}/`)) return response.writeHead(404).end();
      const path = fullPath.slice(prefix.length);
      const refused = refusal(host, authorization);
      if (refused !== null) return response.writeHead(refused, { "content-type": "application/json" }).end("{}");
      if (path.startsWith("/tarballs/")) {
        if (options.redirectTarballs === true && host !== OTHER_HOST) {
          return response.writeHead(REDIRECT, { location: `${other}${fullPath}` }).end();
        }
        const bytes = tarballBytes(path.slice("/tarballs/".length));
        if (bytes === undefined) return response.writeHead(404).end();
        return response
          .writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length })
          .end(bytes);
      }
      const name = decodeURIComponent(path.slice(1));
      if (!published.has(name) && options.gitlab === true && host !== OTHER_HOST) {
        return response.writeHead(REDIRECT, { location: `${other}/${path.slice(1)}` }).end();
      }
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
  const port = String((server.address() as AddressInfo).port);
  base = `http://${LOOPBACK}:${port}`;
  other = `http://${OTHER_HOST}:${port}`;
  return {
    url: `${base}${prefix}`,
    otherOrigin: other,
    requests,
    received,
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
