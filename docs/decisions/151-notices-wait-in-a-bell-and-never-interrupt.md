# 151: Notices wait in a bell and never interrupt

Status: Proposed

## Decision

What TableCraft has to tell a user they did not ask for (a version it updated to, connections it
found in DataGrip, TablePro or MySQL Workbench, a plugin it updated in the background, a new
feature) is a notice in the notification bell, the third button of the right tool-window stripe
after Log and MCP Server Settings.

- Unread notices show as one 8 px `bg-accent` dot on the bell, with no count. The tooltip and
  `aria-label` say "Notifications, N new".
- An arriving notice plays the `tc-halo` wave three times on the dot (`halo-burst`, about 6 s) and
  stops. It is an `ambient` motion, so Reduced and Off show a still dot.
- Nothing opens on its own: no toast, no system notification, no popover. The user opens the bell.
- What the user has seen, read and dismissed is UI memory in the renderer's `localStorage` under
  `table-craft.notices.v1`, beside the layout. It adds no IPC channel and no `settings.json` field.
  A profile without that memory records what exists now as seen.

## Rationale

The app had a modal notice, which blocks work, inline banners, which belong to one pane, and
system notifications, which decision 143 keeps for an agent waiting while the window is in the
background. None fits "here is something you might want, when you have a moment". A toast would
interrupt typing in a console for news that can wait an hour; decision 127 already made the MCP
chip visible without interrupting, and the bell follows the same rule.

A count turns suggestions into a queue to empty, so the dot only says "something new". A halo that
looped would pull the eye every two seconds at the edge of the editor all day; a burst announces
the arrival and the steady dot carries "unread" after it.

The memory is about this window's view, like the layout, not a setting a user edits or syncs:
`localStorage` keeps it out of main (decision 002) and out of `settings.json`. Losing it costs one
launch with nothing to show, since a missing memory records everything as seen rather than
announcing a backlog.

## Consequences

- An update installed before the bell shipped shows no update notice: that launch finds no memory.
  The first one appears after the next update.
- Feature notices are a catalog in source, `renderer/notices/features.ts`, keyed by stable ids
  because the tree names no version. `RELEASING.md` adds an entry per user-visible feature and
  removes entries two releases old; an id that changes is announced again.
- The import scan runs once per launch after the data sources load. It reads files and asks for no
  keychain access, and a failure only means no import notice.
- A new kind of notice adds a rule to `renderer/model/notices.ts` and nothing to the shell. It
  must not open anything by itself; something urgent enough to interrupt belongs to the modal or,
  in the background, decision 143.
- Clearing the profile's web storage clears the memory; the next launch starts from seen.
