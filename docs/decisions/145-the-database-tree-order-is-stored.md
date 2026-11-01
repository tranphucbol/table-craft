# 145: The Database tree's order is stored; datasources.json v2 holds the folders

Status: Accepted.

## Decision

The Database tool window shows datasources and folders in an order the user arranges, by dragging
or with Move Up and Move Down, not sorted by name. `datasources.json` moves to version 2:
`{ version, folders, datasources }`. `folders` lists every folder path, empty ones too, each after
its parent and in the order its level shows them; the order of `datasources` is the order within
each folder. Folders stay above datasources in every level. Loading a version 1 file sorts each
level by name, so the tree looks the same on the first launch after the upgrade.

One pure function, `arrange(tree, { items, folder, before })` in
`packages/desktop/src/datasourceTree/arrange.ts`, is the only place a move is computed. Main runs it
for the `datasources.move` channel and writes once; the renderer runs the same function to preview
a drop target and to rename its selection and collapsed folders before main answers. Folders are
created and deleted in main (`datasources.create-folder`, `datasources.delete` with
`{ ids, folders }`), so an empty folder survives a restart.

## Rationale

DataGrip keeps a manual order, and users with many connections group them by importance, not by
name. Storing positions as an index on each datasource would leave folders without a home, and
empty folders were renderer state that vanished on restart. The array order is already the order
main keeps, so the file needs only the folder list.

An optional `folders` key without a version bump (as decision 068 did for `origin`) would leave a
version 1 file's order undefined: a build that ignores the key would show it A–Z while this one
showed the array order. A version bump makes the one-time A–Z migration explicit.

Running the same `arrange` in main and the renderer keeps the drop preview and the result identical;
the renderer never writes the list.

## Consequences

- An older build reads version 2 as unknown and sets `datasources.json` aside as corrupt, as it
  would any newer file. Downgrading after arranging the tree loses the list unless the file is
  restored from the `.corrupt-<epoch ms>` copy by hand.
- The ephemeral `TABLE_CRAFT_DATASOURCE` datasource is not in the file; it stays first and cannot
  move or be dropped above.
- A move that would put two folders of one name in one parent is refused, so a folder path stays
  unique.
- Multi-select exists only in the Database tree; Move to Folder… and Delete act on the whole
  selection, the other datasource actions on the lead row.
