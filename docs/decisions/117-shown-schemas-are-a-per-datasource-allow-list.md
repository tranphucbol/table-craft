# 117: Shown schemas are a per-datasource allow-list

Status: Accepted

## Decision

**Manage Shown Schemas…** saves, on the datasource in `datasources.json`, an optional
`shownNamespaces`: the names of the top-level namespaces (the databases or schemas
`catalog.namespaces` lists with no parent) the Database pane shows. Absent means every one, which
is how every record saved before this reads, so the file needs no migration and its version stays

1. Only the top level is filtered; a PostgreSQL database's schemas show as before. The dialog's
   **All schemas** is the absent list; it never saves every name.

## Rationale

A shared server with dozens of databases buries the one a user works in. DataGrip answers with
Manage Shown Schemas, and its users expect the same model: a list of what to show.

An allow-list was chosen over a deny-list of hidden names. With a deny-list, a database someone
else creates on the shared server appears in everyone's tree the next time it is listed, which is
the clutter the feature removes; with an allow-list it stays hidden until picked, as in DataGrip.
The cost is the reverse case: a user who hid one database also misses new ones, and **All
schemas** is there for that. Names, not paths, are kept because a top-level namespace's path is its
name, and a name survives the server being recreated.

The filter is a view of the tree, not of the catalog: the engine still lists and caches every
namespace, so completion, Search Everywhere and a console's namespace switcher still reach hidden
ones.

## Consequences

- A saved name the server no longer has is kept, so a database dropped and created again comes
  back shown; the "N of M" counts only names the server lists.
- An ephemeral datasource (`TABLE_CRAFT_DATASOURCE`) cannot be filtered, as it is never saved.
- The Properties dialog does not edit the list but carries it through a save, and Duplicate copies
  it.
