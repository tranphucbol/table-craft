# @tablecraft-app/plugin-api

The contract between [TableCraft](https://github.com/tranphucbol/table-craft) and its datasource
plugins: the types a plugin implements, the manifest schema, the shared SQL helpers and the
contract test suite every built-in plugin passes.

| Entry                                | Holds                                                                                                     |
| :----------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `@tablecraft-app/plugin-api`         | `DatasourcePlugin`, `Session`, `SqlLanguage`, the manifest schema, `PluginError`, `API_VERSION`, and more |
| `@tablecraft-app/plugin-api/sql`     | The statement splitter, classifier, literal helpers, completer and formatter plugins build `language` on  |
| `@tablecraft-app/plugin-api/testing` | `runPluginContract(plugin, fixture)`, the contract suite, for Vitest                                      |

## A plugin

A plugin is a folder with a `table-craft-plugin.json` manifest and an ES module whose default
export implements `DatasourcePlugin`. Put it in `plugins/<id>/` in the TableCraft profile folder.
Set the manifest's `apiVersion` to the version of this package you built against; bundle this
package and your driver into the module, since TableCraft loads the plugin from its folder alone.

```ts
import type { DatasourcePlugin } from "@tablecraft-app/plugin-api";

const plugin: DatasourcePlugin = {
  id: "example",
  capabilities: ["sql"],
  // connectionSchema, language and connect
};

export default plugin;
```

Test it with the contract suite in a Vitest file: `runPluginContract(plugin, fixture)` connects
with `fixture.config` to a database seeded with the suite's `type_probe` table, and checks every
capability the manifest declares. `ContractFixture` documents each field.

[Writing plugins](https://github.com/tranphucbol/table-craft/blob/main/docs/guide/writing-plugins.md)
describes every capability and manifest field.

## Compatibility

This package follows semver, and its version is the plugin API version:

- TableCraft with plugin API `1.z` loads a plugin built for `1.y` when `y` is `z` or lower.
- A minor version only adds: new exports, new optional fields and methods, new capabilities.
- Breaking changes wait for the next major. Before removal, a member is marked `@deprecated` with
  its replacement for at least one major.

## License

MIT
