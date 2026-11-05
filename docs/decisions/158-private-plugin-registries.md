# 158: Private plugin registries

Status: Accepted. Plan 154. Amends 110.

## Decision

A company publishes its own TableCraft plugins to its own npm registry (GitLab's package registry,
Nexus, Artifactory, Verdaccio) and users install them by package name. Official plugins keep
coming from `plugins.registryUrl`, as decision 110 says.

- **Settings.** `plugins.registries` in `settings.json` lists `{ id, name, url, scopes, packages }`.
  A package routes by its scope: the registry that lists the scope serves it, every other scope
  goes to `plugins.registryUrl`. `@tablecraft-app` can never be claimed, and a scope belongs to one
  registry; the reader drops an entry that breaks either rule. `url` follows `registryUrlError`
  (`https://`, plain `http://` only to loopback) and may carry a path, such as
  `https://gitlab.example.com/api/v4/packages/npm`.
- **Token.** One per registry, in `secrets.json`'s `registries` section, encrypted by
  `safeStorage` (decision 020); the renderer sees only `tokenStored`. It is sent as
  `Authorization: Bearer` only to the registry's own origin: a tarball on another origin is fetched
  without it, redirects are followed by hand one hop at a time, and a redirect that leaves the
  origin while the header is set is refused. A packument request never follows a redirect off the
  origin: GitLab forwards a package it does not hold to npmjs, which reads as not found.
- **Install by name.** No discovery: the user types `@scope/package`. Main refuses before any
  request when no registry serves the scope. It walks the versions on the user's channel newest
  first; a packument with `tableCraft` is judged as today, otherwise the tarball is downloaded and
  its `package.json` `tableCraft.{id, apiVersion}` decides, at most three downloads, then the
  error says which TableCraft the newest needs. An id that is built in, in the official catalog, or
  installed from another package is refused after reading the tarball.
- **Integrity.** sha512 when the registry gives it; a private registry without it (GitLab gives
  only `dist.shasum`) is checked with SHA-1, and its card says so. The official registry still
  requires sha512.
- **Trust.** The first install of a package from a private registry asks a native confirmation in
  main naming the plugin, package, version, registry, what it adds and its size, Cancel by default.
  Updates of a package installed from that registry do not ask.
- **Updates.** `current.json` gains `registry: <id>`; absent means the official registry, so old
  profiles read as before. The background check and the outdated-plugin path include a managed
  plugin whose registry is still configured and still lists its package. A 401 or 403 is the
  `unauthorized` failure, with a hint to set the token, and marks the registry's card refused.
- **Missing plugins.** `<userData>/plugin-packages.json` maps each installed package to its id,
  name, brands, schemes and size, so a configured registry's packages show under Available and a
  datasource whose plugin is missing offers its install without a download.
- **Removing a registry** keeps its plugins installed, labelled "Registry removed", stops
  updating them and forgets the token.
- **Where the user meets it.** Settings → Plugins: Installed (with the registry each plugin came
  from), Available (with a "By package name" row), Registries (npm first, then a card per private
  registry with Test, Edit, Remove and its token; + Add registry), From a file. Test reads the
  packument of a package the registry serves, else probes a made-up one in its first scope.

## Rationale

Routing by scope is how npm itself configures registries (`@acme:registry=`), so a package name
alone decides where it comes from and a private registry can never shadow an official plugin.

GitLab hides packages from requests without a token behind a 404, and forwards a package it does
not hold to npmjs whatever the token, so neither a probe nor a not-found answer proves a token
works; only a package the registry serves does. That is why Test prefers one, and why a cross-origin
redirect of a packument reads as not found rather than following it to the public registry.

GitLab's packument carries neither `tableCraft` nor `integrity`, so compatibility comes from the
tarball and the checksum is SHA-1. SHA-1 over HTTPS from a registry the user configured with a
token is weaker than sha512 but still detects corruption and a swapped mirror; refusing it would
make GitLab unusable.

Sending the token only to its origin, and never following a redirect off it with the header,
keeps a misconfigured or hostile redirect from leaking it.

## Consequences

**Tests never reach a real registry.** The loopback fixture serves under a path prefix, requires a
bearer token on its own origin, and imitates GitLab's packument and its redirect to another origin;
`test/e2e/privateRegistry.smoke.test.ts` installs, updates and refuses through it.

**Discovery stays out.** A registry search API differs across GitLab, Nexus and Artifactory, so a
user learns the package name from whoever publishes it.

**Datasources of a private plugin** on a machine without the registry still need its `.tgz` from a
file.
